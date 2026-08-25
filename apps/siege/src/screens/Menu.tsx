import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatFCFA } from '@pos/shared';
import { appelSiege, ErreurSiege, type Siege } from '../api';
import { ChampPhoto } from '../components/ChampPhoto';
import { Erreur, Info, PastilleMarque, Squelette } from '../components/Etat';
import { useRestaurants, type FiltreResto } from '../restaurants';

interface CategorieCloud {
  restaurant_id: string;
  id: string;
  nom: string;
  actif: boolean;
}

/** Nom de catégorie normalisé : « Jus naturels » et « JUS NATURELS » sont la même. */
const cle = (nom: string) => nom.trim().toLowerCase();

/**
 * Onglet Menu — créer un article et le diffuser vers un ou plusieurs restaurants.
 *
 * **On n'invente aucun canal.** L'écriture va dans les tables du cloud, que
 * chaque site tire par la descente CATALOGUE (moins de 5 minutes) : c'est la
 * voie qui existe déjà, celle par laquelle le catalogue descend depuis toujours.
 *
 * **La catégorie se choisit par son NOM, pas par son id.** Chaque site a importé
 * son catalogue localement : « Pizzas » existe sur les 7 restaurants sous 7
 * identifiants différents. L'écran résout donc, restaurant par restaurant, l'id
 * de SA catégorie — et refuse d'envoyer vers un site où ce nom n'existe pas,
 * plutôt que d'y créer un article orphelin.
 */
