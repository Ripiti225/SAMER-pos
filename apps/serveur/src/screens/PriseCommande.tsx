import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  IconArrowLeft,
  IconCheck,
  IconChevronUp,
  IconMinus,
  IconPlus,
  IconReceipt,
  IconSend,
  IconX,
} from '@tabler/icons-react';
import type { ArticleVue, CatalogueVue, CommandeVue, StockPlatsVue, TableVue } from '@pos/shared';
import { categorieVisiblePour, couleurCategorie, formatFCFA, uuidLocal } from '@pos/shared';
import { api, BandeStock, INTERVALLE_STOCK_PLATS_MS, Modale } from '@pos/shared-ui';
import { fileAttente } from '../file-attente';
import { FactureNumerique } from '../components/FactureNumerique';

interface LignePanier {
  cle: string;
  article_id: string | null;
  combo_id: string | null;
  nom: string;
  prix_affiche: number;
  quantite: number;
  options: { groupe: string; choix: string[] }[];
  supplements: { id: string; nom: string; prix: number }[];
}

/**
 * Prise de commande serveur (§B2) : panier LOCAL sur le terminal, puis un seul
 * bouton « Envoyer en cuisine ». L'envoi passe par la file anti-coupure :
 * même WiFi coupé, la commande part dès la reconnexion, sans doublon.
 * Ajout en plusieurs fois : chaque envoi ne contient que les nouveaux articles.
 *
 * Deux mises en page, même code :
 * - téléphone (< lg) : catégories en bandeau horizontal, articles en pleine
 *   largeur, panier en tiroir bas appelé par la barre « Envoyer en cuisine » ;
 * - tablette (≥ lg) : les trois colonnes historiques (catégories / articles /
 *   panier). En dessous de 1024 px les 464 px de colonnes fixes ne laissaient
 *   plus rien aux articles — c'était le défaut sur téléphone.
 */
