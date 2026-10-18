import type { RestoGroupe } from '../api';

export type ModeComparaison = 'restaurants' | 'periodes';

/**
 * Le mode et les deux termes. Les modes sont STRICTS : en « 2 restaurants »
 * il n'y a qu'une période, en « 2 périodes » qu'un restaurant. Faire varier
 * les deux à la fois n'explique rien — si Angré/octobre bat Riviera/novembre,
 * on ne sait pas si c'est le restaurant ou le mois.
 */
export function BarreComparaison({
  mode,
  onMode,
  restaurants,
  a,
  b,
  onA,
  onB,
  libellePeriodeA,
  libellePeriodeB,
  nbJours,
  joursDecalage = null,
}: {
  mode: ModeComparaison;
  onMode: (m: ModeComparaison) => void;
  restaurants: RestoGroupe[];
  /** `samtrackly_id` du terme A, '' pour « Tous les restaurants ». En
   *  « 2 périodes », c'est le seul restaurant regardé : les deux colonnes le
   *  partagent. */
  a: string;
  b: string;
  onA: (v: string) => void;
  onB: (v: string) => void;
  libellePeriodeA: string;
  libellePeriodeB: string;
  /** Nombre de jours couverts par A — et donc par B. Écrit à l'écran : sans lui,
   *  « Ce mois-ci » un 25 septembre se lirait comme le mois d'août entier. */
  nbJours: number;
  /** Plage horaire (08:24 → 16:18) : B est la même plage, ce nombre de jours
   *  plus tôt. `null` pour des jours entiers. */
  joursDecalage?: number | null;
}) {
  const assezDeRestaurants = restaurants.length >= 2;
  const classeTerme = 'flex items-center gap-2 text-sm font-semibold text-doux';

  const bouton = (m: ModeComparaison, libelle: string, actif: boolean, desactive = false) => (
    <button
      type="button"
      disabled={desactive}
      onClick={() => onMode(m)}
      className={`min-h-[40px] rounded-btn border px-4 text-sm font-semibold transition ${
        actif ? 'border-marque bg-marque text-sur-marque' : 'border-filet bg-carte text-doux hover:border-marque'
      } ${desactive ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      {libelle}
    </button>
  );

  /**
   * Un sélecteur de restaurant. `exclure` retire le terme d'en face — et avec
   * lui « Tous les restaurants » quand c'est LUI qui est en face : comparer le
   * groupe entier au groupe entier n'apprendrait rien. Sans `exclure`, rien
   * n'est retiré : c'est le cas du mode « 2 périodes », où il n'y a qu'un
   * restaurant et donc aucun terme d'en face.
   */
  const choix = (valeur: string, onChoisir: (v: string) => void, exclure?: string) => (
    <select
      className="champ !min-h-[40px] !w-auto !py-0 !text-[15px]"
      value={valeur}
      onChange={(e) => onChoisir(e.target.value)}
    >
      {exclure !== '' && <option value="">Tous les restaurants</option>}
      {restaurants
        .filter((r) => r.samtrackly_id !== exclure)
        .map((r) => (
          <option key={r.samtrackly_id} value={r.samtrackly_id}>
            {r.nom}
            {r.enrole ? '' : ' (non enrôlé)'}
          </option>
        ))}
    </select>
  );

  return (
    <section className="rounded-jeton border border-filet bg-carte-douce p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-bold uppercase tracking-wide text-faible">Comparer</span>
        {bouton('restaurants', '2 restaurants', mode === 'restaurants', !assezDeRestaurants)}
        {bouton('periodes', '2 périodes', mode === 'periodes')}
        {!assezDeRestaurants && (
          <span className="text-xs text-faible">Il faut au moins deux restaurants pour les comparer.</span>
        )}
      </div>

      {/* Le restaurant regardé en « 2 périodes ». Le filtre global est masqué
          pendant la comparaison : sans ce sélecteur, le mode resterait collé
          au restaurant choisi avant d'entrer, sans moyen d'en changer. */}
      {mode === 'periodes' && (
        <label className={`mt-3 ${classeTerme}`}>
          Restaurant
          {choix(a, onA)}
        </label>
      )}

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {mode === 'restaurants' ? (
          <label className={classeTerme}>A{choix(a, onA, b)}</label>
        ) : (
          <div className={classeTerme}>
            A <span className="chiffres font-normal text-txt">{libellePeriodeA}</span>
          </div>
        )}
        {mode === 'restaurants' ? (
          <label className={classeTerme}>B{choix(b, onB, a)}</label>
        ) : (
          <div className={classeTerme}>
            B <span className="chiffres font-normal text-txt">{libellePeriodeB}</span>
          </div>
        )}
      </div>

      {mode === 'periodes' && joursDecalage !== null && (
        <p className="mt-2 text-xs text-faible">
          <b>
            La même plage horaire, {joursDecalage === 1 ? 'la veille' : `${joursDecalage} jours plus tôt`}.
          </b>{' '}
          B n’est pas choisie : comparer 08:24 → 16:18 à la nuit qui le précède ne voudrait rien dire. On reprend
          donc les mêmes heures, décalées de jours entiers.
        </p>
      )}
      {mode === 'periodes' && joursDecalage === null && (
        <p className="mt-2 text-xs text-faible">
          <b>
            {nbJours === 1 ? '1 jour contre le précédent' : `${nbJours} jours contre les ${nbJours} précédents`}.
          </b>{' '}
          B n’est pas choisie : c’est la même durée, juste avant A — sans quoi le pourcentage d’écart ne voudrait
          rien dire. Une période en cours (« Ce mois-ci » un 25 du mois) ne couvre donc PAS le mois précédent
          entier, et ne le prétend pas.
        </p>
      )}
    </section>
  );
}
