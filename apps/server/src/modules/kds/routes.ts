/**
 * KDS — écran cuisine (sprint 2 §A, corrigé par les retours terrain) :
 * - AUCUN PIN (correction 3) : l'appareil s'identifie par un jeton configuré
 *   une seule fois à l'installation (parametres_locaux « kds_jeton_appareil »),
 *   envoyé dans l'en-tête « x-jeton-kds ». Pas de session humaine.
 * - Le KDS est un écran de production : ces routes n'exposent AUCUNE donnée
 *   sensible (pas de prix, pas de CA, pas de personnel) et le jeton ne donne
 *   accès à rien d'autre — toutes les autres routes exigent une session.
 * Cycle par carte entière : « Commencer » (EN_COURS) → « Prêt » (PRET) →
 * « Reprendre » en cas d'erreur. Un article annulé après envoi reste barré.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { CarteKds, KdsVue } from '@pos/shared';
import { db } from '../../db/client.js';
import {
  commandeItems,
  commandes,
  parametresLocaux,
  restaurant,
  tablesSalle,
} from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier } from '../../lib/erreurs.js';
import { verrouillerCommande } from '../commandes/service.js';
import { attribuerPlats } from './attribution.js';

/** Garde d'appareil KDS : jeton d'installation, pas d'identité humaine. */
async function exigerJetonKds(req: FastifyRequest): Promise<void> {
  const jeton = req.headers['x-jeton-kds'];
  const [param] = await db
    .select()
    .from(parametresLocaux)
    .where(eq(parametresLocaux.cle, 'kds_jeton_appareil'));
  const attendu = typeof param?.valeur === 'string' ? param.valeur : null;
  if (!attendu || typeof jeton !== 'string' || jeton !== attendu) {
    throw new ErreurMetier('Écran cuisine non autorisé — saisissez le jeton d’appareil', 403);
  }
}

type LigneCommande = typeof commandes.$inferSelect & { table_numero: string | null };

async function construireCartes(lignes: LigneCommande[]): Promise<CarteKds[]> {
  if (lignes.length === 0) return [];
  const items = await db
    .select()
    .from(commandeItems)
    .where(
      and(
        inArray(commandeItems.commande_id, lignes.map((c) => c.id)),
        isNotNull(commandeItems.envoye_le),
      ),
    );

  return lignes
    .map((c) => {
      const siens = items.filter((i) => i.commande_id === c.id);
      const premierEnvoi = siens.reduce<Date | null>(
        (min, i) => (i.envoye_le && (!min || i.envoye_le < min) ? i.envoye_le : min),
        null,
      );
      return {
        id: c.id,
        numero_ticket: Number(c.numero_ticket),
        type: c.type,
        partenaire: c.partenaire,
        table_numero: c.table_numero,
        statut: c.statut,
        envoyee_le: (premierEnvoi ?? c.updated_at).toISOString(),
        heure_commande: c.created_at.toISOString(),
        items: siens.map((i) => ({
          id: i.id,
          nom_snapshot: i.nom_snapshot,
          quantite: i.quantite,
          options: (i.options as { groupe: string; choix: string[] }[]) ?? [],
          // Pas de prix sur le KDS : écran de production, aucune donnée de caisse
          supplements: ((i.supplements as { nom: string }[]) ?? []).map((s) => ({ nom: s.nom })),
          statut_cuisine: i.statut_cuisine as CarteKds['items'][number]['statut_cuisine'],
        })),
      };
    })
    .filter((carte) => carte.items.length > 0);
}

