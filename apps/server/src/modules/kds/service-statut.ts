/**
 * « Prêt » et « Servi » d'une commande, quel que soit l'écran qui le dit :
 * l'écran cuisine (KDS), le serveur, ou la CAISSE — un restaurant sans écran
 * cuisine, ou un plat sorti au passe pendant que la cuisine est débordée, ne
 * doit pas rester bloqué en « en cuisine ».
 *
 * Une seule implémentation : la caisse et le KDS déclenchent exactement la
 * même sonnerie chez le serveur et retirent la même carte de l'écran cuisine.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { DbOuTx } from '../../db/client.js';
import { commandeItems, commandes, tablesSalle } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier } from '../../lib/erreurs.js';
import { verrouillerCommande } from '../commandes/service.js';
import { attribuerPlats } from './attribution.js';

/** Tous les articles partis en cuisine passent PRET (sauf les annulés). */
async function articlesPrets(tx: DbOuTx, commandeId: string): Promise<void> {
  const items = await tx
    .select()
    .from(commandeItems)
    .where(and(eq(commandeItems.commande_id, commandeId), isNotNull(commandeItems.envoye_le)));
  for (const item of items) {
    if (item.statut_cuisine === 'ANNULE' || item.statut_cuisine === 'PRET') continue;
    const [maj] = await tx
      .update(commandeItems)
      .set({ statut_cuisine: 'PRET' })
      .where(eq(commandeItems.id, item.id))
      .returning();
    await ecrireOutbox(tx, 'commande_items', 'UPDATE', item.id, maj as unknown as Record<string, unknown>);
  }
}

/**
 * ENVOYEE_CUISINE → PRETE, puis fait sonner le serveur rattaché (ou la caisse
 * s'il est déconnecté / si la commande a été prise à la caisse).
 */
export async function marquerPrete(app: FastifyInstance, id: string): Promise<void> {
  await db.transaction(async (tx) => {
    const c = await verrouillerCommande(tx, id);
    if (c.statut !== 'ENVOYEE_CUISINE') {
      throw new ErreurMetier('Cette commande n’est pas en cuisine', 409);
    }
    await articlesPrets(tx, id);
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
}

/**
 * → SERVIE. Depuis PRETE toujours ; depuis ENVOYEE_CUISINE seulement si
 * `directDepuisCuisine` (la caisse qui a vu le plat sortir sans « Prêt » :
 * les articles passent PRET au passage, pour que la carte quitte le KDS).
 */
export async function marquerServie(
  app: FastifyInstance,
  id: string,
  { directDepuisCuisine = false } = {},
): Promise<string | null> {
  const tableId = await db.transaction(async (tx) => {
    const c = await verrouillerCommande(tx, id);
    const depuisCuisine = directDepuisCuisine && c.statut === 'ENVOYEE_CUISINE';
    if (c.statut !== 'PRETE' && !depuisCuisine) {
      throw new ErreurMetier(
        directDepuisCuisine
          ? 'Cette commande n’est ni en cuisine ni prête'
          : 'Cette commande n’est pas prête à être servie',
        409,
      );
    }
    if (depuisCuisine) await articlesPrets(tx, id);
    const [maj] = await tx
      .update(commandes)
      .set({ statut: 'SERVIE', updated_at: new Date() })
      .where(eq(commandes.id, id))
      .returning();
    await ecrireOutbox(tx, 'commandes', 'UPDATE', id, maj as unknown as Record<string, unknown>);
    return maj!.table_id;
  });
  app.diffuser('commande:servie', id);
  app.diffuser('commande:modifiee', id);
  app.diffuser('commande', id);
  if (tableId) app.diffuser('table:changee', tableId);
  return tableId;
}
