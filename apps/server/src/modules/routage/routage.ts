/**
 * Routage des appels ET des commandes client (CORRECTIONS3 point 1b).
 *
 * Principe : le client interagit avec SON serveur ; la caisse est le repli ;
 * la cuisine n'est JAMAIS destinataire. Le destinataire est calculé CÔTÉ
 * SERVEUR à chaque événement :
 *   1. serveur propriétaire de la table s'il est connecté ;
 *   2. sinon un autre serveur connecté de la même zone ;
 *   3. sinon (aucun serveur disponible) → la caisse.
 */
import { and, eq, inArray, ne, notInArray } from 'drizzle-orm';
import type { CibleRoutage } from '@pos/shared';
import type { DbOuTx } from '../../db/client.js';
import type { Presence } from '../../plugins/ws.js';
import { commandes, tablesSalle, utilisateurs } from '../../db/schema/index.js';

export interface Destinataire {
  cible: CibleRoutage;
  serveur_id: string | null;
}

/**
 * Serveur propriétaire de la table. Point 1 : le serveur de la commande en
 * cours (point 3 basculera sur tables_salle.ouverte_par).
 */
export async function serveurProprietaireTable(tx: DbOuTx, tableId: string): Promise<string | null> {
  const [table] = await tx.select().from(tablesSalle).where(eq(tablesSalle.id, tableId));
  if (table && 'ouverte_par' in table && table.ouverte_par) {
    return table.ouverte_par as string;
  }
  const ouvertes = await tx
    .select({ serveur_id: commandes.serveur_id })
    .from(commandes)
    .where(and(eq(commandes.table_id, tableId), notInArray(commandes.statut, ['PAYEE', 'ANNULEE'])));
  return ouvertes.find((c) => c.serveur_id)?.serveur_id ?? null;
}

/** Existe-t-il au moins un serveur actif inscrit par la caisse ? */
export async function auMoinsUnServeurActif(tx: DbOuTx): Promise<boolean> {
  const lignes = await tx
    .select({ id: utilisateurs.id })
    .from(utilisateurs)
    .where(and(eq(utilisateurs.role, 'SERVEUR'), eq(utilisateurs.actif, true)));
  return lignes.length > 0;
}

/**
 * Calcule le destinataire d'un appel/commande pour une table. Ne renvoie
 * JAMAIS la cuisine : au pire, repli caisse.
 */
export async function calculerDestinataire(
  tx: DbOuTx,
  presence: Presence,
  tableId: string,
): Promise<Destinataire> {
  const connectes = presence.serveursConnectes();

  // 1. Propriétaire connecté
  const proprietaire = await serveurProprietaireTable(tx, tableId);
  if (proprietaire && connectes.has(proprietaire)) {
    return { cible: 'SERVEUR', serveur_id: proprietaire };
  }

  if (connectes.size > 0) {
    // 2. Un autre serveur connecté de la même zone si possible
    const [table] = await tx.select().from(tablesSalle).where(eq(tablesSalle.id, tableId));
    if (table) {
      const memeZone = await tx
        .select({ serveur_id: commandes.serveur_id })
        .from(commandes)
        .innerJoin(tablesSalle, eq(tablesSalle.id, commandes.table_id))
        .where(
          and(
            eq(tablesSalle.zone_id, table.zone_id),
            ne(commandes.table_id, tableId),
            notInArray(commandes.statut, ['PAYEE', 'ANNULEE']),
          ),
        );
      const dansZone = memeZone
        .map((c) => c.serveur_id)
        .find((id): id is string => !!id && connectes.has(id));
      if (dansZone) return { cible: 'SERVEUR', serveur_id: dansZone };
    }

    // Sinon n'importe quel serveur connecté (toujours pas la cuisine)
    const serveursActifs = await tx
      .select({ id: utilisateurs.id })
      .from(utilisateurs)
      .where(
        and(
          eq(utilisateurs.role, 'SERVEUR'),
          eq(utilisateurs.actif, true),
          inArray(utilisateurs.id, [...connectes]),
        ),
      );
    if (serveursActifs[0]) return { cible: 'SERVEUR', serveur_id: serveursActifs[0].id };
  }

  // 3. Aucun serveur disponible → repli caisse
  return { cible: 'CAISSE', serveur_id: null };
}
