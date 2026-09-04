/**
 * Mini-app client (CORRECTIONS3 point 1) — page téléphone /t/:qr_token.
 *
 * Le client interagit avec SON serveur (routage point 1b) ; la caisse est le
 * repli ; la cuisine n'est JAMAIS contactée : une commande client est une
 * PROPOSITION (origine CLIENT_QR, non envoyée en cuisine) qui devra être
 * validée par un serveur ou, en repli, par la caisse.
 *
 * Sécurité : toutes ces routes sont ouvertes (pas de session), mais bornées à
 * la table du qr_token — un jeton ne voit et ne touche QUE sa propre table.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gt, gte, inArray, or, sql } from 'drizzle-orm';
import {
  AppelClientSchema,
  CommandeClientSchema,
  type CatalogueVue,
  type EtatSuiviClient,
  type SuiviCommandeClient,
  type TableClientVue,
} from '@pos/shared';
import { db } from '../../db/client.js';
import {
  appelsTable,
  commandeItems,
  commandes,
  parametresLocaux,
  pointsFidelite,
  restaurant,
  tablesSalle,
  zones,
} from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier, introuvable } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { chargerCatalogueClient } from '../catalogue/service.js';
import {
  chargerCommandeVue,
  figerNouvelItem,
  genererCodeCommande,
  recalculerTotaux,
} from '../commandes/service.js';
import { lireBareme, pointsGagnes, soldePoints, trouverOuCreer } from '../fidelite/service.js';
import { calculerDestinataire } from '../routage/routage.js';
import { etatDUneTable } from '../tables/etat.js';
import { construireRecuPdf, construireRecuSousNotePdf } from '../../printer/recu-pdf.js';

/**
 * Durée pendant laquelle une commande payée reste accessible au téléphone qui
 * l'a passée (écran « Vous venez de payer… » + reçu PDF). Assez long pour un
 * client qui range son téléphone avant de le ressortir, assez court pour que la
 * table suivante ne récupère rien.
 */
const FENETRE_RECU_MS = 45 * 60 * 1000;

/** Limiteur de débit simple par (jeton, action) — anti-abus (§1a). */
const dernierAppel = new Map<string, number>();
const DELAI_MIN_MS = 8000;
function tropTot(cle: string): boolean {
  const maintenant = Date.now();
  const precedent = dernierAppel.get(cle) ?? 0;
  if (maintenant - precedent < DELAI_MIN_MS) return true;
  dernierAppel.set(cle, maintenant);
  return false;
}

async function tableParJeton(qrToken: string) {
  const [table] = await db.select().from(tablesSalle).where(eq(tablesSalle.qr_token, qrToken));
  if (!table) throw introuvable('Table');
  return table;
}

function etatSuivi(statut: string, origine: string): EtatSuiviClient {
  if (statut === 'PAYEE') return 'PAYEE';
  if (statut === 'ANNULEE') return 'REFUSEE';
  if (statut === 'SERVIE') return 'SERVIE';
  if (statut === 'PRETE') return 'PRETE';
  if (statut === 'ENVOYEE_CUISINE') return 'EN_PREPARATION';
  // OUVERTE : une proposition client est « en validation », le reste « en préparation »
  return origine === 'CLIENT_QR' ? 'EN_VALIDATION' : 'EN_PREPARATION';
}

