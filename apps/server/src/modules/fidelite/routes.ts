/**
 * Fidélité (§9) — routes caisse. Rattachement d'un client au paiement,
 * consultation du solde, utilisation de points en remise.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { TelephoneFideliteSchema } from '@pos/shared';
import { db } from '../../db/client.js';
import { clientsFidelite, commandes, notesSplit, paiements } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';
import { chargerCommandeVue, exigerModifiable, recalculerTotaux, verrouillerCommande } from '../commandes/service.js';
import { eligibilitePoints, lireBareme, pointsGagnes, soldePoints, trouverOuCreer, utiliserPoints } from './service.js';

const RattacherSchema = z.object({
  telephone: TelephoneFideliteSchema,
  utiliser_points: z.number().int().min(0).optional(),
});

const NomClientSchema = z.object({
  nom: z.string().trim().max(60, 'Nom trop long'),
});

export function routesFidelite(app: FastifyInstance): void {
  const gardeCaisse = app.exigePermission('caisse.encaisser');

  /**
   * Nom du client, saisi au paiement (facultatif). Il s'imprime sur le reçu et
   * sert au tirage au sort mensuel du siège. Une chaîne vide efface le nom.
   */
  app.patch('/api/clients-fidelite/:id', { preHandler: gardeCaisse }, async (req) => {
    const { id } = req.params as { id: string };
    const { nom } = valider(NomClientSchema, req.body);
    return db.transaction(async (tx) => {
      const [maj] = await tx
        .update(clientsFidelite)
        .set({ nom: nom || null })
        .where(eq(clientsFidelite.id, id))
        .returning();
      if (!maj) throw new ErreurMetier('Client introuvable', 404);
      await ecrireOutbox(tx, 'clients_fidelite', 'UPDATE', id, maj as unknown as Record<string, unknown>);
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'NOM_CLIENT',
        entite: 'clients_fidelite',
        entite_id: id,
        meta: { nom: maj.nom },
      });
      return { id: maj.id, telephone: maj.telephone, nom: maj.nom };
    });
  });

  // Consulter un solde par téléphone (pavé de saisie au paiement)
  app.get('/api/fidelite/:telephone', { preHandler: gardeCaisse }, async (req) => {
    const { telephone } = req.params as { telephone: string };
    const bareme = await lireBareme(db);
    const [cli] = await db.select().from(clientsFidelite).where(eq(clientsFidelite.telephone, telephone));
    if (!cli) return { existe: false, solde: 0, bareme };
    return { existe: true, client_id: cli.id, nom: cli.nom, solde: await soldePoints(db, cli.id), bareme };
  });

  /**
   * Recherche instantanée au paiement : « 0769 » liste tous les numéros qui
   * CONTIENNENT ces chiffres, où qu'ils soient. Les espaces saisis ou stockés
   * sont ignorés (« 07 69 » trouve « 0769… »). Deux sources : les clients
   * fidélité, puis les numéros laissés à la livraison qui ne sont pas encore
   * clients — les choisir crée le client au rattachement.
   */
  app.get('/api/clients/recherche', { preHandler: gardeCaisse }, async (req) => {
    const q = String((req.query as { q?: unknown }).q ?? '').trim();
    const chiffres = q.replace(/\D/g, '');
    const parNumero = chiffres.length >= 3;
    const parNom = /[a-zà-ÿ]/i.test(q) && q.length >= 2;
    if (!parNumero && !parNom) return { clients: [] };

    const motif = `%${parNumero ? chiffres : q}%`;
    const filtre = parNumero
      ? sql`regexp_replace(t.telephone, '\\D', '', 'g') LIKE ${motif}`
      : sql`t.nom ILIKE ${motif}`;
    const { rows } = await db.execute<{ client_id: string | null; telephone: string; nom: string | null; solde: string }>(sql`
      SELECT t.client_id, t.telephone, t.nom, t.solde FROM (
        SELECT c.id AS client_id, c.telephone, c.nom,
               COALESCE((SELECT SUM(p.points) FROM points_fidelite p WHERE p.client_id = c.id), 0) AS solde,
               0 AS rang, NULL::timestamptz AS vu_le
          FROM clients_fidelite c
         WHERE c.telephone IS NOT NULL
        UNION ALL
        SELECT NULL, k.contact_client, NULL, 0, 1, MAX(k.created_at)
          FROM commandes k
         WHERE k.contact_client ~ '^[+0-9][0-9 ]{5,19}$'
           AND NOT EXISTS (
             SELECT 1 FROM clients_fidelite c
              WHERE regexp_replace(c.telephone, '\\D', '', 'g') = regexp_replace(k.contact_client, '\\D', '', 'g')
           )
         GROUP BY k.contact_client
      ) t
      WHERE ${filtre}
      ORDER BY t.rang, t.vu_le DESC NULLS LAST, t.telephone
      LIMIT 20
    `);
    return {
      clients: rows.map((r) => ({ client_id: r.client_id, telephone: r.telephone, nom: r.nom, solde: Number(r.solde) })),
    };
  });

  /**
   * Le client du ticket (ou de la note encaissée), tel que le caissier doit le
   * voir avant d'encaisser : son solde, ce qu'il gagnera avec ce paiement, et
   * s'il peut tout régler avec ses points. Calculé ICI — la caisse n'invente
   * aucun chiffre de points.
   */
  app.get('/api/commandes/:id/client', { preHandler: gardeCaisse }, async (req) => {
    const { id } = req.params as { id: string };
    const noteId = (req.query as { note_id?: string }).note_id ?? null;
    const [c] = await db.select().from(commandes).where(eq(commandes.id, id));
    if (!c) throw new ErreurMetier('Commande introuvable', 404);
    const lignes = await db.select().from(paiements).where(eq(paiements.commande_id, id));
    let clientId = c.client_fidelite_id;
    let montantCible = c.total;
    let paye = lignes.reduce((s, p) => s + p.montant, 0);
    let pointsDejaPayes = lignes.filter((p) => p.mode === 'POINTS').reduce((s, p) => s + p.montant, 0);
    if (noteId) {
      const [note] = await db.select().from(notesSplit).where(and(eq(notesSplit.id, noteId), eq(notesSplit.commande_id, id)));
      if (!note) throw new ErreurMetier('Paiement par articles introuvable', 404);
      const ceuxDeLaNote = lignes.filter((p) => p.note_id === noteId);
      clientId = note.client_fidelite_id;
      montantCible = note.montant;
      paye = ceuxDeLaNote.reduce((s, p) => s + p.montant, 0);
      pointsDejaPayes = ceuxDeLaNote.filter((p) => p.mode === 'POINTS').reduce((s, p) => s + p.montant, 0);
    }
    if (!clientId) return { client: null };

    const [client] = await db.select().from(clientsFidelite).where(eq(clientsFidelite.id, clientId));
    const bareme = await lireBareme(db);
    const solde = await soldePoints(db, clientId);
    const reste = Math.max(0, montantCible - paye);
    const eligibilite = await eligibilitePoints(db, clientId, reste, paye);
    // Gagnés sur ce qui est payé en argent : le reste réglé normalement.
    const gagnes = pointsGagnes(bareme, montantCible - pointsDejaPayes);
    return {
      client: { id: clientId, telephone: client?.telephone ?? null, nom: client?.nom ?? null },
      solde,
      reste,
      points_gagnes: gagnes,
      solde_apres: solde + gagnes,
      paiement_points: {
        ...eligibilite,
        // Tout en points : rien n'est payé en argent, rien n'est gagné.
        solde_apres: solde - eligibilite.points_necessaires,
      },
    };
  });

  /**
   * Rattacher un client à une commande et, optionnellement, utiliser des points
   * comme remise FIDELITE (droit du client — pas de PIN manager). L'utilisation
   * écrit une ligne négative + audit UTILISATION_POINTS, dans la transaction.
   */
  app.post('/api/commandes/:id/fidelite', { preHandler: gardeCaisse }, async (req) => {
    const { id } = req.params as { id: string };
    const corps = valider(RattacherSchema, req.body);

    const vue = await db.transaction(async (tx) => {
      const c = await verrouillerCommande(tx, id);
      exigerModifiable(c);
      const client = await trouverOuCreer(tx, corps.telephone);
      const notes = await tx
        .select()
        .from(notesSplit)
        .where(and(eq(notesSplit.commande_id, id), ne(notesSplit.statut, 'ANNULEE')));

      // Les points changent le total : une fois un versement enregistré (ou un
      // partage posé), le total est réparti entre des notes qu'on ne recalcule
      // pas. La personne utilise alors ses points via « Payer par articles ».
      if (corps.utiliser_points && corps.utiliser_points > 0) {
        const [dejaPaye] = await tx.select({ id: paiements.id }).from(paiements).where(eq(paiements.commande_id, id)).limit(1);
        if (dejaPaye || notes.length > 0) {
          throw new ErreurMetier('Les points s’utilisent avant le premier encaissement', 409);
        }
      }

      // Client saisi APRÈS un premier versement (5 000 en espèces, puis le
      // numéro, puis le reste en Wave) : le serveur a déjà ouvert la note
      // implicite couvrant tout le ticket, et c'est elle qui crédite les points
      // quand elle est soldée. Sans ce report, le client ne gagnerait rien.
      // Un vrai partage (plusieurs notes) garde ses clients par personne.
      const seule = notes.length === 1 ? notes[0]! : null;
      if (seule && seule.type === 'ARTICLES' && seule.montant === c.total && !seule.client_fidelite_id) {
        const [noteMaj] = await tx
          .update(notesSplit)
          .set({ client_fidelite_id: client.id })
          .where(and(eq(notesSplit.id, seule.id), inArray(notesSplit.statut, ['A_PAYER', 'PARTIELLEMENT_PAYEE'])))
          .returning();
        if (noteMaj) {
          await ecrireOutbox(tx, 'notes_split', 'UPDATE', noteMaj.id, noteMaj as unknown as Record<string, unknown>);
        }
      }

      const [maj] = await tx
        .update(commandes)
        .set({ client_fidelite_id: client.id, updated_at: new Date() })
        .where(eq(commandes.id, id))
        .returning();
      await ecrireOutbox(tx, 'commandes', 'UPDATE', id, maj as unknown as Record<string, unknown>);

      if (corps.utiliser_points && corps.utiliser_points > 0) {
        const { montant, points } = await utiliserPoints(tx, client.id, id, corps.utiliser_points);
        await tx
          .update(commandes)
          .set({ fidelite_points: points, fidelite_montant: montant })
          .where(eq(commandes.id, id));
        await journaliser(tx, {
          user_id: req.session!.utilisateur_id,
          action: 'UTILISATION_POINTS',
          entite: 'commandes',
          entite_id: id,
          montant,
          meta: { client_id: client.id, points },
        });
        await recalculerTotaux(tx, id);
      }

      return {
        commande: await chargerCommandeVue(tx, id),
        solde: await soldePoints(tx, client.id),
      };
    });

    app.diffuser('commande', id);
    return vue;
  });
}
