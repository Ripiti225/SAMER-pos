import { formatFCFA } from '@pos/shared';
import { jourCourt } from '../periode';

interface Point {
  jour: string;
  ca: number;
}

/**
 * Tendance du chiffre d'affaires du GROUPE, un rectangle par jour.
 *
 * **Une seule série**, volontairement : sept lignes superposées demanderaient
 * une palette catégorielle de sept teintes validée pour le daltonisme, et
 * DESIGN_V2 n'en définit pas — le détail par restaurant est juste en dessous,
 * en clair, dans le tableau. Une série unique n'a donc pas de légende : le
 * titre la nomme.
 *
 * Le remplissage est `--marque`. Les CHIFFRES, eux, portent les jetons de
 * texte et jamais la couleur de la série : `--marque` sur fond clair tombe à
 * ~2:1 de contraste (DESIGN_V2 § 3.3), illisible en texte.
 */
export function Tendance({ points }: { points: Point[] }) {
  // Un seul jour ne fait pas une tendance : on n'affiche rien plutôt qu'une
  // barre solitaire qui prétendrait montrer une évolution.
  if (points.length < 2) return null;

  const L = 720;
  const H = 190;
  const margeBas = 26;
  const margeHaut = 14;
  const hauteurUtile = H - margeBas - margeHaut;

  const max = Math.max(...points.map((p) => p.ca), 1);
  const pas = L / points.length;
  // Marque fine + 2 px de fond entre deux barres voisines (jamais collées).
  const largeur = Math.max(3, Math.min(pas - 2, 46));
  // `max` est borné à 1 pour la division : sur une période entièrement à zéro,
  // `findIndex` rend -1 et aucune barre n'est désignée « meilleur jour ».
  const indexMax = points.findIndex((p) => p.ca === max);

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${L} ${H}`} width="100%" height="190" role="img" aria-label="Chiffre d’affaires du groupe, jour par jour" className="overflow-visible">
        {/* Ligne de base seule : une grille complète concurrencerait les barres. */}
        <line x1="0" y1={H - margeBas} x2={L} y2={H - margeBas} stroke="var(--filet)" strokeWidth="1" />

        {points.map((p, i) => {
          const h = Math.max(2, (p.ca / max) * hauteurUtile);
          const x = i * pas + (pas - largeur) / 2;
          const y = H - margeBas - h;
          return (
            <g key={p.jour}>
              {/* Bout arrondi côté valeur, pied posé sur la ligne de base. */}
              <rect x={x} y={y} width={largeur} height={h} rx="4" fill="var(--marque)" opacity={i === indexMax ? 1 : 0.72}>
                <title>{`${jourCourt(p.jour)} — ${formatFCFA(p.ca)}`}</title>
              </rect>
              {/* Étiquette directe sur le SEUL meilleur jour, pas sur chaque barre. */}
              {i === indexMax && (
                <text x={x + largeur / 2} y={y - 5} textAnchor="middle" fontSize="11.5" fontWeight="700" fill="var(--txt)">
                  {formatFCFA(p.ca)}
                </text>
              )}
              {/* Axe des jours : un repère sur cinq quand la période est longue. */}
              {(points.length <= 10 || i % Math.ceil(points.length / 8) === 0) && (
                <text x={x + largeur / 2} y={H - 8} textAnchor="middle" fontSize="10.5" fill="var(--txt-faible)">
                  {new Date(p.jour).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' })}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}
