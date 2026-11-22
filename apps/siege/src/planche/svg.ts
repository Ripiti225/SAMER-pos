// Tracés de découpe seuls, en SVG, une feuille par fichier (brief PROMO § 7.5).
// Solution de secours si le traceur ne lit pas le calque CutContour du PDF :
// mêmes positions, au millimètre, sur une feuille de même taille.
import { grille, position, type Reglages } from './reglages';

const f = (n: number) => String(Math.round(n * 1000) / 1000);

export function svgDecoupe(r: Reglages, nombre: number): string {
  const { grille: g } = grille(r);
  const traces: string[] = [];
  for (let i = 0; i < nombre; i++) {
    const { x, y } = position(r, g, i);
    traces.push(
      `  <rect x="${f(x)}" y="${f(y)}" width="${f(r.autocollantL)}" height="${f(r.autocollantH)}" rx="${f(r.rayon)}" ry="${f(r.rayon)}"/>`,
    );
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f(r.feuilleL)}mm" height="${f(r.feuilleH)}mm" viewBox="0 0 ${f(r.feuilleL)} ${f(r.feuilleH)}">`,
    '<g id="CutContour" fill="none" stroke="#EC008C" stroke-width="0.25">',
    ...traces,
    '</g>',
    '</svg>',
    '',
  ].join('\n');
}
