/**
 * Vérification PIN + anti-force brute (§14.1).
 * 5 échecs → verrou 30 s, 10 échecs → 60 s, 15 échecs et plus → 300 s.
 */
import argon2 from 'argon2';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { roles, utilisateurs } from '../../db/schema/index.js';
import { journaliser } from '../audit/audit.js';
import { ErreurMetier } from '../../lib/erreurs.js';
import { permissionsDuRole } from '../roles/service.js';

/** Les rôles personnalisés peuvent aussi recevoir l'autorité de supervision. */
const PERMISSION_SUPERVISION = 'rapports.z';

const SEUIL_ECHECS = 5;
const PALIERS_VERROU_SECONDES = [30, 60, 300] as const;

function dureeVerrou(tentatives: number): number | null {
  const palier = Math.floor(tentatives / SEUIL_ECHECS);
  if (palier < 1) return null;
  return PALIERS_VERROU_SECONDES[Math.min(palier, PALIERS_VERROU_SECONDES.length) - 1] ?? 300;
}

export type UtilisateurDb = typeof utilisateurs.$inferSelect;

/**
 * Vérifie le PIN d'un utilisateur identifié, en appliquant le verrouillage.
 * Lève une ErreurMetier (message FR) si verrouillé ou PIN faux.
 */
export async function verifierPinUtilisateur(utilisateurId: string, pin: string): Promise<UtilisateurDb> {
  const [u] = await db
    .select()
    .from(utilisateurs)
    .where(and(eq(utilisateurs.id, utilisateurId), eq(utilisateurs.actif, true)));
  if (!u) throw new ErreurMetier('Utilisateur inconnu ou désactivé', 404);

  if (u.doit_definir_pin) {
    throw new ErreurMetier('Ce compte doit d’abord définir son PIN', 409);
  }

  if (u.verrou_jusqua && u.verrou_jusqua.getTime() > Date.now()) {
    const restant = Math.ceil((u.verrou_jusqua.getTime() - Date.now()) / 1000);
    throw new ErreurMetier(`Ce PIN est bloqué ${restant} seconde${restant > 1 ? 's' : ''}`, 423);
  }

  const bon = await argon2.verify(u.pin_hash, pin);
  if (bon) {
    if (u.tentatives_pin > 0 || u.verrou_jusqua) {
      await db
        .update(utilisateurs)
        .set({ tentatives_pin: 0, verrou_jusqua: null, updated_at: new Date() })
        .where(eq(utilisateurs.id, u.id));
    }
    return u;
  }

  // Échec : compteur + verrou éventuel + audit ECHEC_PIN, en une transaction.
  const tentatives = u.tentatives_pin + 1;
  const duree = dureeVerrou(tentatives);
  const verrouJusqua = duree ? new Date(Date.now() + duree * 1000) : null;
  await db.transaction(async (tx) => {
    await tx
      .update(utilisateurs)
      .set({ tentatives_pin: tentatives, verrou_jusqua: verrouJusqua, updated_at: new Date() })
      .where(eq(utilisateurs.id, u.id));
    await journaliser(tx, {
      user_id: u.id,
      action: 'ECHEC_PIN',
      entite: 'utilisateurs',
      entite_id: u.id,
      meta: { tentatives, verrou_secondes: duree ?? 0 },
    });
  });

  if (duree) {
    throw new ErreurMetier(`Ce PIN est bloqué ${duree} secondes`, 423);
  }
  throw new ErreurMetier('PIN incorrect', 401);
}

/**
 * argon2.verify LÈVE quand le hash stocké n'est pas un hash argon2 lisible
 * (compte importé, colonne tronquée). Dans la boucle du PIN manager, un seul
 * compte abîmé faisait alors échouer la vérification de TOUS les autres.
 */
async function pinCorrespond(hash: string, pin: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, pin);
  } catch {
    return false;
  }
}

/** Nom lisible du rôle d'un compte (rôle actuel, sinon ancien enum). */
function nomRole(nomJoint: string | null, u: UtilisateurDb): string {
  return nomJoint ?? u.role ?? 'sans rôle';
}

/**
 * Le compte peut-il approuver une action protégée ?
 *
 * Le rôle actuel fait foi ; l'ancien enum `role` ne sert que de repli quand
 * `role_id` ne pointe sur aucun rôle lisible. Retirer l'accès au rapport Z ne
 * retire pas l'autorité du rôle MANAGER pour une remise ou une annulation. Les
 * rôles personnalisés gardent la possibilité d'approuver via la permission de
 * supervision.
 */
