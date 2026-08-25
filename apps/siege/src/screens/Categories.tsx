import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { appelSiege, ErreurSiege, type Siege } from '../api';
import { Erreur, Info, PastilleMarque, Squelette } from '../components/Etat';
import { useRestaurants, type FiltreResto } from '../restaurants';

interface CategorieCloud {
  restaurant_id: string;
  id: string;
  nom: string;
  actif: boolean;
}

/**
 * Onglet Catégories — créer une catégorie et la diffuser vers un ou plusieurs
 * restaurants.
 *
 * **Pourquoi cet écran existe** : le catalogue ne voyage que vers le bas. Le
 * cloud est maître, les sites ne publient ni leurs catégories ni leurs articles.
 * Un site dont le catalogue a été importé en local est donc INVISIBLE d'ici — et
 * sans catégorie côté cloud, l'onglet Menu n'a rien à quoi rattacher un article.
 *
 * **Ce que la console ne peut PAS faire pour vous** : vérifier qu'une catégorie
 * du même nom n'existe pas déjà sur le site. Elle ne la voit pas, et
 * `categories.nom` n'est pas unique côté caisse : créer « Pizzas » sur un site
 * qui en a déjà une lui en donnera deux. L'écran le dit, il ne peut pas
 * l'empêcher.
 */
