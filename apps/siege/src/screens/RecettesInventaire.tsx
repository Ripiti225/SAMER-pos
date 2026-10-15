import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LIBELLES_CATEGORIES_INVENTAIRE } from '@pos/shared';
import { appelSiege, ErreurSiege, type Siege } from '../api';
import { Erreur, Info, Squelette } from '../components/Etat';
import { useRestaurants, type FiltreResto } from '../restaurants';

interface Produit {
  id: string;
  code: string;
  categorie: string;
  nom: string;
  prix: number;
  unite: string;
  role: string;
  ordre: number;
}
interface Recette { id: string; produit_id: string; article_id: string; quantite: number | string }
interface Article { id: string; nom: string; actif: boolean }
interface CatalogueInventaire { produits: Produit[]; recettes: Recette[]; articles: Article[] }

const derive = (role: string) => role === 'ENTREE' || role === 'AUTO_ENT' || role === 'DARINA' || role.startsWith('TOTAL');
const categories = Object.entries(LIBELLES_CATEGORIES_INVENTAIRE);

export function RecettesInventaire({ siege, filtre }: { siege: Siege; filtre: FiltreResto }) {
  const qc = useQueryClient();
  const { data: restos } = useRestaurants();
  const enroles = (restos?.restaurants ?? []).filter((r) => r.enrole && r.restaurant_id);
  const [choix, setChoix] = useState('');
  const restaurant = enroles.find((r) => r.restaurant_id === choix)
    ?? enroles.find((r) => r.samtrackly_id === filtre)
    ?? enroles[0];
  const restaurantId = restaurant?.restaurant_id ?? '';
  const lectureSeule = siege.niveau === 'LECTURE';
  const braise = restaurant?.marque === 'A_LA_BRAISE';

  const [produitId, setProduitId] = useState('');
  const [creationOuverte, setCreationOuverte] = useState(false);
  const [nom, setNom] = useState('');
  const [categorie, setCategorie] = useState('PLAT');
  const [unite, setUnite] = useState('u');
  const [prix, setPrix] = useState('0');
  const [rechercheArticle, setRechercheArticle] = useState('');
  const [articleId, setArticleId] = useState('');
  const [quantite, setQuantite] = useState('1');
  const [message, setMessage] = useState<{ texte: string; ok?: boolean } | null>(null);

  const { data, isPending, error } = useQuery({
    queryKey: ['inventaire_catalogue_siege', restaurantId],
    queryFn: () => appelSiege<CatalogueInventaire>('inventaire_catalogue', { restaurant_id: restaurantId }),
    enabled: !!restaurantId,
    staleTime: 30_000,
  });
  const produits = useMemo(() => (data?.produits ?? []).slice().sort((a, b) =>
    a.categorie.localeCompare(b.categorie) || a.ordre - b.ordre || a.nom.localeCompare(b.nom)), [data]);
  const produit = produits.find((p) => p.id === produitId);
  const recettes = (data?.recettes ?? []).filter((r) => r.produit_id === produitId);
  const articles = (data?.articles ?? []).filter((a) => a.actif);
  const candidats = articles.filter((a) => a.nom.toLocaleLowerCase('fr').includes(rechercheArticle.trim().toLocaleLowerCase('fr')));

  const creer = useMutation({
    mutationFn: () => appelSiege<{ id: string; nom: string }>('inventaire_produit_creer', {
      restaurant_id: restaurantId, nom: nom.trim(), categorie, unite: unite.trim(), prix: Number(prix),
    }),
    onSuccess: (r) => {
      setMessage({ texte: `« ${r.nom} » a été créé pour ${restaurant?.nom}. Ajoutez maintenant les articles vendus à sa recette.`, ok: true });
      setCreationOuverte(false);
      setNom(''); setUnite('u'); setPrix('0');
      setProduitId(r.id);
      void qc.invalidateQueries({ queryKey: ['inventaire_catalogue_siege', restaurantId] });
    },
    onError: (e: Error) => setMessage({ texte: e instanceof ErreurSiege ? e.message : 'Création impossible' }),
  });

  const enregistrer = useMutation({
    mutationFn: () => appelSiege('inventaire_recette_enregistrer', {
      restaurant_id: restaurantId, produit_id: produitId, article_id: articleId, quantite: Number(quantite),
    }),
    onSuccess: () => {
      setMessage({ texte: 'Recette enregistrée. Le POS la recevra à sa prochaine synchronisation.', ok: true });
      setArticleId(''); setQuantite('1'); setRechercheArticle('');
      void qc.invalidateQueries({ queryKey: ['inventaire_catalogue_siege', restaurantId] });
    },
    onError: (e: Error) => setMessage({ texte: e instanceof ErreurSiege ? e.message : 'Enregistrement impossible' }),
  });

  const prixValide = /^\d+$/.test(prix) && Number.isSafeInteger(Number(prix)) && Number(prix) <= 100_000_000;
  const quantiteValide = Number.isFinite(Number(quantite)) && Number(quantite) > 0 && Number(quantite) <= 1000 &&
    Math.round(Number(quantite) * 1000) === Number(quantite) * 1000;

  return (
    <section className="max-w-3xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Recettes d’inventaire</h1>
        <p className="mt-1 text-sm text-doux">Créez les produits à compter et indiquez ce que chaque article vendu consomme. Les changements arrivent au POS par la synchronisation du catalogue.</p>
      </div>
      {message && (message.ok ? <Info>{message.texte}</Info> : <Erreur texte={message.texte} />)}
      {lectureSeule && <Info>Votre compte est en lecture seule.</Info>}

      <div className="rounded-jeton border border-filet bg-carte p-4">
        {enroles.length === 0 ? <p className="text-doux">Aucun restaurant synchronisé disponible.</p> : (
          <label className="block text-sm text-doux">Restaurant
            <select className="champ mt-1" value={restaurantId} onChange={(e) => {
              setChoix(e.target.value); setProduitId(''); setMessage(null); setArticleId('');
            }}>
              {enroles.map((r) => <option key={r.restaurant_id} value={r.restaurant_id!}>{r.nom}</option>)}
            </select>
          </label>
        )}
        {braise && <p className="mt-2 text-sm text-attente-txt">
          Pour À la Braise, la création au siège et le premier transfert des produits du POS vers le cloud nécessitent une validation des produits concernés.
        </p>}
      </div>

      {restaurantId && (isPending ? <Squelette lignes={4} /> : error ? (
        <Erreur texte={error instanceof ErreurSiege && error.message.includes('Action inconnue')
          ? 'La fonction cloud du siège doit être mise à jour avant d’utiliser cet écran.'
          : error instanceof ErreurSiege ? error.message : 'Lecture de l’inventaire impossible'} />
      ) : (
        <>
          {!lectureSeule && !braise && (
            <div className="rounded-jeton border border-filet bg-carte p-4">
              <button type="button" className="btn-accent" onClick={() => setCreationOuverte((v) => !v)}>
                {creationOuverte ? 'Fermer' : 'Ajouter un produit d’inventaire'}
              </button>
              {creationOuverte && <form className="mt-4 grid gap-3" onSubmit={(e) => { e.preventDefault(); creer.mutate(); }}>
                <p className="text-sm text-doux">Le produit sera créé pour <b>{restaurant?.nom}</b>, puis envoyé à son POS. Il sera compté en unités de stock.</p>
                <label className="block text-sm text-doux">Nom du produit
                  <input className="champ mt-1" value={nom} onChange={(e) => setNom(e.target.value)} maxLength={120} required placeholder="Ex. Pain burger" />
                </label>
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="block text-sm text-doux">Catégorie
                    <select className="champ mt-1" value={categorie} onChange={(e) => setCategorie(e.target.value)}>
                      {categories.map(([code, libelle]) => <option key={code} value={code}>{libelle}</option>)}
                    </select>
                  </label>
                  <label className="block text-sm text-doux">Unité de comptage
                    <input className="champ mt-1" value={unite} onChange={(e) => setUnite(e.target.value)} maxLength={16} required placeholder="u, kg, L…" />
                  </label>
                  <label className="block text-sm text-doux">Prix unitaire (FCFA)
                    <input className="champ mt-1" type="number" min="0" step="1" value={prix} onChange={(e) => setPrix(e.target.value)} required />
                  </label>
                </div>
                <button type="submit" className="btn-accent" disabled={creer.isPending || !nom.trim() || !unite.trim() || !prixValide}>
                  {creer.isPending ? 'Création…' : 'Créer pour ce restaurant'}
                </button>
              </form>}
            </div>
          )}

          <div className="rounded-jeton border border-filet bg-carte p-4">
            <h2 className="mb-2 text-lg font-bold">Produits d’inventaire</h2>
            {produits.length === 0 ? <p className="text-sm text-doux">
              {braise ? (
                <>Les produits déjà présents sur le POS À la Braise ne sont pas encore publiés au cloud. Leur transfert nécessite une validation des produits concernés.</>
              ) : (
                <>La caisse de ce restaurant peut déjà avoir des produits d’inventaire, mais leur liste n’a pas encore été copiée au siège.
                  Sur le POS de ce restaurant, ouvrez Administration → Recettes d’inventaire, puis « Envoyer les produits existants au siège ».
                  Actualisez ensuite cet écran. Ne recréez pas ces produits ici : cela ferait des doublons.</>
              )}
            </p> : (
              <select className="champ" value={produitId} onChange={(e) => { setProduitId(e.target.value); setArticleId(''); }}>
                <option value="">Choisir un produit…</option>
                {produits.map((p) => <option key={p.id} value={p.id}>{LIBELLES_CATEGORIES_INVENTAIRE[p.categorie] ?? p.categorie} · {p.nom}</option>)}
              </select>
            )}
          </div>

          {produit && <div className="rounded-jeton border border-filet bg-carte p-4">
            <h2 className="text-lg font-bold">{produit.nom}</h2>
            <p className="mb-3 text-sm text-doux">{produit.code} · {produit.unite} · {produit.prix} FCFA</p>
            {derive(produit.role) ? <Info>Cette ligne a des sorties calculées ; elle ne prend pas de recette.</Info> : (
              <>
                <h3 className="mb-2 font-semibold">Articles qui consomment ce produit</h3>
                {recettes.length === 0 && <p className="mb-3 text-sm text-doux">Aucun article lié : les sorties de ce produit restent à zéro.</p>}
                <div className="mb-4 grid gap-2">
                  {recettes.map((r) => <div key={r.id} className="flex items-center justify-between gap-2 rounded-btn border border-filet px-3 py-2 text-sm">
                    <span>{data?.articles.find((a) => a.id === r.article_id)?.nom ?? '(article absent du catalogue siège)'}</span>
                    <span className="chiffres">{Number(r.quantite)} {produit.unite}</span>
                    {!lectureSeule && <button type="button" className="btn-blanc !min-h-[34px] !px-2 !text-xs" onClick={() => {
                      setArticleId(r.article_id); setQuantite(String(r.quantite)); setRechercheArticle('');
                    }}>Modifier</button>}
                  </div>)}
                </div>
                {!lectureSeule && <form className="grid gap-3 border-t border-filet pt-3" onSubmit={(e) => { e.preventDefault(); enregistrer.mutate(); }}>
                  <h3 className="font-semibold">Ajouter ou modifier une liaison</h3>
                  <label className="block text-sm text-doux">Rechercher un article vendu
                    <input className="champ mt-1" value={rechercheArticle} onChange={(e) => setRechercheArticle(e.target.value)} placeholder="Nom de l’article" />
                  </label>
                  <label className="block text-sm text-doux">Article
                    <select className="champ mt-1" value={articleId} onChange={(e) => setArticleId(e.target.value)} required>
                      <option value="">Choisir un article…</option>
                      {candidats.map((a) => <option key={a.id} value={a.id}>{a.nom}</option>)}
                      {articleId && !candidats.some((a) => a.id === articleId) &&
                        <option value={articleId}>{data?.articles.find((a) => a.id === articleId)?.nom ?? 'Article actuel'}</option>}
                    </select>
                  </label>
                  <label className="block text-sm text-doux">Quantité de {produit.unite} consommée par vente
                    <input className="champ mt-1" type="number" min="0.001" max="1000" step="0.001" value={quantite} onChange={(e) => setQuantite(e.target.value)} required />
                  </label>
                  <button type="submit" className="btn-accent" disabled={enregistrer.isPending || !articleId || !quantiteValide}>
                    {enregistrer.isPending ? 'Enregistrement…' : 'Enregistrer la recette'}
                  </button>
                </form>}
              </>
            )}
          </div>}
        </>
      ))}
    </section>
  );
}
