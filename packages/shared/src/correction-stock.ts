/**
 * Correction du stock initial : la formule que l'écran montre et que le serveur
 * applique. On ne soustrait jamais la correction de l'écart du sortant : on le
 * recalcule, sinon un surplus annulé deviendrait un faux manquant.
 */
export const DELAI_CORRECTION_STOCK_MS = 60 * 60 * 1000;

export type StatutCorrectionStock =
  | 'SANS_LITIGE'
  | 'A_VALIDER'
  | 'RECONNUE_SORTANT'
  | 'VALIDEE_MANAGER'
  | 'REMPLACEE';

const LIBELLES_STATUT_CORRECTION: Record<StatutCorrectionStock, string> = {
  SANS_LITIGE: 'Aucun litige',
  A_VALIDER: 'À décider',
  RECONNUE_SORTANT: 'Reconnu par le sortant',
  VALIDEE_MANAGER: 'Validé par un manager',
  REMPLACEE: 'Remplacée',
};

export const libelleStatutCorrection = (statut: string): string =>
  LIBELLES_STATUT_CORRECTION[statut as StatutCorrectionStock] ?? statut;

export interface LigneSortantCorrection {
  stock_initial: number;
  entrees: number;
  sorties: number;
  stock_compte: number;
  quantite_expliquee: number;
}

const arrondi = (n: number): number => Math.round(n * 100) / 100;

export function effetCorrectionSortant(ligne: LigneSortantCorrection, stockCorrige: number) {
  const theorique = arrondi(ligne.stock_initial + ligne.entrees - ligne.sorties);
  const ecart_avant = arrondi(ligne.stock_compte - theorique);
  const ecart_apres = arrondi(stockCorrige - theorique);
  // Seule une explication de MANQUANT excuse un manquant : « livraison non
  // saisie » sur un surplus n'explique pas les poulets qui manquent ensuite.
  const expliquee = ecart_avant < 0 ? ligne.quantite_expliquee : 0;
  const manque = (ecart: number): number => arrondi(Math.max(0, -ecart - expliquee));
  const manque_avant = manque(ecart_avant);
  const manque_apres = manque(ecart_apres);
  return {
    theorique,
    ecart_avant,
    ecart_apres,
    manque_avant,
    manque_apres,
    litige: manque_apres > manque_avant,
  };
}
