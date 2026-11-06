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
import { db, type DbOuTx } from '../../db/client.js';
import { roles, utilisateurs } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { journaliser } from '../audit/audit.js';

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

/** Durée de validité d'un code temporaire, en jours. */
export const CODE_VALIDE_JOURS = 7;

/**
 * Remet un compte en « PIN à poser » avec le code temporaire dont on donne le
 * HASH : la réinitialisation du poste le calcule ici, celle du siège le reçoit
 * déjà haché (le code en clair ne transite jamais par le cloud). Les verrous
 * anti-force brute repartent de zéro. Outbox et audit dans la même transaction.
 * Les sessions ouvertes du compte restent à couper par l'appelant.
 */
export async function poserCodeTemporaire(
  utilisateurId: string,
  codeHash: string,
  audit: { user_id: string | null; meta: Record<string, unknown> },
): Promise<Date> {
  const expire = new Date(Date.now() + CODE_VALIDE_JOURS * 24 * 3600 * 1000);
  await db.transaction(async (tx) => {
    const [u] = await tx
      .update(utilisateurs)
      .set({
        doit_definir_pin: true,
        pin_temporaire_hash: codeHash,
        pin_temporaire_expire: expire,
        tentatives_pin: 0,
        verrou_jusqua: null,
        updated_at: new Date(),
      })
      .where(eq(utilisateurs.id, utilisateurId))
      .returning();
    await ecrireOutbox(tx, 'utilisateurs', 'UPDATE', utilisateurId, u as unknown as Record<string, unknown>);
    await journaliser(tx, {
      user_id: audit.user_id,
      action: 'REINIT_PIN',
      entite: 'utilisateurs',
      entite_id: utilisateurId,
      meta: audit.meta,
    });
  });
  return expire;
}
