import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatFCFA } from '@pos/shared';
import { appelSiege, ErreurSiege, type RestoGroupe } from '../api';
import { ChampPhoto } from '../components/ChampPhoto';
import { Erreur, Info, PastilleMarque, Squelette } from '../components/Etat';
import type { FiltreResto } from '../restaurants';

interface CategorieCloud {
  restaurant_id: string;
  id: string;
  nom: string;
  actif: boolean;
}

interface ArticleCloud {
  id: string;
  restaurant_id: string;
  categorie_id: string;
  nom: string;
  description: string | null;
  prix_base: number;
  image_url: string | null;
  disponible: boolean;
  actif: boolean;
  updated_at: string | null;
  version: number;
}

function EditionArticle({ article, categories, restaurant, lectureSeule, onEnregistre }: {
  article: ArticleCloud;
  categories: CategorieCloud[];
  restaurant: RestoGroupe;
  lectureSeule: boolean;
  onEnregistre: (texte: string) => void;
}) {
  const qc = useQueryClient();
  const [categorieId, setCategorieId] = useState(article.categorie_id);
  const [nom, setNom] = useState(article.nom ?? '');
  const [prix, setPrix] = useState(String(article.prix_base ?? ''));
  const [description, setDescription] = useState(article.description ?? '');
  const [photo, setPhoto] = useState(article.image_url ?? '');
  const [disponible, setDisponible] = useState(article.disponible !== false);
  const [actif, setActif] = useState(article.actif !== false);
  const [erreur, setErreur] = useState<string | null>(null);

  const modifier = useMutation({
    mutationFn: () => appelSiege('catalogue_article_modifier', {
      restaurant_id: restaurant.restaurant_id,
      article_id: article.id,
      version_attendue: article.version,
      categorie_id: categorieId,
      nom: nom.trim(),
      prix_base: Number(prix),
      description: description.trim() || null,
      image_url: photo.trim() || null,
      disponible,
      actif,
    }),
    onSuccess: () => {
      setErreur(null);
      onEnregistre(`« ${nom.trim()} » a été mis à jour pour ${restaurant.nom}. La caisse recevra la modification à sa prochaine synchronisation.`);
      void qc.invalidateQueries({ queryKey: ['catalogue_articles', restaurant.restaurant_id] });
    },
    onError: (e: Error) => setErreur(e instanceof ErreurSiege ? e.message : 'Modification impossible'),
  });

  const prixValide = /^\d+$/.test(prix) && Number.isSafeInteger(Number(prix));
  const peutEnregistrer = !lectureSeule && !modifier.isPending && !!nom.trim() && prixValide &&
    categories.some((c) => c.id === categorieId);

  return (
    <div className="rounded-jeton border border-filet bg-carte p-4">
      <h3 className="mb-1 font-bold">Modifier « {article.nom} »</h3>
      <p className="mb-4 text-sm text-doux">Seulement pour <b>{restaurant.nom}</b>. Aucun autre restaurant ne sera modifié.</p>
      {erreur && <Erreur texte={erreur} />}
      <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
        <label className="block text-sm text-doux">Nom
          <input className="champ mt-1" value={nom} onChange={(e) => setNom(e.target.value)} />
        </label>
        <label className="block text-sm text-doux">Prix de base (FCFA)
          <input className="champ mt-1" inputMode="numeric" value={prix}
            onChange={(e) => setPrix(e.target.value.replace(/[^\d]/g, ''))} />
        </label>
      </div>
      <label className="mt-3 block text-sm text-doux">Catégorie de ce restaurant
        <select className="champ mt-1" value={categorieId} onChange={(e) => setCategorieId(e.target.value)}>
          {!categories.some((c) => c.id === categorieId) && <option value={categorieId}>Catégorie actuelle inactive — choisir une autre catégorie</option>}
          {categories.map((c) => <option key={c.id} value={c.id}>{c.nom}</option>)}
        </select>
      </label>
      <label className="mt-3 block text-sm text-doux">Description
        <input className="champ mt-1" value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="mt-3">
        <p className="mb-1.5 text-sm text-doux">Photo</p>
        <ChampPhoto url={photo} onChange={setPhoto} />
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <label className="flex items-center gap-2 rounded-btn border border-filet px-3 py-2 text-sm">
          <input type="checkbox" checked={disponible} onChange={(e) => setDisponible(e.target.checked)} />
          Disponible à la vente depuis le siège
        </label>
        <label className="flex items-center gap-2 rounded-btn border border-filet px-3 py-2 text-sm">
          <input type="checkbox" checked={actif} onChange={(e) => setActif(e.target.checked)} />
          Afficher cet article au menu
        </label>
      </div>
      <p className="mt-2 text-xs text-faible">
        Un article masqué reste dans l’historique des ventes. Remettre « disponible » ici ne retire pas un état « épuisé » défini sur la caisse.
        Les prix spécifiques aux canaux de vente restent inchangés.
      </p>
      {!prixValide && <p className="mt-2 text-sm text-alerte-txt">Le prix doit être un nombre entier de FCFA.</p>}
      <button type="button" className="btn-accent mt-4 w-full" disabled={!peutEnregistrer} onClick={() => modifier.mutate()}>
        {modifier.isPending ? 'Enregistrement…' : `Enregistrer pour ${restaurant.nom}`}
      </button>
    </div>
  );
}

