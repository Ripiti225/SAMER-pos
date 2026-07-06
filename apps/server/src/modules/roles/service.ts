/**
 * Rôles & permissions (sprint 4B+4C, fondation).
 * - etablirRolesSysteme : crée/rafraîchit les 6 rôles système + leurs
 *   permissions par défaut (miroir de shared/permissions.ts). Idempotent.
 * - permissionsDuRole : résolution avec cache mémoire, invalidé en temps réel
 *   quand un rôle est modifié (le guard reflète immédiatement le changement).
 */
import { eq, inArray } from 'drizzle-orm';
import { ROLES_SYSTEME, PERMISSIONS_DEFAUT, type RoleSysteme } from '@pos/shared';
import type { DbOuTx } from '../../db/client.js';
import { db } from '../../db/client.js';
import { rolePermissions, roles } from '../../db/schema/index.js';

/** Crée les rôles système et (re)pose leurs permissions par défaut. */
export async function etablirRolesSysteme(tx: DbOuTx): Promise<Map<string, string>> {
  const parNom = new Map<string, string>();
  for (const nom of ROLES_SYSTEME) {
    const [existant] = await tx.select().from(roles).where(eq(roles.nom, nom));
    let id: string;
    if (!existant) {
      const [cree] = await tx.insert(roles).values({ nom, systeme: true, actif: true }).returning();
      id = cree!.id;
    } else {
      id = existant.id;
      if (!existant.systeme) await tx.update(roles).set({ systeme: true }).where(eq(roles.id, id));
    }
    parNom.set(nom, id);
    // Permissions par défaut (remise à l'état de référence)
    await tx.delete(rolePermissions).where(eq(rolePermissions.role_id, id));
    const cles = PERMISSIONS_DEFAUT[nom as RoleSysteme];
    if (cles.length > 0) {
      await tx.insert(rolePermissions).values(cles.map((permission_cle) => ({ role_id: id!, permission_cle })));
    }
  }
  invaliderCachePermissions();
  return parNom;
}

// ---------------------------------------------------------------------------
// Cache des permissions par rôle (invalidé sur modification d'un rôle)
// ---------------------------------------------------------------------------
const cache = new Map<string, Set<string>>();

export function invaliderCachePermissions(): void {
  cache.clear();
}

export async function permissionsDuRole(roleId: string | null): Promise<Set<string>> {
  if (!roleId) return new Set();
  const enCache = cache.get(roleId);
  if (enCache) return enCache;
  const lignes = await db.select().from(rolePermissions).where(eq(rolePermissions.role_id, roleId));
  const set = new Set(lignes.map((l) => l.permission_cle));
  cache.set(roleId, set);
  return set;
}

export interface RoleResolu {
  id: string;
  nom: string;
  systeme: boolean;
  actif: boolean;
}

export async function lireRole(dbx: DbOuTx, roleId: string): Promise<RoleResolu | null> {
  const [r] = await dbx.select().from(roles).where(eq(roles.id, roleId));
  return r ? { id: r.id, nom: r.nom, systeme: r.systeme, actif: r.actif } : null;
}

/** Nombre d'employés par rôle (pour l'écran Rôles & accès). */
export async function compterEmploiParRole(dbx: DbOuTx, roleIds: string[]): Promise<Map<string, number>> {
  if (roleIds.length === 0) return new Map();
  const { utilisateurs } = await import('../../db/schema/index.js');
  const { sql } = await import('drizzle-orm');
  const lignes = await dbx
    .select({ role_id: utilisateurs.role_id, n: sql<string>`COUNT(*)` })
    .from(utilisateurs)
    .where(inArray(utilisateurs.role_id, roleIds))
    .groupBy(utilisateurs.role_id);
  return new Map(lignes.map((l) => [l.role_id as string, Number(l.n)]));
}
