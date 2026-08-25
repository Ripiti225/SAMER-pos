import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconSearch } from '@tabler/icons-react';
import { appelSiege, ErreurSiege, type Employe } from '../api';
import { Erreur, Info, Squelette } from '../components/Etat';
import { FiltreRestaurant } from '../components/FiltreRestaurant';
import { restoChoisi, useRestaurants, type FiltreResto } from '../restaurants';

/** Initiales pour l'emplacement de la photo, quand `photo_url` est vide. */
function initiales(nom: string): string {
  return nom
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((m) => m[0]?.toUpperCase() ?? '')
    .join('');
}

export function Equipe({ filtre, onFiltre }: { filtre: FiltreResto; onFiltre: (v: FiltreResto) => void }) {
  const [recherche, setRecherche] = useState('');

  const { data: restos } = useRestaurants();
  const choisi = restoChoisi(restos?.restaurants, filtre);

  const { data, error, isPending } = useQuery({
    queryKey: ['equipe'],
    queryFn: () => appelSiege<{ employes: Employe[] }>('equipe'),
    staleTime: 5 * 60_000,
  });

  const employes = data?.employes ?? [];

  /**
   * Le rattachement se compare sur le `samtrackly_id` et non sur le nom :
   * `employes[].restaurant_id` EST l'identifiant SamerTrackly du restaurant
   * (la fonction n'y ajoute que le nom, pour l'affichage). Comparer des noms
   * casserait au premier restaurant renommé ou mal accentué.
   */
  const visibles = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    return employes.filter(
      (e) =>
        (!choisi || e.restaurant_id === choisi.samtrackly_id) &&
        (!q || (e.nom ?? '').toLowerCase().includes(q) || (e.poste ?? '').toLowerCase().includes(q)),
    );
  }, [employes, recherche, choisi]);

  return (
    <section>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Équipe</h1>
          <p className="text-doux">
            {choisi ? `${visibles.length} personne(s) — ${choisi.nom}` : `${employes.length} personne(s) dans le groupe`}
          </p>
        </div>
        <FiltreRestaurant restaurants={restos?.restaurants ?? []} valeur={filtre} onChoisir={onFiltre} />
      </div>

      {/* Le point à ne pas rouvrir : SamerTrackly est MAÎTRE de l'employé. La
          descente `sync-samtrackly.ts` désactive dans chaque POS tout compte lié
          disparu de sa liste — une seconde source d'employés provoquerait des
          désactivations et des doublons silencieux. D'où la lecture seule ici,
          et la phrase à l'écran plutôt qu'un bouton « Ajouter » qui manquerait. */}
      <Info>
        Cet écran est en <b>lecture seule</b>. L’employé se crée et se modifie dans <b>SamerTrackly</b>, qui en est
        la source unique : chaque POS reçoit sa liste par la synchro, et désactive les comptes qui en disparaissent.
      </Info>

      {error && <Erreur texte={error instanceof ErreurSiege ? error.message : 'Lecture impossible'} />}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative max-w-xs flex-1">
          <IconSearch size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-doux" />
          <input
            type="search"
            className="champ pl-10"
            placeholder="Rechercher un nom, un poste…"
            value={recherche}
            onChange={(e) => setRecherche(e.target.value)}
          />
        </div>
      </div>

      {isPending ? (
        <Squelette lignes={4} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visibles.map((e) => (
            <article key={e.id} className="flex items-center gap-3 rounded-jeton border border-filet bg-carte p-4 shadow-e1">
              {e.photo_url ? (
                <img src={e.photo_url} alt="" className="h-12 w-12 flex-none rounded-full object-cover" />
              ) : (
                <span className="flex h-12 w-12 flex-none items-center justify-center rounded-full bg-marque-tint text-sm font-bold text-marque-sur-plan">
                  {initiales(e.nom ?? '?')}
                </span>
              )}
              <div className="min-w-0">
                <p className="truncate font-semibold">{e.nom ?? 'Sans nom'}</p>
                <p className="truncate text-sm text-doux">{e.poste ?? 'Poste non renseigné'}</p>
                <p className="truncate text-xs text-faible">{e.restaurant_nom ?? 'Non rattaché à un restaurant'}</p>
              </div>
            </article>
          ))}
          {visibles.length === 0 && !error && (
            <p className="text-doux">Aucune personne ne correspond à cette recherche.</p>
          )}
        </div>
      )}
    </section>
  );
}
