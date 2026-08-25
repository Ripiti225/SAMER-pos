import { useState } from 'react';
import { formatFCFA } from '@pos/shared';

/** Les huit créneaux de la palette catégorielle, dans l'ORDRE validé. */
export const SERIES = [
  'var(--serie-1)', 'var(--serie-2)', 'var(--serie-3)', 'var(--serie-4)',
  'var(--serie-5)', 'var(--serie-6)', 'var(--serie-7)', 'var(--serie-8)',
] as const;

/**
 * Couleur d'une série. L'index vient de la position du restaurant dans une
 * liste STABLE, jamais de son rang : un filtre qui change le nombre de séries
 * ne doit pas repeindre les survivants.
 */
export const couleurSerie = (i: number): string => SERIES[i % SERIES.length]!;

export interface Serie {
  cle: string;
  libelle: string;
  couleur: string;
}

/** Légende — TOUJOURS présente dès deux séries : trois teintes de la palette
 *  passent sous 3:1 sur leur fond, l'identité ne peut pas reposer sur la
 *  couleur seule (règle de secours du validateur). */
export function Legende({ series }: { series: Serie[] }) {
  if (series.length < 2) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
      {series.map((s) => (
        <span key={s.cle} className="flex items-center gap-1.5 text-xs text-doux">
          <span className="h-2.5 w-2.5 flex-none rounded-sm" style={{ background: s.couleur }} />
          {s.libelle}
        </span>
      ))}
    </div>
  );
}

interface PointEmpile {
  cle: string;
  libelle: string;
  valeurs: Record<string, number>;
}

/**
 * Barres EMPILÉES dans le temps — une pile par jour, un segment par restaurant.
 *
 * Empilées et non groupées : trente jours × sept restaurants font 210 barres
 * larges de deux pixels, illisibles. Empilé, on lit le total du groupe ET sa
 * composition d'un coup, ce qui est la question posée.
 *
 * 2 px de fond entre deux segments (jamais collés), bout arrondi sur le segment
 * du haut seulement, ligne de base plutôt qu'une grille.
 */
