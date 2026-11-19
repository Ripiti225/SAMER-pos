/**
 * Garde-fou « un téléphone = un compte » (décidé le 2026-11-19).
 *
 * Une page web ne peut pas lire l'IMEI : le téléphone reçoit une clé
 * aléatoire (cookie httpOnly) et le serveur n'en garde que l'empreinte.
 * Le verrou est tenu ici, dans les DEUX sens :
 *   - un téléphone rattaché à A refuse B (« déjà rattaché à un compte ») ;
 *   - un compte rattaché à un téléphone refuse les autres : un CHANGEMENT de
 *     téléphone devient une demande que le gérant accepte (PIN manager).
 * Le tout premier téléphone d'un compte se rattache tout seul.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray, ne } from 'drizzle-orm';
import type { DbOuTx } from '../../db/client.js';
import { appareilsPointage } from '../../db/schema/index.js';
import { journaliser } from '../audit/audit.js';

export const COOKIE_APPAREIL = 'pos_pointage_tel';
/** Plafond des navigateurs pour la durée d'un cookie (Chrome : 400 jours). */
export const DUREE_COOKIE_S = 400 * 24 * 3600;
const LONGUEUR_CLE_OCTETS = 32;
const LONGUEUR_LIBELLE_MAX = 120;

export const MESSAGE_DEJA_RATTACHE = 'Ce téléphone est déjà rattaché à un compte. Un téléphone ne sert qu’à une seule personne.';
export const MESSAGE_AUTRE_TELEPHONE = 'Votre compte est rattaché à un autre téléphone. Demande envoyée au gérant : il doit l’accepter sur la caisse.';

export type AppareilDb = typeof appareilsPointage.$inferSelect;

export function nouvelleCle(): string {
  return randomBytes(LONGUEUR_CLE_OCTETS).toString('base64url');
}

export function empreinte(cle: string): string {
  return createHash('sha256').update(cle).digest('hex');
}

/** Libellé lisible par le gérant (« iPhone · Safari »), tiré de l'en-tête du navigateur. */
export function libelleNavigateur(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent;
  const modele =
    /iPhone/.test(ua) ? 'iPhone'
      : /iPad/.test(ua) ? 'iPad'
        : /Android/.test(ua) ? (/;\s*([^;)]+?)\s+Build\//.exec(ua)?.[1] ?? 'Android')
          : 'Navigateur';
  const navigateur =
    /SamsungBrowser/.test(ua) ? 'Samsung Internet'
      : /CriOS|Chrome/.test(ua) ? 'Chrome'
        : /FxiOS|Firefox/.test(ua) ? 'Firefox'
          : /Safari/.test(ua) ? 'Safari'
            : null;
  return [modele, navigateur].filter(Boolean).join(' · ').slice(0, LONGUEUR_LIBELLE_MAX);
}

export type ResultatRattachement =
  | { statut: 'ACTIF'; appareil: AppareilDb; cleAPoser: string | null }
  | { statut: 'EN_ATTENTE'; cleAPoser: string | null }
  // Refusé : la route lève l'erreur APRÈS avoir validé la transaction, pour
  // que la tentative reste dans l'audit.
  | { statut: 'REFUSE'; message: string };

/**
 * Rattache (ou reconnaît) le téléphone de `utilisateurId`. À appeler APRÈS
 * la vérification du PIN. `cle` = clé lue dans le cookie (null si aucune).
 * `cleAPoser` : clé neuve que la route doit poser en cookie.
 */
