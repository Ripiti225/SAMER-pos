/**
 * Règles de protection des comptes d'encadrement (invariant 1.3).
 * - Toucher un compte PROPRIETAIRE, ou promouvoir quiconque PROPRIETAIRE /
 *   SUPERVISEUR, exige une session PROPRIETAIRE.
 * - Seul un PROPRIETAIRE crée/désactive/réinitialise un compte SUPERVISEUR.
 * Toute tentative refusée est auditée par l'appelant.
 */
import { randomInt, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import type { DbOuTx } from '../../db/client.js';
import { roles } from '../../db/schema/index.js';

export type RoleSensible = 'PROPRIETAIRE' | 'SUPERVISEUR';

export function estRoleSensible(nom: string | null | undefined): nom is RoleSensible {
  return nom === 'PROPRIETAIRE' || nom === 'SUPERVISEUR';
}

/** Résout le nom d'un rôle depuis son id (null si absent). */
export async function nomDuRole(dbx: DbOuTx, roleId: string | null): Promise<string | null> {
  if (!roleId) return null;
  const [r] = await dbx.select({ nom: roles.nom }).from(roles).where(eq(roles.id, roleId));
  return r?.nom ?? null;
}

/** Code temporaire à usage unique (6 chiffres) pour la pose de PIN. */
export function genererCodeTemporaire(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Hash argon2id d'un secret (code temporaire ou PIN). */
export function hacher(secret: string): Promise<string> {
  return argon2.hash(secret, { type: argon2.argon2id });
}

/** Hash inutilisable posé sur pin_hash tant que l'employé n'a pas choisi son PIN. */
export function hachInutilisable(): Promise<string> {
  return argon2.hash(randomBytes(24).toString('hex'), { type: argon2.argon2id });
}
