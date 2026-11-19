import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { appelPromo, ErreurSiege, type RestoGroupe } from '../api';
import { Erreur } from './Etat';

interface Exclusion {
  restaurant_id: string;
  id: string;
  exclue: boolean;
}

/**
 * Catégories exclues des codes promo cartes, restaurant par restaurant
 * (brief PROMO § 7.4). Une catégorie cochée n'est jamais remisée par un code,
 * en caisse comme sur le site — on ne filtre jamais sur le nom du plat.
 *
 * L'exclusion vit dans sa propre table (`promo_categories_exclues`) et non
 * sur la catégorie : une colonne de plus sur `categories` casserait la
 * descente de toute caisse pas encore à jour.
 */
export function ExclusionsPromo({
  enroles,
  categories,
  parDefaut,
  lectureSeule,
}: {
  enroles: RestoGroupe[];
  categories: { restaurant_id: string; id: string; nom: string; actif: boolean }[];
  parDefaut: string;
  lectureSeule: boolean;
}) {
  const qc = useQueryClient();
  const [choix, setChoix] = useState('');
  const resto = enroles.find((r) => r.samtrackly_id === (choix || parDefaut)) ?? enroles[0];
  const restaurantId = resto?.restaurant_id ?? '';

  const { data, error } = useQuery({
    queryKey: ['promo_exclusions', restaurantId],
    queryFn: () => appelPromo<{ exclusions: Exclusion[] }>('exclusions', { restaurant_id: restaurantId }),
    enabled: !!restaurantId,
    staleTime: 60_000,
  });
  const exclues = new Set((data?.exclusions ?? []).filter((e) => e.exclue).map((e) => e.id));

  const basculer = useMutation({
    mutationFn: (v: { categorie_id: string; exclue: boolean }) => appelPromo('categorie_exclure', { restaurant_id: restaurantId, ...v }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['promo_exclusions', restaurantId] }),
  });

  const siennes = categories.filter((c) => c.restaurant_id === restaurantId && c.actif).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  const erreur = error ?? basculer.error;

  return (
    <div className="rounded-jeton border border-filet bg-carte p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[12px] font-bold uppercase tracking-wide text-faible">Exclues des codes promo cartes</h2>
        <select className="champ !min-h-[36px] !w-auto !py-0 !text-sm" value={resto?.samtrackly_id ?? ''} onChange={(e) => setChoix(e.target.value)}>
          {enroles.map((r) => (
            <option key={r.samtrackly_id} value={r.samtrackly_id}>{r.nom}</option>
          ))}
        </select>
      </div>
      <p className="mb-3 text-sm text-doux">
        Une catégorie cochée n’est jamais remisée par un code carte, en caisse comme sur le site (le Chawarma, par exemple).
      </p>
      {erreur && <Erreur texte={erreur instanceof ErreurSiege ? erreur.message : 'Lecture impossible'} />}
      {siennes.length === 0 ? (
        <p className="text-sm text-faible">Aucune catégorie active pour ce restaurant.</p>
      ) : (
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {siennes.map((c) => {
            const exclue = exclues.has(c.id);
            return (
              <label key={c.id} className="flex cursor-pointer items-center gap-2.5 rounded-btn border border-filet px-3 py-2.5">
                <input
                  type="checkbox"
                  className="h-4 w-4 flex-none accent-[var(--marque)]"
                  checked={exclue}
                  disabled={lectureSeule || basculer.isPending}
                  onChange={(e) => basculer.mutate({ categorie_id: c.id, exclue: e.target.checked })}
                />
                <span className="min-w-0 flex-1 truncate font-semibold">{c.nom}</span>
                <span className={`text-[13px] font-semibold ${exclue ? 'text-alerte-txt' : 'text-doux'}`}>{exclue ? 'Exclue' : 'Remisée'}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