export function Menu({ filtre }: { filtre: FiltreResto; onFiltre: (v: FiltreResto) => void }) {
  const qc = useQueryClient();
  const { data: restos } = useRestaurants();
  const { data: moi } = useQuery({ queryKey: ['moi'], queryFn: () => appelSiege<Siege>('moi'), staleTime: 5 * 60_000 });
  const { data: cats, isPending } = useQuery({
    queryKey: ['catalogue_categories'],
    queryFn: () => appelSiege<{ categories: CategorieCloud[] }>('catalogue_categories'),
    staleTime: 5 * 60_000,
  });

  /** Seuls les sites enrôlés peuvent recevoir : un site muet ne tire rien. */
  const enroles = useMemo(
    () => (restos?.restaurants ?? []).filter((r) => r.enrole && r.restaurant_id),
    [restos],
  );

  const [cibles, setCibles] = useState<string[]>([]);
  const [categorie, setCategorie] = useState('');
  const [nom, setNom] = useState('');
  const [prix, setPrix] = useState('');
  const [description, setDescription] = useState('');
  const [photo, setPhoto] = useState('');
  const [msg, setMsg] = useState<{ texte: string; ok?: boolean } | null>(null);

  // Le filtre global pré-coche le restaurant en cours : on arrive souvent ici
  // depuis son tableau de bord.
  const cochees = cibles.length > 0 ? cibles : enroles.filter((r) => r.samtrackly_id === filtre).map((r) => r.samtrackly_id);

  /** Catégories par restaurant, indexées par nom normalisé. */
  const parResto = useMemo(() => {
    const m = new Map<string, Map<string, CategorieCloud>>();
    for (const c of cats?.categories ?? []) {
      if (!m.has(c.restaurant_id)) m.set(c.restaurant_id, new Map());
      m.get(c.restaurant_id)!.set(cle(c.nom), c);
    }
    return m;
  }, [cats]);

  /** Tous les noms de catégorie du groupe, avec le nombre de sites qui l'ont. */
  const nomsCategories = useMemo(() => {
    const compte = new Map<string, { libelle: string; sites: number }>();
    for (const c of cats?.categories ?? []) {
      const k = cle(c.nom);
      const vu = compte.get(k);
      compte.set(k, { libelle: vu?.libelle ?? c.nom.trim(), sites: (vu?.sites ?? 0) + 1 });
    }
    return [...compte.entries()].sort((a, b) => a[1].libelle.localeCompare(b[1].libelle));
  }, [cats]);

  /** Résolution nom → id, restaurant par restaurant. Le cœur de l'écran. */
  const resolution = useMemo(() => {
    const ok: { restaurant_id: string; categorie_id: string; nom: string }[] = [];
    const sans: string[] = [];
    for (const sid of cochees) {
      const r = enroles.find((x) => x.samtrackly_id === sid);
      if (!r?.restaurant_id) continue;
      const cat = categorie ? parResto.get(r.restaurant_id)?.get(categorie) : undefined;
      if (cat) ok.push({ restaurant_id: r.restaurant_id, categorie_id: cat.id, nom: r.nom });
      else sans.push(r.nom);
    }
    return { ok, sans };
  }, [cochees, categorie, enroles, parResto]);

  const diffuser = useMutation({
    mutationFn: () =>
      appelSiege<{ article_id: string; diffuse_vers: number }>('catalogue_diffuser', {
        nom: nom.trim(),
        prix_base: Number(prix),
        description: description.trim() || undefined,
        image_url: photo.trim() || undefined,
        cibles: resolution.ok.map(({ restaurant_id, categorie_id }) => ({ restaurant_id, categorie_id })),
      }),
    onSuccess: (r) => {
      setMsg({
        texte: `« ${nom.trim()} » diffusé vers ${r.diffuse_vers} restaurant(s). Chaque caisse le recevra à sa prochaine descente, dans moins de 5 minutes.`,
        ok: true,
      });
      setNom('');
      setPrix('');
      setDescription('');
      setPhoto('');
      void qc.invalidateQueries({ queryKey: ['catalogue_categories'] });
    },
    onError: (e: Error) => setMsg({ texte: e instanceof ErreurSiege ? e.message : 'Diffusion impossible' }),
  });

  const lectureSeule = moi?.niveau === 'LECTURE';
  const prixValide = /^\d+$/.test(prix) && Number(prix) >= 0;
  const pretAEnvoyer = !!nom.trim() && prixValide && !!categorie && resolution.ok.length > 0 && !lectureSeule;

  return (
    <section className="max-w-3xl">
      <h1 className="mb-1 text-2xl font-bold">Menu</h1>
      <p className="mb-4 text-doux">Créer un article et le diffuser vers les restaurants de votre choix.</p>

      {lectureSeule && <Info>Votre compte est en <b>lecture seule</b> : vous pouvez préparer un article, pas le diffuser.</Info>}
      {msg && (msg.ok ? <Info>{msg.texte}</Info> : <Erreur texte={msg.texte} />)}

      {isPending ? (
        <Squelette lignes={3} />
      ) : (
        <div className="space-y-4">
          {/* 1. Où */}
          <div className="rounded-jeton border border-filet bg-carte p-4">
            <h2 className="mb-2 text-[12px] font-bold uppercase tracking-wide text-faible">1. Vers quels restaurants</h2>
            {enroles.length === 0 ? (
              <p className="text-doux">
                Aucun restaurant n’est enrôlé : personne ne tire encore le catalogue depuis le cloud. Un article
                diffusé maintenant n’arriverait nulle part.
              </p>
            ) : (
              <>
                <div className="mb-2 flex gap-2">
                  <button type="button" className="btn-blanc !min-h-[36px] !px-3 !text-sm" onClick={() => setCibles(enroles.map((r) => r.samtrackly_id))}>
                    Tout cocher
                  </button>
                  <button type="button" className="btn-blanc !min-h-[36px] !px-3 !text-sm" onClick={() => setCibles([])}>
                    Tout décocher
                  </button>
                </div>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {enroles.map((r) => {
                    const coche = cochees.includes(r.samtrackly_id);
                    const aLaCategorie = !categorie || !!parResto.get(r.restaurant_id!)?.get(categorie);
                    return (
                      <label key={r.samtrackly_id} className="flex cursor-pointer items-center gap-2.5 rounded-btn border border-filet px-3 py-2.5 transition hover:border-marque">
                        <input
                          type="checkbox"
                          className="h-4 w-4 flex-none accent-[var(--marque)]"
                          checked={coche}
                          onChange={(e) =>
                            setCibles(
                              e.target.checked ? [...new Set([...cochees, r.samtrackly_id])] : cochees.filter((x) => x !== r.samtrackly_id),
                            )
                          }
                        />
                        <PastilleMarque marque={r.marque} />
                        <span className="min-w-0 flex-1 truncate font-semibold">{r.nom}</span>
                        {coche && !aLaCategorie && (
                          <span className="flex-none rounded-sm bg-alerte-tint px-2 py-0.5 text-[11px] font-semibold text-alerte-txt">
                            pas cette catégorie
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          {/* 2. Catégorie, par son nom */}
          <div className="rounded-jeton border border-filet bg-carte p-4">
            <h2 className="mb-2 text-[12px] font-bold uppercase tracking-wide text-faible">2. Dans quelle catégorie</h2>
            {nomsCategories.length === 0 ? (
              /* Le cas le plus courant au démarrage, et le plus déroutant : le
                 catalogue ne remonte JAMAIS des caisses vers le cloud (ni
                 `categories` ni `articles` ne sont publiées par le POS). Un site
                 dont le catalogue a été importé en local n'a donc rien ici, même
                 s'il affiche vingt catégories à sa caisse. On l'explique au lieu
                 de laisser une liste vide sans raison. */
              <div className="rounded-sm bg-attente-tint px-3 py-2.5 text-sm text-attente-txt">
                <b>Aucune catégorie côté siège.</b> Le catalogue ne voyage que vers le bas : les caisses ne publient
                jamais le leur. Créez-en une dans l’onglet <b>Catégories</b> — elle descendra vers les restaurants
                choisis, et vous pourrez y ranger des articles.
              </div>
            ) : (
              <select className="champ" value={categorie} onChange={(e) => setCategorie(e.target.value)}>
                <option value="">Choisir une catégorie…</option>
                {nomsCategories.map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.libelle} — présente sur {v.sites} restaurant(s)
                  </option>
                ))}
              </select>
            )}
            <p className="mt-2 text-xs text-faible">
              La catégorie se choisit par son <b>nom</b> : chaque site a ses propres identifiants de catégorie, et
              l’article se rattachera à celui de chacun.
            </p>
            {resolution.sans.length > 0 && (
              <p className="mt-2 rounded-sm bg-alerte-tint px-3 py-2 text-sm text-alerte-txt">
                Cette catégorie n’existe pas chez {resolution.sans.join(', ')} — ces restaurants seront ignorés.
              </p>
            )}
          </div>

          {/* 3. L'article */}
          <div className="rounded-jeton border border-filet bg-carte p-4">
            <h2 className="mb-2 text-[12px] font-bold uppercase tracking-wide text-faible">3. L’article</h2>
            <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
              <label className="block text-sm text-doux">
                Nom
                <input className="champ mt-1" value={nom} onChange={(e) => setNom(e.target.value)} placeholder="Chawarma Poulet" />
              </label>
              <label className="block text-sm text-doux">
                Prix (FCFA)
                <input
                  className="champ mt-1"
                  inputMode="numeric"
                  value={prix}
                  onChange={(e) => setPrix(e.target.value.replace(/[^\d]/g, ''))}
                  placeholder="3000"
                />
              </label>
            </div>
            <label className="mt-3 block text-sm text-doux">
              Description (facultative)
              <input className="champ mt-1" value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <div className="mt-3">
              <p className="mb-1.5 text-sm text-doux">Photo (facultative)</p>
              <ChampPhoto url={photo} onChange={setPhoto} />
            </div>
            {prix && !prixValide && (
              <p className="mt-2 text-sm text-alerte-txt">Le prix s’écrit en francs entiers, sans centimes ni espace.</p>
            )}
          </div>

          {/* 4. Récapitulatif avant envoi — on ne diffuse pas à l'aveugle. */}
          <div className="rounded-jeton border border-filet bg-carte p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              {photo && <img src={photo} alt="" className="h-10 w-10 flex-none rounded-sm object-cover" />}
              <span className="font-semibold">
                {nom.trim() || 'Article sans nom'}
                {prixValide && <span className="chiffres ml-2 text-marque-sur-plan">{formatFCFA(Number(prix))}</span>}
              </span>
              <span className="text-sm text-doux">
                {resolution.ok.length === 0
                  ? 'aucun restaurant prêt'
                  : `vers ${resolution.ok.map((c) => c.nom).join(', ')}`}
              </span>
            </div>
            <button type="button" className="btn-accent w-full" disabled={!pretAEnvoyer || diffuser.isPending} onClick={() => diffuser.mutate()}>
              {diffuser.isPending
                ? 'Diffusion…'
                : `Diffuser vers ${resolution.ok.length} restaurant${resolution.ok.length > 1 ? 's' : ''}`}
            </button>
            <p className="mt-2 text-center text-xs text-faible">
              L’article part dans le cloud ; chaque caisse le tire à sa prochaine descente, en moins de 5 minutes.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
