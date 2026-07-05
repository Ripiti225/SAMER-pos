/**
 * Actions de salle partagées serveur + caisse (CORRECTIONS3).
 * - Réception et traitement des appels client (point 1b).
 * - Validation / refus d'une commande client (point 1 : la validation seule
 *   envoie en cuisine ; la cuisine n'est jamais contactée directement).
 * - « Servie » (point 2).
 *
 * Le repli caisse est assuré côté client par le routage : ces routes sont
 * ouvertes aux rôles SERVEUR et CAISSE (+ MANAGER/PROPRIETAIRE).
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, notInArray } from 'drizzle-orm';
import type { AppelVue } from '@pos/shared';
import { RefusCommandeSchema } from '@pos/shared';
import { db } from '../../db/client.js';
import { appelsTable, commandes, tablesSalle, zones } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier, introuvable } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';
import {
  chargerCommandeVue,
  majStatutTable,
  marquerEnvoiCuisine,
  verrouillerCommande,
} from '../commandes/service.js';
import { calculerDestinataire } from '../routage/routage.js';

const ROLES_SALLE = ['SERVEUR', 'CAISSIER', 'MANAGER', 'PROPRIETAIRE'] as const;

export function routesSalle(app: FastifyInstance): void {
  const gardeSalle = app.exigerRole(...ROLES_SALLE);

  // Appels client en attente, avec leur destinataire recalculé (présence à jour)
  app.get('/api/appels/en-attente', { preHandler: gardeSalle }, async (): Promise<AppelVue[]> => {
    const lignes = await db
      .select({
        id: appelsTable.id,
        table_id: appelsTable.table_id,
        type: appelsTable.type,
        cree_le: appelsTable.cree_le,
        table_numero: tablesSalle.numero,
        zone_nom: zones.nom,
      })
      .from(appelsTable)
      .innerJoin(tablesSalle, eq(tablesSalle.id, appelsTable.table_id))
      .innerJoin(zones, eq(zones.id, tablesSalle.zone_id))
      .where(eq(appelsTable.statut, 'EN_ATTENTE'))
      .orderBy(asc(appelsTable.cree_le));

    const vues: AppelVue[] = [];
    for (const l of lignes) {
      const dest = await calculerDestinataire(db, app.presence, l.table_id);
      vues.push({
        id: l.id,
        table_id: l.table_id,
        table_numero: l.table_numero,
        zone_nom: l.zone_nom,
        type: l.type as AppelVue['type'],
        cible: dest.cible,
        serveur_id: dest.serveur_id,
        cree_le: l.cree_le.toISOString(),
      });
    }
    return vues;
  });

  // Traiter un appel : une DEMANDE_FACTURE déclenche le flux « addition »
  // (la caisse imprime la note). L'interaction reste client → serveur → caisse.
  app.post('/api/appels/:id/traiter', { preHandler: gardeSalle }, async (req) => {
    const { id } = req.params as { id: string };
    const resultat = await db.transaction(async (tx) => {
      const [appel] = await tx.select().from(appelsTable).where(eq(appelsTable.id, id)).for('update');
      if (!appel) throw introuvable('Appel');
      if (appel.statut === 'TRAITE') return { deja: true as const, appel };
      await tx
        .update(appelsTable)
        .set({ statut: 'TRAITE', traite_le: new Date(), traite_par: req.session!.utilisateur_id })
        .where(eq(appelsTable.id, id));

      if (appel.type === 'DEMANDE_FACTURE') {
        const ouvertes = await tx
          .select({ id: commandes.id })
          .from(commandes)
          .where(and(eq(commandes.table_id, appel.table_id), notInArray(commandes.statut, ['PAYEE', 'ANNULEE'])));
        if (ouvertes.length > 0) {
          await tx.update(tablesSalle).set({ statut: 'ADDITION_DEMANDEE' }).where(eq(tablesSalle.id, appel.table_id));
        }
      }
      return { deja: false as const, appel };
    });

    if (resultat.appel.type === 'DEMANDE_FACTURE') {
      app.diffuser('table:addition_demandee', resultat.appel.table_id);
    }
    app.diffuser('table:changee', resultat.appel.table_id);
    return { ok: true };
  });

  /**
   * Valider une commande client : c'est la SEULE porte vers la cuisine.
   * Le serveur validant devient responsable de la commande (serveur_id) pour
   * la notification « prête » (point 2). La table passe OCCUPEE.
   */
  app.post('/api/commandes/:id/valider', { preHandler: gardeSalle }, async (req) => {
    const { id } = req.params as { id: string };
    const estServeur = req.session!.role === 'SERVEUR';

    const vue = await db.transaction(async (tx) => {
      const c = await verrouillerCommande(tx, id);
      if (c.origine !== 'CLIENT_QR') {
        throw new ErreurMetier('Cette commande n’est pas une proposition client', 400);
      }
      if (c.statut !== 'OUVERTE') {
        throw new ErreurMetier('Cette commande a déjà été traitée', 409);
      }
      const serveurId = c.serveur_id ?? (estServeur ? req.session!.utilisateur_id : null);
      const [maj] = await tx
        .update(commandes)
        .set({ serveur_id: serveurId, updated_at: new Date() })
        .where(eq(commandes.id, id))
        .returning();
      await ecrireOutbox(tx, 'commandes', 'UPDATE', id, maj as unknown as Record<string, unknown>);
      await marquerEnvoiCuisine(tx, id); // → ENVOYEE_CUISINE (cuisine, enfin)
      await majStatutTable(tx, c.table_id, 'OCCUPEE');
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'PAIEMENT',
        entite: 'commandes',
        entite_id: id,
        meta: { validation_client: true },
      });
      return chargerCommandeVue(tx, id);
    });

    app.diffuser('commande:envoyee', id);
    app.diffuser('commande', id);
    if (vue.table_id) app.diffuser('table:changee', vue.table_id);
    return vue;
  });

  /** Refuser une commande client : ANNULEE + message montré au client. */
  app.post('/api/commandes/:id/refuser', { preHandler: gardeSalle }, async (req) => {
    const { id } = req.params as { id: string };
    const corps = valider(RefusCommandeSchema, req.body);

    const vue = await db.transaction(async (tx) => {
      const c = await verrouillerCommande(tx, id);
      if (c.origine !== 'CLIENT_QR') {
        throw new ErreurMetier('Cette commande n’est pas une proposition client', 400);
      }
      if (c.statut !== 'OUVERTE') {
        throw new ErreurMetier('Cette commande a déjà été traitée', 409);
      }
      const [maj] = await tx
        .update(commandes)
        .set({ statut: 'ANNULEE', refus_motif: corps.motif, updated_at: new Date() })
        .where(eq(commandes.id, id))
        .returning();
      await ecrireOutbox(tx, 'commandes', 'UPDATE', id, maj as unknown as Record<string, unknown>);
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'ANNULATION_COMMANDE',
        entite: 'commandes',
        entite_id: id,
        motif: corps.motif,
        meta: { refus_client: true },
      });
      return chargerCommandeVue(tx, id);
    });

    app.diffuser('commande', id);
    if (vue.table_id) app.diffuser('table:changee', vue.table_id);
    return vue;
  });

  /**
   * « Servie » (point 2) : PRETE → SERVIE. Le serveur (ou la caisse en repli)
   * marque le plat servi, ce qui éteint la notification « prête ».
   */
  app.post('/api/commandes/:id/servir', { preHandler: gardeSalle }, async (req) => {
    const { id } = req.params as { id: string };
    const vue = await db.transaction(async (tx) => {
      const c = await verrouillerCommande(tx, id);
      if (c.statut !== 'PRETE') {
        throw new ErreurMetier('Cette commande n’est pas prête à être servie', 409);
      }
      const [maj] = await tx
        .update(commandes)
        .set({ statut: 'SERVIE', updated_at: new Date() })
        .where(eq(commandes.id, id))
        .returning();
      await ecrireOutbox(tx, 'commandes', 'UPDATE', id, maj as unknown as Record<string, unknown>);
      return chargerCommandeVue(tx, id);
    });
    app.diffuser('commande:servie', id);
    app.diffuser('commande', id);
    if (vue.table_id) app.diffuser('table:changee', vue.table_id);
    return vue;
  });

  // Liste des commandes client en attente de validation (repli caisse inclus)
  app.get('/api/commandes/a-valider', { preHandler: gardeSalle }, async () => {
    const lignes = await db
      .select({
        id: commandes.id,
        numero_ticket: commandes.numero_ticket,
        table_id: commandes.table_id,
        table_numero: tablesSalle.numero,
        serveur_id: commandes.serveur_id,
        total: commandes.total,
        created_at: commandes.created_at,
      })
      .from(commandes)
      .leftJoin(tablesSalle, eq(tablesSalle.id, commandes.table_id))
      .where(and(eq(commandes.origine, 'CLIENT_QR'), eq(commandes.statut, 'OUVERTE')))
      .orderBy(desc(commandes.created_at));
    return lignes.map((l) => ({ ...l, numero_ticket: Number(l.numero_ticket), created_at: l.created_at.toISOString() }));
  });
}