/** Édition du catalogue déjà présent, sans création et sans diffusion collective. */
export function GestionArticles({ filtre, restaurants, categories, lectureSeule }: {
  filtre: FiltreResto;
  restaurants: RestoGroupe[];
  categories: CategorieCloud[];
  lectureSeule: boolean;
}) {
  const qc = useQueryClient();
  const enroles = useMemo(() => restaurants.filter((r) => r.enrole && r.restaurant_id), [restaurants]);
  const [choix, setChoix] = useState('');
  const [recherche, setRecherche] = useState('');
  const [articleId, setArticleId] = useState('');
  const [message, setMessage] = useState('');
  const restaurant = enroles.find((r) => r.restaurant_id === choix)
    ?? enroles.find((r) => r.samtrackly_id === filtre)
    ?? enroles[0];
  const restaurantId = restaurant?.restaurant_id ?? '';
  const { data, isPending, error } = useQuery({
    queryKey: ['catalogue_articles', restaurantId],
    queryFn: () => appelSiege<{ articles: ArticleCloud[] }>('catalogue_articles', { restaurant_id: restaurantId }),
    enabled: !!restaurantId,
    staleTime: 30_000,
  });
  const liste = useMemo(() => (data?.articles ?? []).filter((a) =>
    `${a.nom} ${categories.find((c) => c.id === a.categorie_id && c.restaurant_id === restaurantId)?.nom ?? ''}`
      .toLocaleLowerCase().includes(recherche.toLocaleLowerCase().trim()),
  ).sort((a, b) => a.nom.localeCompare(b.nom)), [data, categories, restaurantId, recherche]);
  const article = data?.articles.find((a) => a.id === articleId);

  return (
    <div className="mb-6 space-y-4">
      <div className="rounded-jeton border border-filet bg-carte p-4">
        <h2 className="mb-1 text-lg font-bold">Articles déjà présents</h2>
        <p className="mb-3 text-sm text-doux">Choisissez un restaurant, puis un article à modifier. Les ventes et tickets passés ne sont pas changés.</p>
        {message && <Info>{message}</Info>}
        {enroles.length === 0 ? (
          <p className="text-doux">Aucun restaurant synchronisé disponible.</p>
        ) : (
          <>
            <label className="block text-sm text-doux">Restaurant
              <select className="champ mt-1" value={restaurantId} onChange={(e) => {
                setChoix(e.target.value); setArticleId(''); setMessage('');
              }}>
                {enroles.map((r) => <option key={r.restaurant_id} value={r.restaurant_id!}>{r.nom}</option>)}
              </select>
            </label>
            <label className="mt-3 block text-sm text-doux">Rechercher un article
              <input className="champ mt-1" value={recherche} onChange={(e) => setRecherche(e.target.value)} placeholder="Nom ou catégorie" />
            </label>
            <button type="button" className="btn-blanc mt-3 !min-h-[36px] !px-3 !text-sm"
              onClick={() => { setArticleId(''); setMessage(''); void qc.invalidateQueries({ queryKey: ['catalogue_articles', restaurantId] }); }}>
              Rafraîchir ce menu
            </button>
          </>
        )}
      </div>

      {restaurantId && (isPending ? <Squelette lignes={3} /> : error ? (
        <Erreur texte={error instanceof ErreurSiege ? error.message : 'Lecture du menu impossible'} />
      ) : (
        <div className="max-h-80 space-y-1 overflow-y-auto rounded-jeton border border-filet bg-carte p-2">
          {liste.length === 0 ? <p className="p-3 text-sm text-doux">Aucun article trouvé. Si ce restaurant vend déjà, vérifiez que son catalogue historique est bien remonté au siège.</p> : liste.map((a) => (
            <button key={a.id} type="button" onClick={() => { setArticleId(a.id); setMessage(''); }}
              className={`flex w-full items-center gap-3 rounded-btn px-3 py-2 text-left text-sm hover:bg-carte-douce ${a.id === articleId ? 'bg-carte-douce' : ''}`}>
              <PastilleMarque marque={restaurant!.marque} />
              <span className="min-w-0 flex-1 truncate font-semibold">{a.nom}</span>
              <span className="chiffres flex-none">{formatFCFA(a.prix_base ?? 0)}</span>
              {!a.actif && <span className="text-xs text-alerte-txt">masqué</span>}
              {a.actif && !a.disponible && <span className="text-xs text-attente-txt">indisponible</span>}
            </button>
          ))}
        </div>
      ))}
      {article && restaurant && <EditionArticle key={`${restaurantId}:${article.id}:${article.version}`}
        article={article} categories={categories.filter((c) => c.restaurant_id === restaurantId)}
        restaurant={restaurant} lectureSeule={lectureSeule} onEnregistre={setMessage} />}
    </div>
  );
}
