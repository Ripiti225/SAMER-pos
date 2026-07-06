/**
 * Fidélité (§9) — routes caisse. Rattachement d'un client au paiement,
 * consultation du solde, utilisation de points en remise.
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { TelephoneFideliteSchema } from '@pos/shared';
import { db } from '../../db/client.js';
import { clientsFidelite, commandes } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';
import { chargerCommandeVue, exigerModifiable, recalculerTotaux, verrouillerCommande } from '../commandes/service.js';
import { lireBareme, soldePoints, trouverOuCreer, utiliserPoints } from './service.js';

const RattacherSchema = z.object({
  telephone: TelephoneFideliteSchema,
  utiliser_points: z.number().int().min(0).optional(),
});

export function routesFidelite(app: FastifyInstance): void {
  const gardeCaisse = app.exigePermission('caisse.encaisser');

  // Consulter un solde par téléphone (pavé de saisie au paiement)
  app.get('/api/fidelite/:telephone', { preHandler: gardeCaisse }, async (req) => {
    const { telephone } = req.params as { telephone: string };
    const bareme = await lireBareme(db);
    const [cli] = await db.select().from(clientsFidelite).where(eq(clientsFidelite.telephone, telephone));
    if (!cli) return { existe: false, solde: 0, bareme };
    return { existe: true, client_id: cli.id, nom: cli.nom, solde: await soldePoints(db, cli.id), bareme };
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
