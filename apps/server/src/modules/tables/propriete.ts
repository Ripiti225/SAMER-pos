/**
 * Propriété de table (CORRECTIONS3 point 3) — appliqué CÔTÉ SERVEUR.
 * La table appartient au serveur qui l'a ouverte : un autre SERVEUR ne peut
 * pas y accéder. Les rôles CAISSIER / MANAGER / PROPRIETAIRE ont toujours accès.
 */
import { eq } from 'drizzle-orm';
import type { DbOuTx } from '../../db/client.js';
import { aPermission, type SessionUtilisateur } from '../../plugins/sessions.js';
import { tablesSalle, utilisateurs } from '../../db/schema/index.js';
import { ErreurMetier } from '../../lib/erreurs.js';

function prenom(nomComplet: string): string {
  return nomComplet.split(/\s+/)[0] ?? nomComplet;
}

/** Marque la table comme ouverte par un utilisateur si elle n'a pas de propriétaire. */
export async function ouvrirTablePar(tx: DbOuTx, tableId: string | null, utilisateurId: string): Promise<void> {
  if (!tableId) return;
  const [t] = await tx.select({ ouverte_par: tablesSalle.ouverte_par }).from(tablesSalle).where(eq(tablesSalle.id, tableId));
  if (t && !t.ouverte_par) {
    await tx.update(tablesSalle).set({ ouverte_par: utilisateurId }).where(eq(tablesSalle.id, tableId));
  }
}

/**
 * Refuse (403) l'accès à la table si l'utilisateur est un SERVEUR différent du
 * propriétaire. Message : « Table ouverte par Awa ».
 */
export async function exigerAccesTable(
  dbx: DbOuTx,
  session: SessionUtilisateur,
  tableId: string | null,
): Promise<void> {
  if (!tableId) return;
  // Accès total pour qui voit toutes les tables (caisse / manager / propriétaire)
  if (await aPermission(session, 'salle.voir_toutes_tables')) return;
  const [t] = await dbx
    .select({ ouverte_par: tablesSalle.ouverte_par, nom: utilisateurs.nom_complet })
    .from(tablesSalle)
    .leftJoin(utilisateurs, eq(utilisateurs.id, tablesSalle.ouverte_par))
    .where(eq(tablesSalle.id, tableId));
  if (t?.ouverte_par && t.ouverte_par !== session.utilisateur_id) {
    throw new ErreurMetier(`Table ouverte par ${prenom(t.nom ?? 'un autre serveur')}`, 403);
  }
}