export function Categories({ filtre }: { filtre: FiltreResto; onFiltre: (v: FiltreResto) => void }) {
  const qc = useQueryClient();
  const { data: restos } = useRestaurants();
  const { data: moi } = useQuery({ queryKey: ['moi'], queryFn: () => appelSiege<Siege>('moi'), staleTime: 5 * 60_000 });
  const { data, isPending } = useQuery({
    queryKey: ['catalogue_categories'],
    queryFn: () => appelSiege<{ categories: CategorieCloud[] }>('catalogue_categories'),
    staleTime: 60_000,
  });

  const enroles = useMemo(() => (restos?.restaurants ?? []).filter((r) => r.enrole && r.restaurant_id), [restos]);

  const [nom, setNom] = useState('');
  const [ordre, setOrdre] = useState('0');
  const [cibles, setCibles] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ texte: string; ok?: boolean } | null>(null);

  const cochees = cibles.length > 0 ? cibles : enroles.filter((r) => r.samtrackly_id === filtre).map((r) => r.samtrackly_id);

  /** Ce que le cloud connaît déjà, restaurant par restaurant. */
  const existantes = useMemo(() => {
    const m = new Map<string, CategorieCloud[]>();
    for (const c of data?.categories ?? []) m.set(c.restaurant_id, [...(m.get(c.restaurant_id) ?? []), c]);
    return m;
  }, [data]);

  const doublonProbable = useMemo(() => {
    const k = nom.trim().toLowerCase();
    if (!k) return [] as string[];
    return enroles
      .filter((r) => cochees.includes(r.samtrackly_id))
      .filter((r) => (existantes.get(r.restaurant_id!) ?? []).some((c) => c.nom.trim().toLowerCase() === k))
      .map((r) => r.nom);
  }, [nom, cochees, enroles, existantes]);

  const creer = useMutation({
    mutationFn: () =>
      appelSiege<{ categorie_id: string; diffuse_vers: number }>('categorie_creer', {
        nom: nom.trim(),
        ordre: Number(ordre) || 0,
        restaurants: enroles.filter((r) => cochees.includes(r.samtrackly_id)).map((r) => r.restaurant_id),
      }),
    onSuccess: (r) => {
      setMsg({
        texte: `Catégorie « ${nom.trim()} » créée sur ${r.diffuse_vers} restaurant(s). Elle descendra dans moins de 5 minutes — ensuite l’onglet Menu pourra y ranger des articles.`,
        ok: true,
      });
      setNom('');
      void qc.invalidateQueries({ queryKey: ['catalogue_categories'] });
    },
    onError: (e: Error) => setMsg({ texte: e instanceof ErreurSiege ? e.message : 'Création impossible' }),
  });

  const lectureSeule = moi?.niveau === 'LECTURE';
  const pret = !!nom.trim() && cochees.length > 0 && !lectureSeule;

  return (
    <section className="max-w-3xl">
      <h1 className="mb-1 text-2xl font-bold">Catégories</h1>
      <p className="mb-4 text-doux">Créer une catégorie et la diffuser vers les restaurants de votre choix.</p>

      {lectureSeule && <Info>Votre compte est en <b>lecture seule</b> : vous voyez les catégories, vous n’en créez pas.</Info>}
      {msg && (msg.ok ? <Info>{msg.texte}</Info> : <Erreur texte={msg.texte} />)}

      {isPending ? (
        <Squelette lignes={3} />
      ) : (
        <div className="space-y-4">
          {/* L'existant côté CLOUD — et l'avertissement sur ce qu'il ne montre pas. */}
          <div className="rounded-jeton border border-filet bg-carte p-4">
            <h2 className="mb-2 text-[12px] font-bold uppercase tracking-wide text-faible">Ce que le siège connaît</h2>
            {enroles.length === 0 ? (
              <p className="text-doux">Aucun restaurant enrôlé : personne ne tire encore le catalogue.</p>
            ) : (
              <div className="space-y-1.5">
                {enroles.map((r) => {
                  const cats = existantes.get(r.restaurant_id!) ?? [];
                  return (
                    <div key={r.samtrackly_id} className="flex items-baseline justify-between gap-3 border-b border-filet py-1.5 last:border-0">
                      <span className="flex min-w-0 items-center gap-2 font-semibold">
                        <PastilleMarque marque={r.marque} />
                        <span className="truncate">{r.nom}</span>
                      </span>
                      <span className={`flex-none text-sm ${cats.length === 0 ? 'text-faible' : 'text-doux'}`}>
                        {cats.length === 0 ? 'aucune' : cats.map((c) => c.nom).join(', ')}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="mt-2 text-xs text-faible">
              Cette liste est celle du <b>cloud</b>, pas celle des caisses. Un site dont le catalogue a été importé
              en local n’a rien publié ici : il peut avoir vingt catégories et apparaître vide.
            </p>
          </div>

          <div className="rounded-jeton border border-filet bg-carte p-4">
            <h2 className="mb-2 text-[12px] font-bold uppercase tracking-wide text-faible">La catégorie</h2>
            <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
              <label className="block text-sm text-doux">
                Nom
                <input className="champ mt-1" value={nom} onChange={(e) => setNom(e.target.value)} placeholder="Pizzas" />
              </label>
              <label className="block text-sm text-doux">
                Ordre d’affichage
                <input
                  className="champ mt-1"
                  inputMode="numeric"
                  value={ordre}
                  onChange={(e) => setOrdre(e.target.value.replace(/[^\d]/g, ''))}
                />
              </label>
            </div>
            {doublonProbable.length > 0 && (
              <p className="mt-3 rounded-sm bg-attente-tint px-3 py-2 text-sm text-attente-txt">
                Ce nom existe déjà côté cloud chez {doublonProbable.join(', ')} — la caisse s’en retrouverait avec deux
                catégories du même nom.
              </p>
            )}
          </div>

          <div className="rounded-jeton border border-filet bg-carte p-4">
            <h2 className="mb-2 text-[12px] font-bold uppercase tracking-wide text-faible">Vers quels restaurants</h2>
            <div className="mb-2 flex gap-2">
              <button type="button" className="btn-blanc !min-h-[36px] !px-3 !text-sm" onClick={() => setCibles(enroles.map((r) => r.samtrackly_id))}>
                Tout cocher
              </button>
              <button type="button" className="btn-blanc !min-h-[36px] !px-3 !text-sm" onClick={() => setCibles([])}>
                Tout décocher
              </button>
            </div>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {enroles.map((r) => (
                <label key={r.samtrackly_id} className="flex cursor-pointer items-center gap-2.5 rounded-btn border border-filet px-3 py-2.5 transition hover:border-marque">
                  <input
                    type="checkbox"
                    className="h-4 w-4 flex-none accent-[var(--marque)]"
                    checked={cochees.includes(r.samtrackly_id)}
                    onChange={(e) =>
                      setCibles(e.target.checked ? [...new Set([...cochees, r.samtrackly_id])] : cochees.filter((x) => x !== r.samtrackly_id))
                    }
                  />
                  <PastilleMarque marque={r.marque} />
                  <span className="min-w-0 flex-1 truncate font-semibold">{r.nom}</span>
                </label>
              ))}
            </div>

            <button type="button" className="btn-accent mt-4 w-full" disabled={!pret || creer.isPending} onClick={() => creer.mutate()}>
              {creer.isPending ? 'Création…' : `Créer sur ${cochees.length} restaurant${cochees.length > 1 ? 's' : ''}`}
            </button>
            <p className="mt-2 text-center text-xs text-faible">
              La catégorie part dans le cloud ; chaque caisse la tire à sa prochaine descente, en moins de 5 minutes.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
