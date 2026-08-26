import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { IconAlertTriangle, IconSearch, IconUsers } from '@tabler/icons-react';
import { appeler } from '../api';

interface Employe {
  id: string;
  nom: string | null;
  poste: string | null;
  contact: string | null;
  photo_url: string | null;
  actif: boolean | null;
  restaurant_id: string | null;
  restaurant_nom: string | null;
}

/**
 * Couleurs d'avatar, tirées du NOM et non du rang dans la liste : une embauche
 * ne doit pas repeindre les avatars de toute l'équipe. Même règle que la caisse.
 * Hors famille orange, réservée à la marque.
 */
const COULEURS = ['#e2445c', '#8b5cf6', '#3b82f6', '#14b8a6', '#0ea5e9', '#d946ef'];

function couleur(nom: string): string {
  let somme = 0;
  for (let i = 0; i < nom.length; i += 1) somme = (somme * 31 + nom.charCodeAt(i)) % 100_000;
  return COULEURS[somme % COULEURS.length]!;
}

function initiales(nom: string): string {
  return nom
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((m) => m[0]!.toUpperCase())
    .join('');
}

export function Equipe(): JSX.Element {
  const [recherche, setRecherche] = useState('');
  const [restaurant, setRestaurant] = useState<string>('tous');

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['equipe'],
    queryFn: () => appeler<{ employes: Employe[] }>('equipe'),
    // L'équipe bouge à l'échelle de la semaine, pas de la minute.
    refetchInterval: false,
    staleTime: 5 * 60_000,
  });

  const employes = data?.employes ?? [];

  const restaurants = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of employes) {
      if (e.restaurant_id && e.restaurant_nom) m.set(e.restaurant_id, e.restaurant_nom);
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], 'fr'));
  }, [employes]);

  const filtres = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    return employes.filter((e) => {
      if (restaurant !== 'tous' && e.restaurant_id !== restaurant) return false;
      if (!q) return true;
      return `${e.nom ?? ''} ${e.poste ?? ''}`.toLowerCase().includes(q);
    });
  }, [employes, recherche, restaurant]);

  return (
    <div className="mx-auto max-w-[1180px] p-8">
      <header className="mb-6">
        <h1 className="text-[26px] font-bold tracking-tight text-fort">Équipe</h1>
        <p className="mt-1 text-doux">
          {employes.length} employés actifs dans le groupe. Les fiches viennent de SamerTrackly, qui en est la
          source ; chaque caisse les récupère automatiquement.
        </p>
      </header>

      {isError && (
        <div
          className="mb-6 flex items-start gap-3 rounded-jeton p-4"
          style={{ background: 'var(--alerte-tint)', color: 'var(--alerte-txt)' }}
        >
          <IconAlertTriangle size={22} style={{ flex: 'none', marginTop: 1 }} />
          <div className="text-sm">{(error as Error).message}</div>
        </div>
      )}

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="champ flex max-w-[320px] flex-1 items-center gap-2.5">
          <IconSearch size={19} className="flex-none text-faible" />
          <input
            value={recherche}
            onChange={(e) => setRecherche(e.target.value)}
            placeholder="Chercher un nom, un poste…"
            className="w-full bg-transparent outline-none"
          />
        </div>
        <select
          value={restaurant}
          onChange={(e) => setRestaurant(e.target.value)}
          className="champ max-w-[260px] cursor-pointer"
        >
          <option value="tous">Tous les restaurants</option>
          {restaurants.map(([id, nom]) => (
            <option key={id} value={id}>
              {nom}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-2 text-sm text-doux">
          <IconUsers size={18} />
          {filtres.length} affichés
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 9 }, (_, i) => (
            <div key={i} className="squelette h-[76px] w-full" />
          ))}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtres.map((e) => {
            const nom = (e.nom ?? '').trim() || 'Sans nom';
            const c = couleur(nom);
            return (
              <div key={e.id} className="carte flex items-center gap-3.5 p-4">
                {e.photo_url ? (
                  <img
                    src={e.photo_url}
                    alt=""
                    className="h-11 w-11 flex-none rounded-full object-cover"
                    style={{ border: '1px solid var(--filet)' }}
                  />
                ) : (
                  <div
                    className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-sm font-bold"
                    style={{ background: `color-mix(in srgb, ${c} 18%, var(--carte))`, color: c }}
                  >
                    {initiales(nom)}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold text-fort">{nom}</div>
                  <div className="truncate text-sm text-doux">{e.poste?.trim() || 'Poste non renseigné'}</div>
                  <div className="truncate text-xs text-faible">{e.restaurant_nom ?? 'Restaurant non affecté'}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!isLoading && filtres.length === 0 && !isError && (
        <div className="carte p-8 text-center text-doux">Aucun employé ne correspond à cette recherche.</div>
      )}
    </div>
  );
}
