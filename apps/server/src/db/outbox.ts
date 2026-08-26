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
  | 'sequences_caisse'
  | 'audit_log'
  | 'notes_split'
  | 'note_split_items'
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
  | 'disponibilite_locale'
  /**
   * 2026-08-25 — référentiel de salle. Sans lui, le cloud reçoit
   * `commandes.table_id`, un uuid qu'il ne sait traduire avec rien : le siège
   * ne peut pas dire quelle table travaille le plus.
   *
   * Le STATUT de table ne monte pas (colonne absente de la liste blanche) : il
   * change toutes les minutes et ferait remonter la table à chaque service,
   * pour une information qui n'a aucun sens au siège une fois le service fini.
   */
  | 'zones'
  | 'tables_salle'
  // Migration 0020 : options réutilisables. Locales pour l'instant (le siège ne
  // les redescend pas), mais la remontée est préparée dès maintenant — c'est
  // tout l'intérêt d'écrire l'outbox sans attendre le branchement cloud.
  | 'options_catalogue'
  | 'options_liaisons'
  /**
   * 2026-08-16 — ce que le caissier saisit doit arriver dans SamerTrackly sans
   * ressaisie (décision du boss). Le rapport Z figé porte déjà le RÉSUMÉ du
   * point de caisse ; ces tables portent le DÉTAIL : quelle dépense, quel
   * produit compté, combien manquait.
   *
   * ⚠ Ne JAMAIS ajouter une table ici avant qu'elle existe côté cloud, dans
   * `supabase/functions/_shared/tables.ts` ET dans le schéma : `sync-push`
   * acquitte de façon contiguë, donc une table inconnue bloquait toute la file
   * du site. (Depuis le 2026-08-16 elle est garée dans `sync_rejets` au lieu
   * de bloquer — mais la donnée n'arrive pas pour autant à destination.)
   * Le catalogue de comptage et les recettes ne remontent PAS : le siège les
   * connaît déjà, ils sont identiques sur les 7 sites.
   */
  | 'depenses'
  | 'inventaires_service'
  | 'inventaire_lignes'
  | 'entrees_stock';

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