export function PriseCommande({
  tableId,
  restaurant,
  marque,
  onRetour,
  afficherToast,
}: {
  tableId: string;
  restaurant: string;
  /** Marque du restaurant : les teintes de catégorie en dépendent (§ 4.1). */
  marque: string;
  onRetour: () => void;
  afficherToast: (m: string) => void;
}) {
  const [categorieId, setCategorieId] = useState<string | null>(null);
  const [articleOuvert, setArticleOuvert] = useState<ArticleVue | null>(null);
  const [panier, setPanier] = useState<LignePanier[]>([]);
  const [tiroirPanier, setTiroirPanier] = useState(false);
  const [factureOuverte, setFactureOuverte] = useState(false);

  const { data: catalogue } = useQuery({
    queryKey: ['catalogue'],
    queryFn: () => api<CatalogueVue>('/api/catalogue'),
    staleTime: 5 * 60 * 1000,
  });
  // Stock en cuisine sous la photo : une requête pour toute la carte,
  // relue sur les événements WebSocket (NotificationsServeur) et chaque minute.
  const { data: stockPlats } = useQuery({
    queryKey: ['stock-plats'],
    queryFn: () => api<StockPlatsVue>('/api/stock-plats'),
    staleTime: 10_000,
    refetchInterval: INTERVALLE_STOCK_PLATS_MS,
  });
  const { data: tables } = useQuery({
    queryKey: ['tables'],
    queryFn: () => api<TableVue[]>('/api/tables'),
  });
  const table = tables?.find((t) => t.id === tableId);

  // Commande déjà en cours sur la table (articles déjà envoyés)
  const { data: commande, refetch: rafraichirCommande } = useQuery({
    queryKey: ['commande', table?.commande_id],
    queryFn: () => api<CommandeVue>(`/api/commandes/${table!.commande_id}`),
    enabled: !!table?.commande_id,
  });

  // Catégories réservées à un partenaire (migration 0023). Le partenaire vient
  // de la commande en cours si elle existe, sinon de la table elle-même : les
  // tables virtuelles Yango/Glovo/Samer Delly le portent, et c'est par elles
  // qu'un serveur saisit une commande partenaire depuis la tablette.
  const partenaireEnCours = commande?.partenaire ?? table?.partenaire ?? null;
  const categories = (catalogue?.categories ?? []).filter((c) =>
    categorieVisiblePour(c.partenaires, partenaireEnCours),
  );
  const categorieActive = categorieId ?? categories[0]?.id ?? null;
  const articlesVisibles = (catalogue?.articles ?? []).filter((a) => a.categorie_id === categorieActive);
  const combosVisibles = categorieActive === categories[0]?.id ? catalogue?.combos ?? [] : [];
  // Couleur de la catégorie (§ 4.1) : pastille dans la liste, liseré et fond
  // de la vignette — les mêmes repères qu'à la caisse.
  const couleurDe = (categorieIdArticle: string | null) =>
    couleurCategorie(categories.find((c) => c.id === categorieIdArticle)?.nom ?? '', marque);

  const totalPanier = panier.reduce(
    (s, l) => s + (l.prix_affiche + l.supplements.reduce((x, y) => x + y.prix, 0)) * l.quantite,
    0,
  );
  const nbArticles = panier.reduce((s, l) => s + l.quantite, 0);

  const ajouterAuPanier = (ligne: Omit<LignePanier, 'cle'>) => {
    setPanier((p) => [...p, { ...ligne, cle: uuidLocal() }]);
  };

  const clicArticle = (a: ArticleVue) => {
    if (!a.disponible) return;
    if (a.options_extras.length > 0) {
      setArticleOuvert(a);
    } else {
      ajouterAuPanier({ article_id: a.id, combo_id: null, nom: a.nom, prix_affiche: a.prix_base, quantite: 1, options: [], supplements: [] });
    }
  };

  const envoyerEnCuisine = async () => {
    if (panier.length === 0) return;
    await fileAttente.enfiler('ENVOYER_CUISINE', {
      action_uuid: uuidLocal(),
      table_id: tableId,
      items: panier.map((l) => ({
        article_id: l.article_id,
        combo_id: l.combo_id,
        quantite: l.quantite,
        options: l.options,
        supplements: l.supplements.map((s) => ({ id: s.id })),
      })),
    });
    setPanier([]);
    setTiroirPanier(false);
    afficherToast('Envoyé en cuisine ✔ (livraison garantie même si le WiFi coupe)');
  };

  const demanderAddition = async () => {
    await fileAttente.enfiler('DEMANDER_ADDITION', {
      action_uuid: uuidLocal(),
      table_id: tableId,
    });
    afficherToast('Addition demandée — la caisse est prévenue');
    await rafraichirCommande();
    setFactureOuverte(true);
  };

  // Marquer la commande SERVIE (le serveur peut le faire depuis son app, pas
  // seulement la cuisine). Disponible dès que la commande est PRÊTE.
  const servir = async () => {
    if (!table?.commande_id) return;
    try {
      await api(`/api/commandes/${table.commande_id}/servir`, { method: 'POST', corps: {} });
      afficherToast('Commande servie ✔');
      onRetour();
    } catch (e) {
      afficherToast((e as Error).message);
    }
  };

  const modifierQuantite = (cle: string, delta: number) =>
    setPanier((p) => p.map((x) => (x.cle === cle ? { ...x, quantite: Math.max(1, x.quantite + delta) } : x)));
  const retirer = (cle: string) => setPanier((p) => p.filter((x) => x.cle !== cle));

  // Le SEUL aplat de marque de l'écran : c'est le geste qui compte.
  const boutonEnvoyer = (
    <button
      type="button"
      className="flex h-14 w-full items-center justify-center gap-2 rounded-btn bg-marque px-3 text-lg font-bold text-sur-marque transition hover:brightness-105 active:translate-y-px disabled:opacity-40"
      disabled={panier.length === 0}
      onClick={() => void envoyerEnCuisine()}
    >
      <IconSend size={20} className="flex-none" />
      {/* Le total passe SOUS le libellé : sur la ligne, il coupait « cuisine »
          dans le panneau de 320 px. */}
      <span className="flex min-w-0 flex-col items-start leading-tight">
        <span className="truncate">Envoyer en cuisine</span>
        {panier.length > 0 && <span className="text-sm font-semibold tabular-nums opacity-80">{formatFCFA(totalPanier)}</span>}
      </span>
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {factureOuverte && commande && (
        <FactureNumerique commande={commande} restaurant={restaurant} onFermer={() => setFactureOuverte(false)} />
      )}
      {/* Barre de table, sur le plan clair — les actions passent à la ligne sur écran étroit. */}
      <div className="marge-sure-cotes flex flex-none flex-wrap items-center gap-2 border-b border-filet bg-carte px-2 py-2 sm:px-3">
        <button
          type="button"
          onClick={onRetour}
          title="Retour à la salle"
          aria-label="Retour à la salle"
          className="flex h-11 w-11 flex-none items-center justify-center rounded-btn text-txt-doux transition hover:bg-carte-douce hover:text-txt"
        >
          <IconArrowLeft size={22} />
        </button>
        <div className="min-w-0">
          <div className="text-lg font-bold leading-tight text-txt sm:text-xl">Table {table?.numero ?? '…'}</div>
          {commande && (
            <div className="text-xs font-medium tabular-nums text-txt-doux sm:text-sm">
              Ticket n° {commande.numero_ticket} · {formatFCFA(commande.total)}
            </div>
          )}
        </div>
        <div className="ml-auto flex flex-none items-center gap-2">
          {commande?.statut === 'PRETE' && (
            <button
              type="button"
              className="flex min-h-[44px] items-center gap-1.5 rounded-btn bg-ok px-3 font-bold text-white transition hover:brightness-105 active:translate-y-px sm:px-4"
              onClick={() => void servir()}
            >
              <IconCheck size={18} stroke={3} /> Servi
            </button>
          )}
          <button
            type="button"
            className="btn-blanc flex min-h-[44px] items-center gap-1.5 px-3 sm:px-4"
            disabled={!table?.commande_id && panier.length === 0}
            onClick={() => void demanderAddition()}
          >
            <IconReceipt size={18} />
            <span className="hidden sm:inline">Demander l’addition</span>
            <span className="sm:hidden">Addition</span>
          </button>
        </div>
      </div>

      {/* Catégories en bandeau horizontal, sur l'ossature — téléphone et tablette debout. */}
      <nav className="defile-x flex flex-none gap-1.5 border-b border-ard-700 bg-ard-800 p-2 lg:hidden">
        {categories.map((c) => {
          const actif = c.id === categorieActive;
          return (
            <button
              key={c.id}
              type="button"
              className={`flex min-h-[44px] flex-none items-center gap-2 whitespace-nowrap rounded-btn px-3.5 text-sm font-semibold transition ${
                actif ? 'bg-ard-650 text-ard-txt' : 'text-ard-txt-doux'
              }`}
              onClick={() => setCategorieId(c.id)}
            >
              <span className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: couleurCategorie(c.nom, marque) }} />
              {c.nom}
            </button>
          );
        })}
      </nav>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Colonne catégories en ardoise : uniquement quand l'écran est assez large. */}
        <nav className="hidden w-44 shrink-0 flex-col gap-1.5 overflow-y-auto border-r border-ard-700 bg-ard-800 p-2.5 lg:flex">
          <p className="px-2 pb-1 pt-1 text-[10.5px] font-bold uppercase tracking-[0.09em] text-ard-txt-faible">Catégories</p>
          {categories.map((c) => {
            const actif = c.id === categorieActive;
            return (
              <button
                key={c.id}
                type="button"
                className={`flex items-center gap-2.5 rounded-btn px-3 py-3 text-left text-sm font-semibold transition ${
                  actif ? 'bg-ard-700 text-ard-txt' : 'text-ard-txt-doux hover:bg-ard-750 hover:text-ard-txt'
                }`}
                onClick={() => setCategorieId(c.id)}
              >
                <span
                  className={`h-2.5 w-2.5 flex-none rounded-full transition-transform ${actif ? 'scale-150' : ''}`}
                  style={{ background: couleurCategorie(c.nom, marque) }}
                />
                <span className="min-w-0 flex-1 truncate">{c.nom}</span>
              </button>
            );
          })}
        </nav>

        {/* Grille d'articles sur le plan clair : `auto-fill`, la grille suit la
            largeur réelle de la colonne (même logique que la caisse). */}
        <main className="grid min-w-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2 overflow-y-auto bg-plan p-2 sm:gap-3 sm:p-3">
          {combosVisibles.map((combo) => (
            <button
              key={combo.id}
              type="button"
              disabled={!combo.disponible}
              style={{ borderLeft: '4px solid var(--marque)' }}
              className="carte flex flex-col overflow-hidden p-0 text-left transition active:scale-[0.98] disabled:opacity-45"
              onClick={() =>
                ajouterAuPanier({ article_id: null, combo_id: combo.id, nom: combo.nom, prix_affiche: combo.prix, quantite: 1, options: [], supplements: [] })
              }
            >
              <div className="flex h-[84px] w-full items-center justify-center bg-marque p-2 text-center text-sm font-bold leading-tight text-sur-marque">
                {combo.nom}
              </div>
              <div className="flex items-center justify-between gap-1 p-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-txt-doux">Combo</span>
                <span className="font-bold tabular-nums text-txt">{formatFCFA(combo.prix)}</span>
              </div>
            </button>
          ))}
          {articlesVisibles.map((a) => {
            const couleur = couleurDe(a.categorie_id);
            return (
              <button
                key={a.id}
                type="button"
                disabled={!a.disponible}
                style={{ borderLeft: `4px solid ${couleur}` }}
                className="carte flex flex-col overflow-hidden p-0 text-left transition active:scale-[0.98]"
                onClick={() => clicArticle(a)}
              >
                <div
                  className="relative h-[84px] w-full overflow-hidden"
                  style={{ background: `color-mix(in srgb, ${couleur} 11%, var(--carte))` }}
                >
                  {a.image_url && <img src={a.image_url} alt="" loading="lazy" className="h-full w-full object-contain" />}
                  {!a.disponible && (
                    <div className="absolute inset-0 flex items-center justify-center bg-carte/70">
                      <span className="rounded-full bg-alerte px-2.5 py-0.5 text-xs font-bold text-white">Épuisé</span>
                    </div>
                  )}
                  {/* Stock en cuisine : informe le serveur, ne bloque jamais l'envoi. */}
                  {a.disponible && <BandeStock stock={stockPlats?.plats[a.id]} />}
                </div>
                <div className="flex flex-1 flex-col gap-0.5 p-2">
                  <div className="line-clamp-2 text-sm font-semibold leading-tight text-txt">{a.nom}</div>
                  <div className="mt-auto font-bold tabular-nums text-txt">{formatFCFA(a.prix_base)}</div>
                </div>
              </button>
            );
          })}
        </main>

        {/* Panier en panneau ardoise : tablette et plus (comme l'addition de la caisse). */}
        <aside className="hidden w-80 shrink-0 flex-col border-l border-ard-700 bg-ard-850 text-ard-txt lg:flex">
          <div className="flex-1 overflow-y-auto p-3">
            <ContenuPanier
              commande={commande}
              panier={panier}
              onQuantite={modifierQuantite}
              onRetirer={retirer}
            />
          </div>
          {/* Bouton UNIQUE « Envoyer en cuisine » (§B2) — pas d'encaissement ici */}
          <div className="border-t border-ard-700 bg-ard-900 p-3">{boutonEnvoyer}</div>
        </aside>
      </div>

      {/* Barre panier collante — téléphone : le panier reste à un pouce. */}
      <div className="marge-sure-bas marge-sure-cotes flex flex-none flex-col gap-2 border-t border-ard-700 bg-ard-900 p-2 pt-2 lg:hidden">
        <button
          type="button"
          className="flex min-h-[44px] items-center justify-between gap-2 rounded-btn bg-ard-800 px-3 text-left text-ard-txt transition active:translate-y-px"
          onClick={() => setTiroirPanier(true)}
        >
          <span className="min-w-0 truncate text-sm font-semibold text-ard-txt-doux">
            {nbArticles > 0 ? `Panier · ${nbArticles} article${nbArticles > 1 ? 's' : ''}` : 'Panier vide'}
            {commande && commande.items.length > 0 ? ' · voir la cuisine' : ''}
          </span>
          <span className="flex flex-none items-center gap-1 font-bold tabular-nums">
            {formatFCFA(totalPanier)} <IconChevronUp size={18} />
          </span>
        </button>
        {boutonEnvoyer}
      </div>

      {/* Tiroir bas : détail du panier + quantités (téléphone). */}
      {tiroirPanier && (
        <div className="fixed inset-0 z-40 flex flex-col justify-end bg-black/50 lg:hidden" onClick={() => setTiroirPanier(false)}>
          <div
            className="marge-sure-bas flex max-h-[80dvh] flex-col rounded-t-jeton bg-ard-850 text-ard-txt"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-none items-center justify-between border-b border-ard-700 p-3">
              <h2 className="text-lg font-bold">Panier — Table {table?.numero ?? '…'}</h2>
              <button
                type="button"
                aria-label="Fermer le panier"
                className="flex h-11 w-11 items-center justify-center rounded-btn text-ard-txt-doux transition hover:bg-ard-750 hover:text-ard-txt"
                onClick={() => setTiroirPanier(false)}
              >
                <IconX size={22} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <ContenuPanier
                commande={commande}
                panier={panier}
                onQuantite={modifierQuantite}
                onRetirer={retirer}
              />
            </div>
            <div className="flex-none border-t border-ard-700 bg-ard-900 p-3">{boutonEnvoyer}</div>
          </div>
        </div>
      )}

      {articleOuvert && (
        <ModaleArticle
          article={articleOuvert}
          onAjouter={(ligne) => {
            ajouterAuPanier(ligne);
            setArticleOuvert(null);
          }}
          onFermer={() => setArticleOuvert(null)}
        />
      )}
    </div>
  );
}