export function routesClient(app: FastifyInstance): void {
  // Vue de SA table (numéro, zone, marque) + état dérivé
  app.get('/api/client/:qr_token', async (req): Promise<TableClientVue> => {
    const { qr_token } = req.params as { qr_token: string };
    const table = await tableParJeton(qr_token);
    const [zone] = await db.select().from(zones).where(eq(zones.id, table.zone_id));
    const [resto] = await db.select().from(restaurant).limit(1);
    return {
      table_id: table.id,
      numero: table.numero,
      zone_nom: zone?.nom ?? '',
      restaurant: {
        nom: resto?.nom ?? '',
        marque: (resto?.marque ?? 'SAMER') as 'SAMER' | 'AL_KAYAN' | 'A_LA_BRAISE',
        couleur_hex: resto?.couleur_hex ?? '#EF9F27',
      },
      etat: await etatDUneTable(table.id, table.statut),
    };
  });

  app.get('/api/client/:qr_token/catalogue', async (req): Promise<CatalogueVue> => {
    const { qr_token } = req.params as { qr_token: string };
    await tableParJeton(qr_token); // borne au jeton (404 si inconnu)
    // Variante CLIENT : sans les catégories réservées aux partenaires de
    // livraison (migration 0023). Un client au QR est sur place.
    return chargerCatalogueClient();
  });

  // Suivi : UNIQUEMENT les commandes de SA table (portée du jeton — testé)
  app.get('/api/client/:qr_token/commandes', async (req): Promise<SuiviCommandeClient[]> => {
    const { qr_token } = req.params as { qr_token: string };
    const table = await tableParJeton(qr_token);
    // Les commandes payées restent visibles le temps de la FENETRE_RECU : c'est
    // ce qui permet à l'écran d'annoncer « Vous venez de payer… » et de servir
    // le reçu. Au-delà, elles disparaissent — la table sera à quelqu'un d'autre.
    const lignes = await db
      .select()
      .from(commandes)
      .where(
        and(
          eq(commandes.table_id, table.id),
          or(
            sql`${commandes.statut} <> 'PAYEE'`,
            gte(commandes.updated_at, new Date(Date.now() - FENETRE_RECU_MS)),
          ),
        ),
      )
      .orderBy(desc(commandes.created_at));
    if (lignes.length === 0) return [];

    const items = await db
      .select({
        commande_id: commandeItems.commande_id,
        nom: commandeItems.nom_snapshot,
        quantite: commandeItems.quantite,
        statut_cuisine: commandeItems.statut_cuisine,
      })
      .from(commandeItems)
      .innerJoin(commandes, eq(commandes.id, commandeItems.commande_id))
      .where(eq(commandes.table_id, table.id));

    const parCommande = new Map<string, { nom: string; quantite: number }[]>();
    for (const it of items) {
      if (it.statut_cuisine === 'ANNULE') continue;
      const arr = parCommande.get(it.commande_id) ?? [];
      arr.push({ nom: it.nom, quantite: it.quantite });
      parCommande.set(it.commande_id, arr);
    }

    // Points réellement crédités, par commande (une seule requête).
    const credits = await db
      .select({ commande_id: pointsFidelite.commande_id, points: pointsFidelite.points })
      .from(pointsFidelite)
      .where(
        and(
          inArray(pointsFidelite.commande_id, lignes.map((c) => c.id)),
          gt(pointsFidelite.points, 0),
        ),
      );
    const creditParCommande = new Map(credits.map((c) => [c.commande_id, c.points]));
    const bareme = await lireBareme(db);

    return lignes.map((c) => ({
      id: c.id,
      numero_ticket: Number(c.numero_ticket),
      etat: etatSuivi(c.statut, c.origine),
      origine: c.origine as SuiviCommandeClient['origine'],
      refus_motif: c.refus_motif,
      total: c.total,
      articles: parCommande.get(c.id) ?? [],
      fidelite: {
        rattache: c.client_fidelite_id !== null,
        // Payée : ce qui a été crédité. Pas encore payée (ou pas de numéro) :
        // ce que la vente rapporte au barème — c'est le manque à montrer.
        points: creditParCommande.get(c.id) ?? pointsGagnes(bareme, c.total),
      },
    }));
  });

  /**
   * Reçu PDF de SA commande payée. Route ouverte, donc verrouillée par trois
   * conditions cumulatives : la commande appartient à la table du jeton, elle
   * est PAYEE, et le paiement date de moins de FENETRE_RECU_MS. Sans la fenêtre,
   * le client suivant assis à la même table pourrait rejouer d'anciens reçus.
   */
  app.get('/api/client/:qr_token/recu/:commande_id', async (req, rep) => {
    const { qr_token, commande_id } = req.params as { qr_token: string; commande_id: string };
    const table = await tableParJeton(qr_token);

    const [c] = await db.select().from(commandes).where(eq(commandes.id, commande_id));
    // Une commande d'une AUTRE table est traitée comme inexistante : le jeton ne
    // doit rien apprendre du reste de la salle.
    if (!c || c.table_id !== table.id) throw introuvable('Commande');
    if (c.statut !== 'PAYEE') throw new ErreurMetier('Cette commande n’est pas encore payée', 409);
    if (Date.now() - new Date(c.updated_at).getTime() > FENETRE_RECU_MS) {
      throw new ErreurMetier('Ce reçu n’est plus disponible, demandez-le à votre serveur', 410);
    }

    const vue = await chargerCommandeVue(db, commande_id);
    const params = await db.select().from(parametresLocaux);
    const texte = (cle: string): string => {
      const p = params.find((x) => x.cle === cle);
      return typeof p?.valeur === 'string' ? p.valeur : '';
    };
    const [resto] = await db.select().from(restaurant).limit(1);

    const [credit] = await db
      .select({ points: pointsFidelite.points })
      .from(pointsFidelite)
      .where(and(eq(pointsFidelite.commande_id, commande_id), gt(pointsFidelite.points, 0)));
    const bareme = await lireBareme(db);
    const pdf = await construireRecuPdf(
      vue,
      {
        nom: resto?.nom ?? '',
        entete: texte('ticket_entete'),
        pied: texte('ticket_pied'),
        couleur_hex: resto?.couleur_hex ?? '#EF9F27',
      },
      {
        points: credit?.points ?? pointsGagnes(bareme, vue.total),
        rattache: c.client_fidelite_id !== null,
        solde: c.client_fidelite_id ? await soldePoints(db, c.client_fidelite_id) : null,
      },
    );

    return rep
      .type('application/pdf')
      .header('Content-Disposition', `attachment; filename="recu-${c.numero_ticket}.pdf"`)
      .header('Cache-Control', 'no-store')
      .send(pdf);
  });

  app.get('/api/client/:qr_token/recu/:commande_id/:note_id', async (req, rep) => {
    const { qr_token, commande_id, note_id } = req.params as { qr_token: string; commande_id: string; note_id: string };
    const table = await tableParJeton(qr_token);
    const [c] = await db.select().from(commandes).where(eq(commandes.id, commande_id));
    if (!c || c.table_id !== table.id) throw introuvable('Commande');
    const vue = await chargerCommandeVue(db, commande_id);
    const note = vue.notes.find((candidate) => candidate.id === note_id);
    if (!note || note.statut !== 'PAYEE' || !note.payee_le) throw new ErreurMetier('Ce paiement n’est pas encore soldé', 409);
    if (Date.now() - new Date(note.payee_le).getTime() > FENETRE_RECU_MS) {
      throw new ErreurMetier('Ce reçu n’est plus disponible, demandez-le à votre serveur', 410);
    }
    const params = await db.select().from(parametresLocaux);
    const texte = (cle: string): string => {
      const p = params.find((x) => x.cle === cle);
      return typeof p?.valeur === 'string' ? p.valeur : '';
    };
    const [resto] = await db.select().from(restaurant).limit(1);
    const [credit] = await db
      .select({ points: pointsFidelite.points })
      .from(pointsFidelite)
      .where(and(eq(pointsFidelite.note_id, note_id), gt(pointsFidelite.points, 0)));
    const bareme = await lireBareme(db);
    const pdf = await construireRecuSousNotePdf(
      vue,
      note,
      {
        nom: resto?.nom ?? '',
        entete: texte('ticket_entete'),
        pied: texte('ticket_pied'),
        couleur_hex: resto?.couleur_hex ?? '#EF9F27',
      },
      {
        points: credit?.points ?? pointsGagnes(bareme, note.montant),
        rattache: note.client_fidelite_id !== null,
        solde: note.client_fidelite_id ? await soldePoints(db, note.client_fidelite_id) : null,
      },
    );
    return rep
      .type('application/pdf')
      .header('Content-Disposition', `attachment; filename="recu-${c.numero_ticket}-paiement-${note.numero}.pdf"`)
      .header('Cache-Control', 'no-store')
      .send(pdf);
  });

  // « Appeler le serveur » / « Demander la facture »
  app.post('/api/client/:qr_token/appel', async (req) => {
    const { qr_token } = req.params as { qr_token: string };
    const corps = valider(AppelClientSchema, req.body);
    const table = await tableParJeton(qr_token);

    if (tropTot(`${qr_token}:${corps.type}`)) {
      throw new ErreurMetier('Appel déjà envoyé, patientez quelques secondes', 429);
    }

    const { appel, deja, destinataire } = await db.transaction(async (tx) => {
      await tx.select().from(tablesSalle).where(eq(tablesSalle.id, table.id)).for('update');
      // Anti-doublon : un seul appel EN_ATTENTE par (table, type)
      const [existant] = await tx
        .select()
        .from(appelsTable)
        .where(
          and(
            eq(appelsTable.table_id, table.id),
            eq(appelsTable.type, corps.type),
            eq(appelsTable.statut, 'EN_ATTENTE'),
          ),
        );
      const dest = await calculerDestinataire(tx, app.presence, table.id);
      if (existant) return { appel: existant, deja: true as const, destinataire: dest };
      const [cree] = await tx
        .insert(appelsTable)
        .values({ table_id: table.id, type: corps.type })
        .returning();
      return { appel: cree!, deja: false as const, destinataire: dest };
    });

    // Routage (point 1b) : notifie le serveur cible, ou la caisse en repli.
    if (!deja) {
      app.diffuserPayload('appel:nouveau', {
        appel_id: appel.id,
        table_id: table.id,
        table_numero: table.numero,
        type_appel: corps.type,
        cible: destinataire.cible,
        serveur_id: destinataire.serveur_id,
      });
      app.diffuser('table:changee', table.id);
    }

    const confirmation =
      corps.type === 'APPEL_SERVEUR' ? 'Votre serveur arrive' : 'Votre facture arrive';
    return { ok: true, confirmation, cible: destinataire.cible };
  });

  // Proposition de commande client (JAMAIS envoyée en cuisine sans validation)
  app.post('/api/client/:qr_token/commande', async (req) => {
    const { qr_token } = req.params as { qr_token: string };
    const corps = valider(CommandeClientSchema, req.body);
    const table = await tableParJeton(qr_token);
    if (table.partenaire) throw new ErreurMetier('Cette table ne prend pas de commande', 400);

    const { commandeId, destinataire, rattache } = await db.transaction(async (tx) => {
      await tx.select().from(tablesSalle).where(eq(tablesSalle.id, table.id)).for('update');
      const code = await genererCodeCommande(tx, 'SUR_PLACE', null);
      // Téléphone facultatif : donné, il crée (ou retrouve) le client fidélité
      // et le rattache DANS la même transaction que la commande. Absent, la
      // commande part quand même — le client a juste renoncé à ses points.
      const client = corps.telephone ? await trouverOuCreer(tx, corps.telephone) : null;
      const [commande] = await tx
        .insert(commandes)
        .values({
          type: 'SUR_PLACE',
          code_commande: code,
          table_id: table.id,
          origine: 'CLIENT_QR',
          client_fidelite_id: client?.id ?? null,
        })
        .returning();
      await ecrireOutbox(tx, 'commandes', 'INSERT', commande!.id, commande as unknown as Record<string, unknown>);
      for (const item of corps.items) {
        await figerNouvelItem(tx, commande!, item, false); // NON envoyé en cuisine
      }
      await recalculerTotaux(tx, commande!.id);
      const dest = await calculerDestinataire(tx, app.presence, table.id);
      return { commandeId: commande!.id, destinataire: dest, rattache: client !== null };
    });

    // Routage : la proposition va au serveur cible (ou caisse en repli),
    // JAMAIS à la cuisine tant qu'elle n'est pas validée.
    app.diffuserPayload('commande:client_a_valider', {
      commande_id: commandeId,
      table_id: table.id,
      table_numero: table.numero,
      cible: destinataire.cible,
      serveur_id: destinataire.serveur_id,
    });
    app.diffuser('table:changee', table.id);

    return {
      ok: true,
      commande_id: commandeId,
      confirmation: 'Commande envoyée à votre serveur',
      fidelite: { rattache },
    };
  });
}
