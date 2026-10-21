/**
 * Écran « Clients du mois » — ce que la console calcule elle-même : la liste
 * des mois proposés et les libellés. Le classement et le tirage, eux, sont
 * faits par la fonction `siege` (`_shared/siege-tirage.ts`) : la console
 * n'affiche que ce qu'elle reçoit.
 */

/** « 2026-10 » du mois qui contient `date` (UTC : Abidjan est à UTC+0). */
export function cleMois(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Les `n` derniers mois, du plus récent au plus ancien, mois en cours compris.
 *
 * Le mois en cours reste proposé pour suivre le classement pendant le mois ;
 * c'est la fonction qui refuse de le tirer au sort avant le 1er suivant.
 */
export function moisRecents(maintenant: Date, n = 12): string[] {
  const annee = maintenant.getUTCFullYear();
  const mois = maintenant.getUTCMonth();
  return Array.from({ length: n }, (_, i) => cleMois(new Date(Date.UTC(annee, mois - i, 1))));
}

/**
 * Le mois choisi à l'ouverture : le dernier mois TERMINÉ. C'est celui qu'on
 * vient tirer au sort, en début de mois.
 */
export function moisParDefaut(maintenant: Date): string {
  return moisRecents(maintenant, 2)[1]!;
}

/** « octobre 2026 » */
export function libelleMois(mois: string): string {
  const [a, m] = mois.split('-').map(Number);
  if (!a || !m) return mois;
  return new Date(Date.UTC(a, m - 1, 1)).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** « 2026-10-01 » (colonne DATE du tirage) → « 2026-10 ». */
export function moisDeDate(premierJour: string): string {
  return premierJour.slice(0, 7);
}

/**
 * Comment désigner un client : son nom s'il l'a donné à la caisse, sinon son
 * téléphone — un client sans nom peut gagner, le gérant l'appellera.
 */
export function libelleClient(c: { nom: string | null; telephone: string }): string {
  return c.nom?.trim() || c.telephone;
}