/** Détail du panier, sur ardoise — partagé par la colonne (tablette) et le tiroir (téléphone). */
function ContenuPanier({
  commande,
  panier,
  onQuantite,
  onRetirer,
}: {
  commande: CommandeVue | undefined;
  panier: LignePanier[];
  onQuantite: (cle: string, delta: number) => void;
  onRetirer: (cle: string) => void;
}) {
  return (
    <div className="space-y-2">
      {commande && commande.items.length > 0 && (
        <div className="mb-3 rounded-[var(--r-sm)] border border-dashed border-ard-600 p-3">
          <div className="mb-1.5 text-[10.5px] font-bold uppercase tracking-[0.09em] text-ard-txt-faible">Déjà en cuisine</div>
          {commande.items.map((i) => (
            <div
              key={i.id}
              className={`flex gap-2 text-sm ${i.statut_cuisine === 'ANNULE' ? 'text-alerte-txt line-through' : 'text-ard-txt-doux'}`}
            >
              <span className="w-6 flex-none text-right font-semibold tabular-nums">{i.quantite}×</span>
              <span className="min-w-0 break-words">{i.nom_snapshot}</span>
            </div>
          ))}
        </div>
      )}

      <div className="text-[10.5px] font-bold uppercase tracking-[0.09em] text-ard-txt-faible">Nouveaux articles</div>
      {panier.length === 0 && <div className="pt-6 text-center text-sm text-ard-txt-faible">Panier vide — touchez un article</div>}
      {panier.map((l) => (
        <div key={l.cle} className="rounded-[var(--r-sm)] bg-ard-800 p-3">
          <div className="flex justify-between gap-2">
            <div className="min-w-0 break-words font-semibold">{l.nom}</div>
            <div className="flex-none font-bold tabular-nums">
              {formatFCFA((l.prix_affiche + l.supplements.reduce((x, y) => x + y.prix, 0)) * l.quantite)}
            </div>
          </div>
          {l.supplements.map((s) => (
            <div key={s.id} className="text-xs text-ard-txt-doux">+ {s.nom}</div>
          ))}
          {l.options.filter((o) => o.choix.length > 0).map((o) => (
            <div key={o.groupe} className="text-xs text-ard-txt-doux">{o.groupe} : {o.choix.join(', ')}</div>
          ))}
          <div className="mt-2 flex items-center gap-2">
            <div className="flex h-11 items-center overflow-hidden rounded-btn bg-ard-700">
              <button
                type="button"
                aria-label="Retirer un"
                className="flex h-full w-11 items-center justify-center text-marque-clair transition hover:bg-ard-650"
                onClick={() => onQuantite(l.cle, -1)}
              >
                <IconMinus size={18} />
              </button>
              <span className="w-8 text-center font-bold tabular-nums">{l.quantite}</span>
              <button
                type="button"
                aria-label="Ajouter un"
                className="flex h-full w-11 items-center justify-center text-marque-clair transition hover:bg-ard-650"
                onClick={() => onQuantite(l.cle, 1)}
              >
                <IconPlus size={18} />
              </button>
            </div>
            <button
              type="button"
              aria-label="Retirer l’article"
              className="ml-auto flex h-11 w-11 items-center justify-center rounded-full text-ard-txt-faible transition hover:bg-alerte/20 hover:text-alerte-txt"
              onClick={() => onRetirer(l.cle)}
            >
              <IconX size={20} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ModaleArticle({
  article,
  onAjouter,
  onFermer,
}: {
  article: ArticleVue;
  onAjouter: (ligne: Omit<LignePanier, 'cle'>) => void;
  onFermer: () => void;
}) {
  const [quantite, setQuantite] = useState(1);
  // Liste plate d'extras à cocher (migration 0020) : chaque option porte son
  // prix, 0 = offerte. Mêmes options que la caisse — même source serveur.
  const [choisies, setChoisies] = useState<string[]>([]);

  const optionsChoisies = article.options_extras.filter((o) => choisies.includes(o.id));
  const prixLigne = (article.prix_base + optionsChoisies.reduce((x, y) => x + y.prix, 0)) * quantite;

  return (
    <Modale titre={article.nom} onFermer={onFermer} enfants={
      <div className="space-y-5">
        {article.options_extras.length > 0 && (
          <div>
            <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.09em] text-txt-doux">Options</div>
            <div className="flex flex-wrap gap-2">
              {article.options_extras.map((o) => {
                const coche = choisies.includes(o.id);
                return (
                  <button
                    key={o.id}
                    type="button"
                    aria-pressed={coche}
                    className={`flex min-h-[48px] items-center gap-2 rounded-btn border-2 px-3 text-sm font-semibold transition ${
                      coche ? 'border-marque bg-marque-tint text-txt' : 'border-filet bg-carte text-txt'
                    }`}
                    onClick={() =>
                      setChoisies((prev) => (prev.includes(o.id) ? prev.filter((x) => x !== o.id) : [...prev, o.id]))
                    }
                  >
                    {coche && <IconCheck size={16} stroke={3} />}
                    {o.nom}
                    <span className="font-normal text-txt-doux">{o.prix > 0 ? `+${formatFCFA(o.prix)}` : 'offert'}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="flex items-center gap-3">
          <button type="button" aria-label="Moins" className="btn-blanc flex h-12 w-12 items-center justify-center p-0" onClick={() => setQuantite(Math.max(1, quantite - 1))}>
            <IconMinus size={20} />
          </button>
          <span className="w-10 text-center text-2xl font-bold tabular-nums">{quantite}</span>
          <button type="button" aria-label="Plus" className="btn-blanc flex h-12 w-12 items-center justify-center p-0" onClick={() => setQuantite(quantite + 1)}>
            <IconPlus size={20} />
          </button>
        </div>
        <button
          type="button"
          className="btn-accent w-full py-4 text-lg"
          onClick={() =>
            onAjouter({
              article_id: article.id,
              combo_id: null,
              nom: article.nom,
              prix_affiche: article.prix_base,
              quantite,
              options: [],
              supplements: optionsChoisies.map((o) => ({ id: o.id, nom: o.nom, prix: o.prix })),
            })
          }
        >
          Ajouter · {formatFCFA(prixLigne)}
        </button>
      </div>
    } />
  );
}
