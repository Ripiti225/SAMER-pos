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
import { and, desc, eq, notInArray } from 'drizzle-orm';
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
  restaurant,
  tablesSalle,
  zones,
} from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier, introuvable } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { chargerCatalogue } from '../catalogue/service.js';
import { figerNouvelItem, recalculerTotaux } from '../commandes/service.js';
import { calculerDestinataire } from '../routage/routage.js';
import { etatDUneTable } from '../tables/etat.js';

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
        marque: (resto?.marque ?? 'SAMER') as 'SAMER' | 'AL_KAYAN',
        couleur_hex: resto?.couleur_hex ?? '#EF9F27',
      },
      etat: await etatDUneTable(table.id, table.statut),
    };
  });

  app.get('/api/client/:qr_token/catalogue', async (req): Promise<CatalogueVue> => {
    const { qr_token } = req.params as { qr_token: string };
    await tableParJeton(qr_token); // borne au jeton (404 si inconnu)
    return chargerCatalogue();
  });

  // Suivi : UNIQUEMENT les commandes de SA table (portée du jeton — testé)
  app.get('/api/client/:qr_token/commandes', async (req): Promise<SuiviCommandeClient[]> => {
    const { qr_token } = req.params as { qr_token: string };
    const table = await tableParJeton(qr_token);
    const lignes = await db
      .select()
      .from(commandes)
      .where(and(eq(commandes.table_id, table.id), notInArray(commandes.statut, ['PAYEE'])))
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

    return lignes.map((c) => ({
      id: c.id,
      numero_ticket: Number(c.numero_ticket),
      etat: etatSuivi(c.statut, c.origine),
      origine: c.origine as SuiviCommandeClient['origine'],
      refus_motif: c.refus_motif,
      total: c.total,
      articles: parCommande.get(c.id) ?? [],
    }));
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

    const { commandeId, destinataire } = await db.transaction(async (tx) => {
      await tx.select().from(tablesSalle).where(eq(tablesSalle.id, table.id)).for('update');
      const [commande] = await tx
        .insert(commandes)
        .values({ type: 'SUR_PLACE', table_id: table.id, origine: 'CLIENT_QR' })
        .returning();
      await ecrireOutbox(tx, 'commandes', 'INSERT', commande!.id, commande as unknown as Record<string, unknown>);
      for (const item of corps.items) {
        await figerNouvelItem(tx, commande!, item, false); // NON envoyé en cuisine
      }
      await recalculerTotaux(tx, commande!.id);
      const dest = await calculerDestinataire(tx, app.presence, table.id);
      return { commandeId: commande!.id, destinataire: dest };
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

    return { ok: true, commande_id: commandeId, confirmation: 'Commande envoyée à votre serveur' };
  });
}
