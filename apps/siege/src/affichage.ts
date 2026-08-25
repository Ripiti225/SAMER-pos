/**
 * Mode d'affichage clair / sombre.
 *
 * Le thème bascule sur l'attribut `data-mode` de la racine (et non
 * `data-theme` : voir DESIGN_V2 § 3.3). Le choix appartient au NAVIGATEUR de la
 * personne — la console n'a pas de `parametres_locaux` comme un poste de caisse,
 * et le siège se regarde depuis plusieurs machines.
 */
const CLE = 'siege.mode';

export type Mode = 'clair' | 'sombre';

export function modeInitial(): Mode {
  try {
    const enregistre = localStorage.getItem(CLE);
    if (enregistre === 'clair' || enregistre === 'sombre') return enregistre;
  } catch {
    // Navigation privée, stockage bloqué : on retombe sur le réglage système.
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'sombre' : 'clair';
}

export function poserMode(mode: Mode): void {
  if (mode === 'sombre') document.documentElement.setAttribute('data-mode', 'sombre');
  else document.documentElement.removeAttribute('data-mode');
  try {
    localStorage.setItem(CLE, mode);
  } catch {
    // Sans stockage, le choix vaut pour la session en cours. Suffisant.
  }
}