export function BarresEmpilees({
  points,
  series,
  hauteur = 210,
}: {
  points: PointEmpile[];
  series: Serie[];
  hauteur?: number;
}) {
  const [survol, setSurvol] = useState<string | null>(null);
  if (points.length === 0) return <p className="py-6 text-center text-faible">Aucune vente sur cette période.</p>;

  const L = 900;
  const margeBas = 24;
  const margeHaut = 12;
  const utile = hauteur - margeBas - margeHaut;
  const totaux = points.map((p) => series.reduce((s, se) => s + (p.valeurs[se.cle] ?? 0), 0));
  const max = Math.max(...totaux, 1);
  const pas = L / points.length;
  const largeur = Math.max(3, Math.min(pas - 3, 54));
  const pointSurvole = points.find((p) => p.cle === survol);

  return (
    <figure className="relative m-0">
      <svg viewBox={`0 0 ${L} ${hauteur}`} width="100%" height={hauteur} role="img" aria-label="Chiffre d’affaires par jour et par restaurant">
        <line x1="0" y1={hauteur - margeBas} x2={L} y2={hauteur - margeBas} stroke="var(--filet)" strokeWidth="1" />
        {points.map((p, i) => {
          const x = i * pas + (pas - largeur) / 2;
          let y = hauteur - margeBas;
          const total = totaux[i] ?? 0;
          const segments = series
            .map((se) => ({ se, v: p.valeurs[se.cle] ?? 0 }))
            .filter((s) => s.v > 0);
          return (
            <g key={p.cle} onMouseEnter={() => setSurvol(p.cle)} onMouseLeave={() => setSurvol(null)}>
              {/* Cible de survol pleine hauteur : viser un segment de 3 px à la
                  souris est impossible. */}
              <rect x={i * pas} y={0} width={pas} height={hauteur} fill="transparent" />
              {segments.map(({ se, v }, k) => {
                const h = Math.max(1, (v / max) * utile);
                y -= h;
                const dernier = k === segments.length - 1;
                return (
                  <rect
                    key={se.cle}
                    x={x}
                    y={y}
                    width={largeur}
                    height={Math.max(1, h - (dernier ? 0 : 2))}
                    rx={dernier ? 4 : 0}
                    fill={se.couleur}
                    opacity={survol && survol !== p.cle ? 0.4 : 1}
                  />
                );
              })}
              {(points.length <= 12 || i % Math.ceil(points.length / 10) === 0) && (
                <text x={x + largeur / 2} y={hauteur - 7} textAnchor="middle" fontSize="10.5" fill="var(--txt-faible)">
                  {p.libelle}
                </text>
              )}
              {total === 0 && (
                <text x={x + largeur / 2} y={hauteur - margeBas - 4} textAnchor="middle" fontSize="10" fill="var(--txt-faible)">
                  0
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Infobulle : le détail au survol, plutôt qu'un nombre sur chaque pile. */}
      {pointSurvole && (
        <div className="pointer-events-none absolute right-0 top-0 rounded-jeton border border-filet bg-carte px-3 py-2 text-xs shadow-e2">
          <div className="mb-1 font-bold">{pointSurvole.libelle}</div>
          {series
            .filter((se) => (pointSurvole.valeurs[se.cle] ?? 0) > 0)
            .sort((a, b) => (pointSurvole.valeurs[b.cle] ?? 0) - (pointSurvole.valeurs[a.cle] ?? 0))
            .map((se) => (
              <div key={se.cle} className="flex items-center gap-2">
                <span className="h-2 w-2 flex-none rounded-sm" style={{ background: se.couleur }} />
                <span className="flex-1 truncate text-doux">{se.libelle}</span>
                <span className="chiffres font-semibold">{formatFCFA(pointSurvole.valeurs[se.cle] ?? 0)}</span>
              </div>
            ))}
        </div>
      )}
      <Legende series={series} />
    </figure>
  );
}

/**
 * Barres par heure — le graphe qui dit quand renforcer l'équipe.
 *
 * Une seule série (le groupe, ou le restaurant filtré) : superposer sept
 * restaurants sur 24 heures donnerait une bouillie. L'heure de pointe est en
 * aplat plein et porte son étiquette ; les autres sont en retrait.
 */
export function BarresHeures({ heures }: { heures: { heure: number; ca: number; nb: number }[] }) {
  if (heures.length === 0) return <p className="py-6 text-center text-faible">Aucune vente sur cette période.</p>;

  const L = 900;
  const H = 170;
  const margeBas = 22;
  const utile = H - margeBas - 18;
  // Les heures réellement travaillées, pas 0h→23h : un restaurant qui ouvre à
  // 10h n'a pas à montrer dix colonnes vides.
  const min = Math.min(...heures.map((h) => h.heure));
  const max = Math.max(...heures.map((h) => h.heure));
  const plage = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  const parHeure = new Map(heures.map((h) => [h.heure, h]));
  const caMax = Math.max(...heures.map((h) => h.ca), 1);
  const pointe = heures.reduce((a, b) => (b.ca > a.ca ? b : a));
  const pas = L / plage.length;
  const largeur = Math.max(4, Math.min(pas - 4, 44));

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${L} ${H}`} width="100%" height={H} role="img" aria-label="Chiffre d’affaires par heure">
        <line x1="0" y1={H - margeBas} x2={L} y2={H - margeBas} stroke="var(--filet)" strokeWidth="1" />
        {plage.map((h, i) => {
          const d = parHeure.get(h);
          const ca = d?.ca ?? 0;
          const haut = Math.max(2, (ca / caMax) * utile);
          const x = i * pas + (pas - largeur) / 2;
          const y = H - margeBas - haut;
          const estPointe = h === pointe.heure;
          return (
            <g key={h}>
              <rect x={x} y={y} width={largeur} height={haut} rx="4" fill="var(--marque)" opacity={estPointe ? 1 : 0.45}>
                <title>{`${String(h).padStart(2, '0')} h — ${formatFCFA(ca)} · ${d?.nb ?? 0} commande(s)`}</title>
              </rect>
              {estPointe && (
                <text x={x + largeur / 2} y={y - 5} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--txt)">
                  {formatFCFA(ca)}
                </text>
              )}
              <text x={x + largeur / 2} y={H - 6} textAnchor="middle" fontSize="10.5" fill="var(--txt-faible)">
                {String(h).padStart(2, '0')}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="mt-1 text-xs text-faible">
        Heure de pointe : <b className="text-doux">{String(pointe.heure).padStart(2, '0')} h</b> ·{' '}
        {pointe.nb} commande(s) · {formatFCFA(pointe.ca)}
      </p>
    </figure>
  );
}

/**
 * Liste de barres horizontales — la forme de comparaison la plus lisible quand
 * les libellés sont des mots (restaurants, plats, tables, opérateurs).
 * Le libellé et la valeur sont toujours écrits : la barre ordonne, elle ne
 * porte jamais l'information seule.
 */
export function BarresHorizontales({
  lignes,
  format = formatFCFA,
  couleur = 'var(--marque)',
  max: maxImpose,
  vide = 'Rien à afficher sur cette période.',
}: {
  lignes: { cle: string; libelle: string; valeur: number; detail?: string; couleur?: string }[];
  format?: (n: number) => string;
  couleur?: string;
  max?: number;
  vide?: string;
}) {
  if (lignes.length === 0) return <p className="py-4 text-center text-faible">{vide}</p>;
  const max = maxImpose ?? Math.max(...lignes.map((l) => Math.abs(l.valeur)), 1);

  return (
    <div className="space-y-2">
      {lignes.map((l) => (
        <div key={l.cle}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">
              {l.libelle}
              {l.detail && <span className="ml-1.5 text-xs text-faible">{l.detail}</span>}
            </span>
            <span className="chiffres flex-none font-semibold">{format(l.valeur)}</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-sm bg-carte-douce">
            <div
              className="h-full rounded-sm transition-[width] duration-500 ease-fluide"
              style={{ width: `${(Math.abs(l.valeur) / max) * 100}%`, background: l.couleur ?? couleur }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Barres DIVERGENTES autour de zéro — pour les écarts de caisse, où le signe
 * est l'information. Vert d'un côté, rouge de l'autre : jetons sémantiques
 * existants, pas la palette catégorielle (un écart n'est pas une catégorie).
 */
export function BarresEcarts({ lignes }: { lignes: { cle: string; libelle: string; valeur: number; detail?: string }[] }) {
  if (lignes.length === 0) return <p className="py-4 text-center text-faible">Aucune clôture sur cette période.</p>;
  const max = Math.max(...lignes.map((l) => Math.abs(l.valeur)), 1);

  return (
    <div className="space-y-2">
      {lignes.map((l) => {
        const part = (Math.abs(l.valeur) / max) * 50;
        const negatif = l.valeur < 0;
        return (
          <div key={l.cle}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">
                {l.libelle}
                {l.detail && <span className="ml-1.5 text-xs text-faible">{l.detail}</span>}
              </span>
              <span className={`chiffres flex-none font-semibold ${negatif ? 'text-alerte-txt' : 'text-ok-txt'}`}>
                {l.valeur > 0 ? '+' : ''}
                {formatFCFA(l.valeur)}
              </span>
            </div>
            <div className="relative mt-1 h-2 rounded-sm bg-carte-douce">
              <span className="absolute left-1/2 top-0 h-full w-px bg-filet-fort" />
              <div
                className="absolute top-0 h-full rounded-sm"
                style={{
                  width: `${part}%`,
                  [negatif ? 'right' : 'left']: '50%',
                  background: negatif ? 'var(--alerte)' : 'var(--ok)',
                }}
              />
            </div>
          </div>
        );
      })}
      <p className="pt-1 text-xs text-faible">
        Manquant à gauche, excédent à droite. Le trait central est le zéro.
      </p>
    </div>
  );
}
