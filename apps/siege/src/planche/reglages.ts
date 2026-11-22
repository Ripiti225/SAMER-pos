// Mise en page d'une planche de vinyle autocollant (brief PROMO § 7.5).
// Toutes les mesures en millimètres, origine en haut à gauche de la feuille.

export interface Reglages {
  feuilleL: number;
  feuilleH: number;
  autocollantL: number;
  autocollantH: number;
  /** Débord de couleur autour du trait de coupe. */
  fondPerdu: number;
  /** Espace entre deux traits de coupe voisins. */
  ecart: number;
  /** Bord vide de la feuille, laissé aux repères de l'imprimeur. */
  marge: number;
  /** Rayon des coins arrondis du trait de coupe. */
  rayon: number;
}

/** Feuille 1 m², autocollant 85 × 55 : 10 colonnes × 16 rangées = 160. */
export const REGLAGES_PAR_DEFAUT: Reglages = {
  feuilleL: 1000,
  feuilleH: 1000,
  autocollantL: 85,
  autocollantH: 55,
  fondPerdu: 2,
  ecart: 4,
  marge: 20,
  rayon: 3,
};

export interface Grille {
  colonnes: number;
  rangees: number;
  parFeuille: number;
}

/** Combien d'autocollants tiennent, et ce qui empêcherait d'imprimer. */
export function grille(r: Reglages): { grille: Grille; erreurs: string[] } {
  const erreurs: string[] = [];
  for (const [cle, v] of Object.entries(r)) {
    if (!Number.isFinite(v) || v < 0) erreurs.push(`Valeur invalide : ${cle}`);
  }
  if (r.autocollantL <= 0 || r.autocollantH <= 0) erreurs.push('L’autocollant doit avoir une taille');
  // Deux fonds perdus voisins ne doivent pas se chevaucher : la couleur de
  // l'un déborderait sur l'autre après la coupe.
  if (r.ecart < 2 * r.fondPerdu) erreurs.push(`L’écart doit valoir au moins deux fonds perdus (${2 * r.fondPerdu} mm)`);
  if (r.rayon * 2 > Math.min(r.autocollantL, r.autocollantH)) erreurs.push('Rayon des coins trop grand pour l’autocollant');

  const place = (feuille: number, cote: number) =>
    cote > 0 ? Math.max(0, Math.floor((feuille - 2 * r.marge + r.ecart) / (cote + r.ecart))) : 0;
  const colonnes = place(r.feuilleL, r.autocollantL);
  const rangees = place(r.feuilleH, r.autocollantH);
  if (erreurs.length === 0 && colonnes * rangees === 0) erreurs.push('Aucun autocollant ne tient sur la feuille avec ces réglages');
  return { grille: { colonnes, rangees, parFeuille: colonnes * rangees }, erreurs };
}

/** Coin haut-gauche du trait de coupe du n-ième autocollant d'une feuille. */
export function position(r: Reglages, g: Grille, index: number): { x: number; y: number } {
  const colonne = index % g.colonnes;
  const rangee = Math.floor(index / g.colonnes);
  return {
    x: r.marge + colonne * (r.autocollantL + r.ecart),
    y: r.marge + rangee * (r.autocollantH + r.ecart),
  };
}

/** Les codes répartis par feuille ; la dernière n'a pas d'emplacement vide. */
export function parFeuille<T>(elements: T[], g: Grille): T[][] {
  const feuilles: T[][] = [];
  for (let i = 0; i < elements.length; i += g.parFeuille) feuilles.push(elements.slice(i, i + g.parFeuille));
  return feuilles;
}
