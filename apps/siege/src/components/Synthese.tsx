import { synthese } from '../comparaison';
import type { VueBord } from '../bord';

/**
 * La bande de verdict, en tête des deux colonnes. C'est ce qu'on lit en
 * premier, et sur un écran étroit c'est parfois tout ce qu'on lit : elle doit
 * se suffire à elle-même.
 */
export function Synthese({ a, b }: { a: VueBord; b: VueBord }) {
  const { phrase, lignes } = synthese(a, b);
  if (!phrase) return null;

  return (
    <section className="rounded-jeton border-l-4 border-marque bg-carte p-4 shadow-e1">
      <p className="text-[15px] font-semibold">{phrase}</p>
      {lignes.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
          {lignes.map((l) => (
            <li key={l.cle} className="text-sm text-doux">
              {l.libelle}{' '}
              <span className={`chiffres font-semibold ${l.favorable ? 'text-ok-txt' : 'text-alerte-txt'}`}>
                {(l.pourcentage ?? 0) > 0 ? '▲' : '▼'} {Math.abs(l.pourcentage ?? 0)} %
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
