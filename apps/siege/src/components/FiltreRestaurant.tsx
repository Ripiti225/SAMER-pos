import type { RestoGroupe } from '../api';
import type { FiltreResto } from '../restaurants';

/**
 * Filtre par restaurant — présent sur TOUS les onglets de la console, et sur
 * ceux qu'on ajoutera : c'est la question qu'on se pose en permanence au siège
 * (« et chez Angré, ça donne quoi ? »), elle ne doit jamais demander de changer
 * d'écran. Le choix vit dans `App` et SURVIT au changement d'onglet : on suit
 * un restaurant du tableau de bord à ses clôtures sans le resélectionner.
 *
 * Les sites non enrôlés restent dans la liste, marqués : les retirer laisserait
 * croire que le groupe compte moins de restaurants qu'en vrai.
 */
export function FiltreRestaurant({
  restaurants,
  valeur,
  onChoisir,
}: {
  restaurants: RestoGroupe[];
  valeur: FiltreResto;
  onChoisir: (v: FiltreResto) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm font-semibold text-doux">
      Restaurant
      <select
        className="champ !min-h-[40px] !w-auto !py-0 !text-[15px]"
        value={valeur}
        onChange={(e) => onChoisir(e.target.value)}
      >
        <option value="">Tous les restaurants</option>
        {restaurants.map((r) => (
          <option key={r.samtrackly_id} value={r.samtrackly_id}>
            {r.nom}
            {r.enrole ? '' : ' (non enrôlé)'}
          </option>
        ))}
      </select>
    </label>
  );
}
