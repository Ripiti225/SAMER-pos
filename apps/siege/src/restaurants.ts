import { useQuery } from '@tanstack/react-query';
import { appelSiege, type RestoGroupe } from './api';

/**
 * La liste des restaurants du groupe, partagée par TOUS les onglets.
 *
 * Une seule requête pour toute la console : `staleTime` à 5 minutes, la liste
 * ne bouge qu'à la création d'un restaurant chez SamerTrackly ou à l'enrôlement
 * d'un site. Chaque onglet la relit depuis le cache de TanStack Query.
 */
export function useRestaurants() {
  return useQuery({
    queryKey: ['restaurants'],
    queryFn: () => appelSiege<{ restaurants: RestoGroupe[] }>('restaurants'),
    staleTime: 5 * 60_000,
  });
}

/**
 * Filtre restaurant, tel que les écrans le manipulent.
 *
 * On transporte le `samtrackly_id` et NON le `restaurant_id` du POS : c'est le
 * seul identifiant que possèdent les 7 restaurants, enrôlés ou pas. Un site non
 * enrôlé n'a pas d'UUID POS, et il doit rester sélectionnable — sinon il
 * disparaîtrait du filtre alors qu'il existe bel et bien.
 */
export type FiltreResto = string;

/** Le restaurant choisi, ou `null` pour « tous ». */
export function restoChoisi(liste: RestoGroupe[] | undefined, filtre: FiltreResto): RestoGroupe | null {
  if (!filtre) return null;
  return liste?.find((r) => r.samtrackly_id === filtre) ?? null;
}