export function routesKds(app: FastifyInstance): void {
  const gardeKds = exigerJetonKds;

  // Grille (plus ancienne → plus récente) + colonne « Prêtes » (10 dernières)
  app.get('/api/kds/commandes', { preHandler: gardeKds }, async (): Promise<KdsVue> => {
    const [enCuisine, pretes, params, restos] = await Promise.all([
      db
        .select(commandesAvecTable())
        .from(commandes)
        .leftJoin(tablesSalle, eq(tablesSalle.id, commandes.table_id))
        .where(eq(commandes.statut, 'ENVOYEE_CUISINE'))
        .orderBy(asc(commandes.updated_at)),
      db
        .select(commandesAvecTable())
        .from(commandes)
        .leftJoin(tablesSalle, eq(tablesSalle.id, commandes.table_id))
        .where(eq(commandes.statut, 'PRETE'))
        .orderBy(desc(commandes.updated_at))
        .limit(10),
      db.select().from(parametresLocaux),
      db.select().from(restaurant).limit(1),
    ]);

    const lireParam = (cle: string, defaut: number): number => {
      const p = params.find((x) => x.cle === cle);
      return typeof p?.valeur === 'number' ? p.valeur : defaut;
    };

    return {
      // Marque pour le thème (le KDS n'a pas de session /api/auth/moi)
      marque: (restos[0]?.marque ?? 'SAMER') as KdsVue['marque'],
      couleur_hex: restos[0]?.couleur_hex ?? '#EF9F27',
      seuils: {
        orange_minutes: lireParam('kds_seuil_orange_minutes', 10),
        rouge_minutes: lireParam('kds_seuil_rouge_minutes', 20),
      },
      en_cuisine: await construireCartes(enCuisine as unknown as LigneCommande[]),
      pretes: await construireCartes(pretes as unknown as LigneCommande[]),
    };
  });

  // « Commencer » : toute la carte passe EN_COURS
  app.post('/api/kds/commandes/:id/commencer', { preHandler: gardeKds }, async (req) => {
    const { id } = req.params as { id: string };
    await db.transaction(async (tx) => {
      const c = await verrouillerCommande(tx, id);
      if (c.statut !== 'ENVOYEE_CUISINE') {
        throw new ErreurMetier('Cette commande n’est pas en attente en cuisine', 409);
      }
      const items = await tx
        .select()
        .from(commandeItems)
        .where(
          and(
            eq(commandeItems.commande_id, id),
            isNotNull(commandeItems.envoye_le),
            eq(commandeItems.statut_cuisine, 'A_PREPARER'),
          ),
        );
      for (const item of items) {
        const [maj] = await tx
          .update(commandeItems)
          .set({ statut_cuisine: 'EN_COURS' })
          .where(eq(commandeItems.id, item.id))
          .returning();
        await ecrireOutbox(tx, 'commande_items', 'UPDATE', item.id, maj as unknown as Record<string, unknown>);
      }
    });
    app.diffuser('commande:modifiee', id);
    return { ok: true };
  });

  // « Prêt » : la carte quitte la grille → colonne « Prêtes »
  app.post('/api/kds/commandes/:id/pret', { preHandler: gardeKds }, async (req) => {
    const { id } = req.params as { id: string };
    await db.transaction(async (tx) => {
      const c = await verrouillerCommande(tx, id);
      if (c.statut !== 'ENVOYEE_CUISINE') {
        throw new ErreurMetier('Cette commande n’est pas en cuisine', 409);
      }
      const items = await tx
        .select()
        .from(commandeItems)
        .where(and(eq(commandeItems.commande_id, id), isNotNull(commandeItems.envoye_le)));
      for (const item of items) {
        if (item.statut_cuisine === 'ANNULE' || item.statut_cuisine === 'PRET') continue;
        const [maj] = await tx
          .update(commandeItems)
          .set({ statut_cuisine: 'PRET' })
          .where(eq(commandeItems.id, item.id))
          .returning();
        await ecrireOutbox(tx, 'commande_items', 'UPDATE', item.id, maj as unknown as Record<string, unknown>);
      }
      const [maj] = await tx
        .update(commandes)
        .set({ statut: 'PRETE', updated_at: new Date() })
        .where(eq(commandes.id, id))
        .returning();
      await ecrireOutbox(tx, 'commandes', 'UPDATE', id, maj as unknown as Record<string, unknown>);

      // Correction 4 : attribution automatique des plats aux employés en
      // poste, par mapping catégorie → poste_cuisine. Invisible pour le KDS.
      await attribuerPlats(tx, id);
    });

    // CORRECTIONS3 point 2 : sonner le serveur rattaché (serveur_id) ; s'il est
    // déconnecté (ou commande prise à la caisse), notifier la caisse.
    const [c] = await db
      .select({
        serveur_id: commandes.serveur_id,
        table_id: commandes.table_id,
        table_numero: tablesSalle.numero,
      })
      .from(commandes)
      .leftJoin(tablesSalle, eq(tablesSalle.id, commandes.table_id))
      .where(eq(commandes.id, id));
    const versServeur = !!c?.serveur_id && app.presence.estPresent(c.serveur_id);
    app.diffuserPayload('commande:prete', {
      commande_id: id,
      table_id: c?.table_id ?? null,
      table_numero: c?.table_numero ?? null,
      serveur_id: c?.serveur_id ?? null,
      cible: versServeur ? 'SERVEUR' : 'CAISSE',
    });
    app.diffuser('commande:modifiee', id);
    if (c?.table_id) app.diffuser('table:changee', c.table_id);
    return { ok: true };
  });

  // « Reprendre » : rappel d'une carte marquée Prête par erreur
  app.post('/api/kds/commandes/:id/reprendre', { preHandler: gardeKds }, async (req) => {
    const { id } = req.params as { id: string };
    await db.transaction(async (tx) => {
      const c = await verrouillerCommande(tx, id);
      if (c.statut !== 'PRETE') throw new ErreurMetier('Cette commande n’est pas marquée prête', 409);
      const items = await tx
        .select()
        .from(commandeItems)
        .where(and(eq(commandeItems.commande_id, id), eq(commandeItems.statut_cuisine, 'PRET')));
      for (const item of items) {
        const [maj] = await tx
          .update(commandeItems)
          .set({ statut_cuisine: 'EN_COURS' })
          .where(eq(commandeItems.id, item.id))
          .returning();
        await ecrireOutbox(tx, 'commande_items', 'UPDATE', item.id, maj as unknown as Record<string, unknown>);
      }
      const [maj] = await tx
        .update(commandes)
        .set({ statut: 'ENVOYEE_CUISINE', updated_at: new Date() })
        .where(eq(commandes.id, id))
        .returning();
      await ecrireOutbox(tx, 'commandes', 'UPDATE', id, maj as unknown as Record<string, unknown>);
    });
    app.diffuser('commande:modifiee', id);
    return { ok: true };
  });
}

function commandesAvecTable() {
  return {
    id: commandes.id,
    numero_ticket: commandes.numero_ticket,
    type: commandes.type,
    table_id: commandes.table_id,
    partenaire: commandes.partenaire,
    ref_partenaire: commandes.ref_partenaire,
    service_id: commandes.service_id,
    caissier_id: commandes.caissier_id,
    serveur_id: commandes.serveur_id,
    statut: commandes.statut,
    sous_total: commandes.sous_total,
    remise_montant: commandes.remise_montant,
    remise_par: commandes.remise_par,
    remise_motif: commandes.remise_motif,
    promo_id: commandes.promo_id,
    promo_montant: commandes.promo_montant,
    total: commandes.total,
    created_at: commandes.created_at,
    updated_at: commandes.updated_at,
    table_numero: tablesSalle.numero,
  };
}
