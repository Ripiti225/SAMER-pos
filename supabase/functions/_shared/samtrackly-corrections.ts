// ──────────────────────────────────────────────────────────────────────────────
// Corrections du stock initial : conversion cloud POS → SamerTrackly.
//
// Aucun calcul d'argent ici : il est côté SamerTrackly, dans
// `transmettre_correction_stock_initial`, qui ignore une correction déjà connue.
// Rejouer un transfert ne peut donc ni facturer deux fois, ni effacer une décision.
// ──────────────────────────────────────────────────────────────────────────────

export interface CorrectionCloud {
  id: string;
  produit_code: string;
  produit_nom: string;
  produit_prix: string | number;
  stock_reporte: string | number;
  stock_apres: string | number;
  explication: string;
  statut: string;
  service_sortant_id: string | null;
  caissier_sortant_id: string | null;
  saisi_par: string;
  shift_intermediaire_debloque: boolean;
}

export interface ContexteCorrections {
  posServiceId: string;
  restaurantId: string;
  caissierPlaceNom: string | null;
  /** Noms par id d'utilisateur POS : auteurs et caissiers sortants. */
  noms: Map<string, string | null>;
}

export function construireCorrectionsSamtrackly(corrections: CorrectionCloud[], ctx: ContexteCorrections) {
  return corrections
    .filter((c) => c.statut !== 'REMPLACEE')
    .map((c) => ({
      pos_correction_id: c.id,
      restaurant_id: ctx.restaurantId,
      pos_service_place_id: ctx.posServiceId,
      pos_service_sortant_id: c.service_sortant_id,
      produit_id: c.produit_code,
      produit_nom: c.produit_nom,
      prix: Number(c.produit_prix),
      stock_reporte: Number(c.stock_reporte),
      stock_corrige: Number(c.stock_apres),
      explication: c.explication,
      statut_pos: c.statut,
      shift_intermediaire_debloque: c.shift_intermediaire_debloque,
      caissier_place_nom: ctx.caissierPlaceNom,
      caissier_sortant_nom: c.caissier_sortant_id ? ctx.noms.get(c.caissier_sortant_id) ?? null : null,
      saisi_par_nom: ctx.noms.get(c.saisi_par) ?? null,
    }));
}
