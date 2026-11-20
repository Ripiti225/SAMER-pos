/**
 * Statut d'un code promo carte TEL QUE LA CAISSE LE VOIT (brief PROMO § 2 et § 5).
 *
 * Le cloud est maître de ses colonnes (`statut`, réécrit à chaque descente) ;
 * la caisse tient les siennes (`local_statut`), que la descente ne touche
 * jamais. Le statut qui compte combine les deux, et ne recule donc jamais : un
 * code encaissé ici pendant une coupure reste UTILISE même si le cloud, qui ne
 * le sait pas encore, le dit DISPONIBLE.
 *
 * Ordre : DISPONIBLE < RESERVE < UTILISE. ANNULE (lot annulé au siège)
 * l'emporte sur tout… sauf sur une utilisation déjà faite : la vente a eu lieu.
 */
export type StatutCloud = 'DISPONIBLE' | 'RESERVE' | 'UTILISE' | 'ANNULE';
export type StatutLocal = 'RESERVE' | 'UTILISE' | null;

export function statutEffectif(cloud: StatutCloud, local: StatutLocal): StatutCloud {
  if (local === 'UTILISE' || cloud === 'UTILISE') return 'UTILISE';
  if (cloud === 'ANNULE') return 'ANNULE';
  if (local === 'RESERVE' || cloud === 'RESERVE') return 'RESERVE';
  return 'DISPONIBLE';
}
