/**
 * Vérification PIN + anti-force brute (§14.1).
 * 5 échecs → verrou 30 s, 10 échecs → 60 s, 15 échecs et plus → 300 s.
 */
import argon2 from 'argon2';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { utilisateurs } from '../../db/schema/index.js';
import { journaliser } from '../audit/audit.js';
import { ErreurMetier } from '../../lib/erreurs.js';
import { permissionsDuRole } from '../roles/service.js';

/**
 * Permission qui marque l'autorité « manager » pour valider une action protégée
 * (remise, annulation d'article envoyé, réouverture, correction pointage).
 * MANAGER / PROPRIETAIRE / SUPERVISEUR la possèdent ; un CAISSIER non — ce qui
 * préserve la règle « PIN manager » sous le modèle par permissions.
 */
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
 * Vérifie un PIN manager/propriétaire pour les actions protégées
 * (remise, annulation d'article envoyé, réouverture). Retourne l'utilisateur
 * autorisé, ou lève une erreur FR. Chaque échec est audité.
 */
export async function verifierPinManager(pin: string, contexte: string): Promise<UtilisateurDb> {
  const managers = await db
    .select()
    .from(utilisateurs)
    .where(and(eq(utilisateurs.actif, true)));
  for (const m of managers) {
    // Propriétaire : toujours autorisé (invariant anti-verrouillage 1.5).
    // Sinon, le rôle doit porter la permission de supervision.
    const estAutorise =
      m.role === 'PROPRIETAIRE' || (await permissionsDuRole(m.role_id)).has(PERMISSION_SUPERVISION);
    if (!estAutorise) continue;
    if (m.verrou_jusqua && m.verrou_jusqua.getTime() > Date.now()) continue;
    if (await argon2.verify(m.pin_hash, pin)) return m;
  }
  await db.transaction(async (tx) => {
    await journaliser(tx, {
      action: 'ECHEC_PIN',
      entite: 'utilisateurs',
      meta: { contexte, type: 'PIN_MANAGER' },
    });
  });
  throw new ErreurMetier('PIN manager incorrect', 403);
}
