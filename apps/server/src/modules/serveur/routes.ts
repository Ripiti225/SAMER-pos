/**
 * App serveur tablette (sprint 2, §B).
 * Deux actions IDEMPOTENTES rejouables par la file locale anti-coupure (§B4) :
 * chaque action porte un UUID généré sur la tablette ; un UUID déjà présent
 * dans actions_recues est ignoré (rejeu sans doublon garanti).
 *
 * Le rôle SERVEUR ne peut PAS encaisser, remiser ni annuler un article envoyé
 * — ces routes restent protégées par le guard caisse (vérifié par test).
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, notInArray } from 'drizzle-orm';
import { DemanderAdditionSchema, EnvoyerCuisineSchema } from '@pos/shared';
import { db } from '../../db/client.js';
import { actionsRecues, commandes, tablesSalle } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier, introuvable } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import {
  chargerCommandeVue,
  figerNouvelItem,
  recalculerTotaux,
} from '../commandes/service.js';
import { exigerAccesTable, ouvrirTablePar } from '../tables/propriete.js';
import type { DbOuTx } from '../../db/client.js';

/**
 * Enregistre l'action si inédite. Retourne false si l'UUID a déjà été traité
 * (l'appelant répond OK sans rien refaire — idempotence).
 */
async function actionInedite(tx: DbOuTx, actionUuid: string): Promise<boolean> {
  const inserees = await tx
    .insert(actionsRecues)
    .values({ uuid: actionUuid })
    .onConflictDoNothing()
    .returning();
  return inserees.length > 0;
}

export function routesServeur(app: FastifyInstance): void {
  const gardeSalle = app.exigerRole('SERVEUR', 'MANAGER', 'PROPRIETAIRE');

  /**
   * « Envoyer en cuisine » : action unique qui, en une transaction,
   * crée la commande de table si besoin (serveur_id attribué), ajoute le
   * LOT d'articles (envoyés immédiatement), passe la commande à
   * ENVOYEE_CUISINE et la table à OCCUPEE. Ajout en plusieurs fois autorisé :
   * chaque envoi ne contient que les nouveaux articles.
   */
  app.post('/api/serveur/envoyer', { preHandler: gardeSalle }, async (req) => {
    const corps = valider(EnvoyerCuisineSchema, req.body);

    const resultat = await db.transaction(async (tx) => {
      if (!(await actionInedite(tx, corps.action_uuid))) {
        return { deja_traitee: true as const };
      }

      const tables = await tx
        .select()
        .from(tablesSalle)
        .where(eq(tablesSalle.id, corps.table_id))
        .for('update');
      const table = tables[0];
      if (!table) throw introuvable('Table');
      if (table.partenaire) {
        throw new ErreurMetier('Les commandes partenaires se prennent à la caisse', 400);
      }
      // Propriété : un serveur ne peut pas entrer dans la table d'un autre
      await exigerAccesTable(tx, req.session!, table.id);

      // Commande en cours sur cette table, sinon création
      const ouvertes = await tx
        .select()
        .from(commandes)
        .where(
          and(eq(commandes.table_id, table.id), notInArray(commandes.statut, ['PAYEE', 'ANNULEE'])),
        )
        .orderBy(desc(commandes.created_at));
      let commande = ouvertes[0];

      if (!commande) {
        const [creee] = await tx
          .insert(commandes)
          .values({
            type: 'SUR_PLACE',
            table_id: table.id,
            serveur_id: req.session!.utilisateur_id,
          })
          .returning();
        commande = creee!;
        await ecrireOutbox(tx, 'commandes', 'INSERT', commande.id, commande as unknown as Record<string, unknown>);
      }

      for (const item of corps.items) {
        await figerNouvelItem(tx, commande, item, true); // envoyé immédiatement
      }

      const [maj] = await tx
        .update(commandes)
        .set({ statut: 'ENVOYEE_CUISINE', updated_at: new Date() })
        .where(eq(commandes.id, commande.id))
        .returning();
      await ecrireOutbox(tx, 'commandes', 'UPDATE', commande.id, maj as unknown as Record<string, unknown>);
      await recalculerTotaux(tx, commande.id);

      if (table.statut === 'LIBRE') {
        await tx.update(tablesSalle).set({ statut: 'OCCUPEE' }).where(eq(tablesSalle.id, table.id));
      }
      // Le serveur devient propriétaire de la table (première commande)
      await ouvrirTablePar(tx, table.id, req.session!.utilisateur_id);

      return { deja_traitee: false as const, commande_id: commande.id };
    });

    if (!resultat.deja_traitee && resultat.commande_id) {
      app.diffuser('commande:envoyee', resultat.commande_id);
      app.diffuser('commande', resultat.commande_id);
      return { ok: true, ...resultat, commande: await chargerCommandeVue(db, resultat.commande_id) };
    }
    return { ok: true, ...resultat };
  });

  /** « Demander l'addition » : la table passe en bleu côté caisse (§B3). */
  app.post('/api/serveur/addition', { preHandler: gardeSalle }, async (req) => {
    const corps = valider(DemanderAdditionSchema, req.body);

    const resultat = await db.transaction(async (tx) => {
      if (!(await actionInedite(tx, corps.action_uuid))) {
        return { deja_traitee: true as const };
      }

      const tables = await tx
        .select()
        .from(tablesSalle)
        .where(eq(tablesSalle.id, corps.table_id))
        .for('update');
      const table = tables[0];
      if (!table) throw introuvable('Table');
      await exigerAccesTable(tx, req.session!, table.id);

      const ouvertes = await tx
        .select({ id: commandes.id })
        .from(commandes)
        .where(
          and(eq(commandes.table_id, table.id), notInArray(commandes.statut, ['PAYEE', 'ANNULEE'])),
        );
      if (ouvertes.length === 0) {
        throw new ErreurMetier('Aucune commande en cours sur cette table', 409);
      }

      await tx
        .update(tablesSalle)
        .set({ statut: 'ADDITION_DEMANDEE' })
        .where(eq(tablesSalle.id, table.id));
      return { deja_traitee: false as const };
    });

    // Une seule diffusion par demande : le rejeu idempotent ne refait pas
    // sonner la caisse (correction 2 — le son ne se joue qu'une fois).
    if (!resultat.deja_traitee) {
      app.diffuser('table:addition_demandee', corps.table_id);
    }
    return { ok: true, ...resultat };
  });
}