export async function rattacherAppareil(
  tx: DbOuTx,
  utilisateurId: string,
  cle: string | null,
  libelle: string | null,
): Promise<ResultatRattachement> {
  const hash = cle ? empreinte(cle) : null;

  if (hash) {
    // Ce téléphone sert-il déjà (ou attend-il) pour quelqu'un d'autre ?
    const [autre] = await tx
      .select()
      .from(appareilsPointage)
      .where(and(
        eq(appareilsPointage.cle_hash, hash),
        inArray(appareilsPointage.statut, ['ACTIF', 'EN_ATTENTE']),
        ne(appareilsPointage.utilisateur_id, utilisateurId),
      ))
      .limit(1);
    if (autre) {
      await journaliser(tx, {
        user_id: utilisateurId,
        action: 'APPAREIL_DEJA_RATTACHE',
        entite: 'appareils_pointage',
        entite_id: autre.id,
        meta: { compte_rattache: autre.utilisateur_id, libelle },
      });
      return { statut: 'REFUSE', message: MESSAGE_DEJA_RATTACHE };
    }
  }

  const [actif] = await tx
    .select()
    .from(appareilsPointage)
    .where(and(eq(appareilsPointage.utilisateur_id, utilisateurId), eq(appareilsPointage.statut, 'ACTIF')));

  // Déjà le téléphone du compte.
  if (actif && hash && actif.cle_hash === hash) return { statut: 'ACTIF', appareil: actif, cleAPoser: null };

  const cleAPoser = cle ? null : nouvelleCle();
  const hashFinal = hash ?? empreinte(cleAPoser!);

  // Premier téléphone du compte : rattaché tout seul.
  if (!actif) {
    const [cree] = await tx
      .insert(appareilsPointage)
      .values({ utilisateur_id: utilisateurId, cle_hash: hashFinal, libelle, statut: 'ACTIF' })
      .returning();
    await journaliser(tx, {
      user_id: utilisateurId,
      action: 'APPAREIL_RATTACHE',
      entite: 'appareils_pointage',
      entite_id: cree!.id,
      meta: { libelle },
    });
    return { statut: 'ACTIF', appareil: cree!, cleAPoser };
  }

  // Changement de téléphone : une seule demande en cours, la plus récente.
  const [attente] = await tx
    .select()
    .from(appareilsPointage)
    .where(and(eq(appareilsPointage.utilisateur_id, utilisateurId), eq(appareilsPointage.statut, 'EN_ATTENTE')));
  if (attente?.cle_hash === hashFinal) return { statut: 'EN_ATTENTE', cleAPoser };
  if (attente) {
    await tx.update(appareilsPointage).set({ statut: 'REFUSE', decide_le: new Date() }).where(eq(appareilsPointage.id, attente.id));
  }
  const [demande] = await tx
    .insert(appareilsPointage)
    .values({ utilisateur_id: utilisateurId, cle_hash: hashFinal, libelle, statut: 'EN_ATTENTE' })
    .returning();
  await journaliser(tx, {
    user_id: utilisateurId,
    action: 'APPAREIL_CHANGEMENT_DEMANDE',
    entite: 'appareils_pointage',
    entite_id: demande!.id,
    meta: { libelle, ancien: actif.libelle },
  });
  return { statut: 'EN_ATTENTE', cleAPoser };
}

/** Téléphone ACTIF de ce compte portant cette clé, sinon null. */
export async function appareilDuCompte(tx: DbOuTx, utilisateurId: string, cle: string | null): Promise<AppareilDb | null> {
  if (!cle) return null;
  const [a] = await tx
    .select()
    .from(appareilsPointage)
    .where(and(
      eq(appareilsPointage.utilisateur_id, utilisateurId),
      eq(appareilsPointage.cle_hash, empreinte(cle)),
      eq(appareilsPointage.statut, 'ACTIF'),
    ));
  return a ?? null;
}

/** Compte auquel ce téléphone est rattaché (ACTIF), sinon null. */
export async function compteDeLAppareil(tx: DbOuTx, cle: string | null): Promise<AppareilDb | null> {
  if (!cle) return null;
  const [a] = await tx
    .select()
    .from(appareilsPointage)
    .where(and(eq(appareilsPointage.cle_hash, empreinte(cle)), eq(appareilsPointage.statut, 'ACTIF')));
  return a ?? null;
}