async function peutApprouver(nomJoint: string | null, u: UtilisateurDb): Promise<boolean> {
  const role = nomJoint ?? u.role;
  return (
    role === 'PROPRIETAIRE' || role === 'SUPERVISEUR' || role === 'MANAGER' ||
    (await permissionsDuRole(u.role_id)).has(PERMISSION_SUPERVISION)
  );
}

/**
 * Vérifie un PIN manager/propriétaire pour les actions protégées
 * (remise, annulation d'article envoyé, réouverture, table vidée). Retourne
 * l'utilisateur autorisé, ou lève une erreur FR. Chaque échec est audité.
 *
 * En cas d'échec, le message DIT pourquoi. « PIN manager incorrect » envoyait
 * chercher une faute de frappe alors que le PIN était bon : le compte était
 * resté caissier (promotion non répercutée), ou bloqué par des essais ratés.
 * Le diagnostic se fait en second passage, uniquement quand aucun manager n'a
 * reconnu le PIN — la vérification argon2 est lente et le chemin normal ne doit
 * pas la payer.
 */
export async function verifierPinManager(pin: string, contexte: string): Promise<UtilisateurDb> {
  const comptes = await db
    .select({ utilisateur: utilisateurs, nom_role: roles.nom })
    .from(utilisateurs)
    .leftJoin(roles, eq(roles.id, utilisateurs.role_id))
    .where(and(eq(utilisateurs.actif, true)));

  const autorises: typeof comptes = [];
  for (const ligne of comptes) {
    if (await peutApprouver(ligne.nom_role, ligne.utilisateur)) autorises.push(ligne);
  }

  for (const { utilisateur: m } of autorises) {
    if (m.verrou_jusqua && m.verrou_jusqua.getTime() > Date.now()) continue;
    if (await pinCorrespond(m.pin_hash, pin)) return m;
  }

  // Aucun manager n'a reconnu ce PIN : à qui appartient-il ?
  let bloque: { nom: string; secondes: number } | null = null;
  let sansAutorite: { nom: string; role: string } | null = null;
  for (const { utilisateur: m, nom_role } of comptes) {
    const verrou = m.verrou_jusqua && m.verrou_jusqua.getTime() > Date.now() ? m.verrou_jusqua : null;
    const autorise = autorises.some((a) => a.utilisateur.id === m.id);
    if (!verrou && autorise) continue; // déjà essayé ci-dessus
    if (!(await pinCorrespond(m.pin_hash, pin))) continue;
    if (verrou && autorise) {
      // Un manager bloqué explique tout : on s'arrête là.
      bloque = { nom: m.nom_complet, secondes: Math.ceil((verrou.getTime() - Date.now()) / 1000) };
      break;
    }
    // Deux comptes peuvent partager un PIN de 4 chiffres : on garde le premier
    // trouvé mais on continue, un manager bloqué reste la meilleure explication.
    sansAutorite ??= { nom: m.nom_complet, role: nomRole(nom_role, m) };
  }

  await db.transaction(async (tx) => {
    await journaliser(tx, {
      action: 'ECHEC_PIN',
      entite: 'utilisateurs',
      meta: {
        contexte,
        type: 'PIN_MANAGER',
        cause: bloque ? 'COMPTE_BLOQUE' : sansAutorite ? 'SANS_AUTORITE' : 'PIN_INCONNU',
        ...(bloque ? { compte: bloque.nom } : {}),
        ...(sansAutorite ? { compte: sansAutorite.nom, role: sansAutorite.role } : {}),
      },
    });
  });

  if (bloque) {
    throw new ErreurMetier(
      `Le PIN de ${bloque.nom} est bloqué ${bloque.secondes} seconde${bloque.secondes > 1 ? 's' : ''} après des essais ratés`,
      423,
    );
  }
  if (sansAutorite) {
    throw new ErreurMetier(
      `Ce PIN est bien celui de ${sansAutorite.nom}, mais son compte est encore « ${sansAutorite.role} » : `
        + 'il ne peut pas approuver cette action. Passez son rôle à Manager dans Réglages › Équipe.',
      403,
    );
  }
  throw new ErreurMetier('PIN manager incorrect', 403);
}
