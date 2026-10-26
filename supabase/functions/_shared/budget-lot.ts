/**
 * Budget de temps d'un appel sync-push.
 *
 * Le POS abandonne un appel au bout de 15 s (`TIMEOUT_MS` de cloud-client.ts).
 * Les lignes sont appliquées une par une (acquittement contigu) : un lot plein
 * de 200 lignes prenait ~15 s côté cloud. Le cloud finissait le travail, mais
 * la caisse avait déjà raccroché — « le cloud ne répond pas » — et renvoyait le
 * MÊME lot, indéfiniment (Angré 7E, 2026-10-22 : seq figé à 248 682 toute la
 * journée, ventes du jour absentes du siège).
 *
 * Au-delà du budget, on rend la main avec ce qui est fait : le POS marque le
 * préfixe acquitté et enchaîne aussitôt le lot suivant.
 */
export const BUDGET_LOT_MS = 8_000;

export function doitRendreLaMain(debutMs: number, maintenantMs: number, lignesTraitees: number): boolean {
  // Au moins une ligne par appel : sans quoi une seule ligne lente gèlerait la file.
  if (lignesTraitees === 0) return false;
  return maintenantMs - debutMs >= BUDGET_LOT_MS;
}
