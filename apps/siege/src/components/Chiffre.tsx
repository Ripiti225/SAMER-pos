import { useEffect, useRef, useState } from 'react';

/**
 * Un nombre qui ROULE jusqu'à sa valeur (DESIGN_V2 § 5) plutôt que de sauter.
 * 400 ms, easeOutCubic. `prefers-reduced-motion` coupe l'animation — la valeur
 * s'affiche directement, elle ne disparaît jamais.
 */
export function useNombreRoulant(cible: number, duree = 400): number {
  const [valeur, setValeur] = useState(cible);
  const depart = useRef(cible);
  const debut = useRef(0);

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setValeur(cible);
      return;
    }
    depart.current = valeur;
    debut.current = performance.now();
    let brut = 0;
    const pas = (t: number) => {
      const avance = Math.min(1, (t - debut.current) / duree);
      const eleve = 1 - Math.pow(1 - avance, 3); // easeOutCubic
      setValeur(Math.round(depart.current + (cible - depart.current) * eleve));
      if (avance < 1) brut = requestAnimationFrame(pas);
    };
    brut = requestAnimationFrame(pas);
    return () => cancelAnimationFrame(brut);
    // `valeur` volontairement hors des dépendances : on part d'où on est.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cible, duree]);

  return valeur;
}

/**
 * Tuile de chiffre d'appel — la couche lisible de loin.
 *
 * La variation est donnée en POURCENTAGE et en couleur, mais la couleur ne
 * porte jamais l'information seule : la flèche et le signe la redisent, pour
 * qui ne distingue pas le vert du rouge.
 */
export function TuileChiffre({
  libelle,
  valeur,
  detail,
  precedent,
  format,
  ton = 'neutre',
}: {
  libelle: string;
  valeur: number;
  detail?: string;
  precedent?: number;
  format: (n: number) => string;
  /** `alerte` inverse la lecture : ici, monter est une mauvaise nouvelle. */
  ton?: 'neutre' | 'marque' | 'alerte';
}) {
  const anime = useNombreRoulant(valeur);
  const variation =
    precedent !== undefined && precedent > 0 ? Math.round(((valeur - precedent) / precedent) * 100) : null;
  const monte = (variation ?? 0) > 0;
  const bon = ton === 'alerte' ? !monte : monte;

  return (
    <div className="rounded-jeton border border-filet bg-carte p-4 shadow-e1">
      <p className="truncate text-[11.5px] font-semibold uppercase tracking-wide text-faible">{libelle}</p>
      <p
        className={`chiffres mt-1 text-[30px] font-bold leading-none ${
          ton === 'marque' ? 'text-marque-sur-plan' : 'text-txt'
        }`}
      >
        {format(anime)}
      </p>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-xs">
        {detail && <span className="text-doux">{detail}</span>}
        {variation !== null && variation !== 0 && (
          <span className={`chiffres font-semibold ${bon ? 'text-ok-txt' : 'text-alerte-txt'}`}>
            {monte ? '▲' : '▼'} {Math.abs(variation)} %
          </span>
        )}
        {variation === 0 && <span className="chiffres text-faible">= stable</span>}
      </div>
    </div>
  );
}
