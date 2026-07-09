/**
 * Outbox pattern (§3.5) : chaque INSERT/UPDATE sur les tables métier
 * synchronisées écrit une ligne dans sync_outbox DANS LA MÊME TRANSACTION.
 * Le moteur de synchro (sprint 3) ne fera que lire cette table.
 */
import { syncOutbox } from './schema/index.js';
import type { DbOuTx } from './client.js';

export type TableSynchronisee =
  | 'commandes'
  | 'commande_items'
  | 'paiements'
  | 'services_caisse'
  | 'audit_log'
  | 'notes_split'
  // Sprint 4 : fidélité remonte aussi vers le cloud (SamerTrackly).
  | 'clients_fidelite'
  | 'points_fidelite'
  // Allègement : équipe du jour (remplace la remontée des pointages).
  | 'equipe_service'
  // Sprint 4B/4C : rôles, permissions et employés (administration).
  | 'roles'
  | 'role_permissions'
  | 'utilisateurs'
  // Sprint 4C : disponibilité locale (remonte au cloud à titre d'information).
  | 'disponibilite_locale';

export async function ecrireOutbox(
  tx: DbOuTx,
  tableName: TableSynchronisee,
  operation: 'INSERT' | 'UPDATE',
  recordId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.insert(syncOutbox).values({
    table_name: tableName,
    record_id: recordId,
    operation,
    payload,
  });
}
