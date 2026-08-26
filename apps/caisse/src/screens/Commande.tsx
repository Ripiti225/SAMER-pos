import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  IconArrowLeft,
  IconMinus,
  IconPlus,
  IconPrinter,
  IconSearch,
  IconSend,
  IconTag,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import type { ArticleVue, CatalogueVue, CommandeItemVue, CommandeVue } from '@pos/shared';
import {
  categorieVisiblePour,
  couleurCategorie,
  estLivraisonSansEncaissement,
  formatFCFA,
  LIBELLES_TYPES_COMMANDE,
} from '@pos/shared';
import { api } from '../api';
import { Modale } from '../components/Modale';
import { ModalePinManager } from '../components/ModalePinManager';
import { PiluleSync } from '../components/SanteSync';
import { useSaisieOptimiste } from '../saisie-optimiste';
import { useCaisse } from '../stores/session';

export function Commande() {
  const { commandeId, aller, afficherToast, session } = useCaisse();
  const queryClient = useQueryClient();
  const [categorieId, setCategorieId] = useState<string | null>(null);
  const [recherche, setRecherche] = useState('');
  const [articleOuvert, setArticleOuvert] = useState<ArticleVue | null>(null);
  const [itemAAnnuler, setItemAAnnuler] = useState<CommandeItemVue | null>(null);
  const [remiseOuverte, setRemiseOuverte] = useState(false);
  const [offrirOuvert, setOffrirOuvert] = useState(false);
  const [annulationOuverte, setAnnulationOuverte] = useState(false);

  const { data: catalogue } = useQuery({
    queryKey: ['catalogue'],
    queryFn: () => api<CatalogueVue>('/api/catalogue'),
    staleTime: 5 * 60 * 1000,
  });
  const { data: commande } = useQuery({
    queryKey: ['commande', commandeId],
    queryFn: () => api<CommandeVue>(`/api/commandes/${commandeId}`),
    enabled: !!commandeId,
  });

  const rafraichir = (vue: CommandeVue) => queryClient.setQueryData(['commande', commandeId], vue);
  const surErreur = (e: Error) => afficherToast(e.message);

  // Ajout d'article et changement de quantité : saisie OPTIMISTE — l'écran suit
  // le doigt sans attendre le serveur, mais aucun montant n'est jamais calculé
  // ici (promo, prix de canal et écrêtage des remises restent serveur).
  // Voir saisie-optimiste.ts.
  const saisie = useSaisieOptimiste(commandeId, surErreur);
  const annulerItem = useMutation({
    mutationFn: ({ itemId, motif, pin }: { itemId: string; motif: string; pin?: string }) =>
      api<CommandeVue>(`/api/commandes/${commandeId}/items/${itemId}/annuler`, {
        method: 'POST',
        corps: { motif, pin_manager: pin ?? null },
      }),
    onSuccess: (vue) => { rafraichir(vue); setItemAAnnuler(null); },
    onError: surErreur,
  });
  const envoyerCuisine = useMutation({
    mutationFn: () => api<CommandeVue>(`/api/commandes/${commandeId}/envoyer`, { method: 'POST', corps: {} }),
    onSuccess: (vue) => { rafraichir(vue); afficherToast('Commande envoyée en cuisine'); },
    onError: surErreur,
  });
  const imprimerFacture = useMutation({
    mutationFn: () => api<CommandeVue>(`/api/commandes/${commandeId}/facture`, { method: 'POST', corps: {} }),
    onSuccess: (vue) => { rafraichir(vue); afficherToast('Facture envoyée à l’imprimante'); },
    onError: surErreur,
  });
  const appliquerRemise = useMutation({
    mutationFn: ({ montant, motif, pin }: { montant: number; motif: string; pin: string }) =>
      api<CommandeVue>(`/api/commandes/${commandeId}/remise`, { method: 'POST', corps: { montant, motif, pin_manager: pin } }),
    onSuccess: (vue) => { rafraichir(vue); setRemiseOuverte(false); afficherToast('Remise appliquée'); },
    onError: surErreur,
  });
  // Kdo : clôture sans encaissement. Le motif part au serveur, qui le grave
  // dans le journal d'audit et sur le ticket.
  const offrir = useMutation({
    mutationFn: (motif: string) =>
      api<CommandeVue>(`/api/commandes/${commandeId}/offrir`, { method: 'POST', corps: { motif } }),
    onSuccess: (vue) => {
      rafraichir(vue);
      setOffrirOuvert(false);
      afficherToast('Kdo validé — rien encaissé');
      aller('accueil');
    },
    onError: surErreur,
  });
  /**
   * Annulation de TOUTE la commande : c'est le geste qui rend la table à la
   * salle quand des produits ont déjà été tapés. PIN manager + motif, comme
   * l'annulation d'un article envoyé — et les plats déjà lancés en cuisine
   * repartent en RETOURS (clôture, ticket Z, Mes ventes, Supervision). Vider
   * une table n'efface donc jamais ce qui a été produit.
   */
  const annulerCommande = useMutation({
    mutationFn: ({ motif, pin }: { motif: string; pin: string }) =>
      api<CommandeVue>(`/api/commandes/${commandeId}/annuler`, {
        method: 'POST',
        corps: { motif, pin_manager: pin },
      }),
    onSuccess: () => {
      setAnnulationOuverte(false);
      void queryClient.invalidateQueries({ queryKey: ['tables'] });
      void queryClient.invalidateQueries({ queryKey: ['commandes-ouvertes'] });
      afficherToast('Commande annulée — les plats déjà lancés restent tracés en retours');
      aller('accueil');
    },
    onError: surErreur,
  });
  // La caisse peut aussi marquer une commande SERVIE (pas seulement la cuisine).
  const servir = useMutation({
    mutationFn: () => api<CommandeVue>(`/api/commandes/${commandeId}/servir`, { method: 'POST', corps: {} }),
    onSuccess: (vue) => { rafraichir(vue); afficherToast('Commande servie ✔'); },
    onError: surErreur,
  });

  if (!commande || !catalogue) {
    return <div className="flex min-h-full items-center justify-center text-doux">Chargement…</div>;
  }

  // Catégories réservées à un partenaire (migration 0023) : « Glovo spéciale »
  // n'apparaît que sur une commande Glovo. Le catalogue reçu les contient
  // toutes — la caisse prend aussi bien une commande en salle qu'une commande
  // partenaire — c'est ici qu'on tranche, selon la commande en cours.
  const categories = catalogue.categories.filter((c) =>
    categorieVisiblePour(c.partenaires, commande.partenaire),
  );
  const idsCategoriesVisibles = new Set(categories.map((c) => c.id));
  const categorieActive = categorieId ?? categories[0]?.id ?? null;
  const rechTrim = recherche.trim().toLowerCase();
  const enRecherche = rechTrim.length > 0;
  // La recherche est bornée aux mêmes catégories : sans ça, taper « spécial »
  // ferait remonter un plat Glovo dans une commande en salle.
  const articlesVisibles = enRecherche
    ? catalogue.articles.filter(
        (a) => idsCategoriesVisibles.has(a.categorie_id) && a.nom.toLowerCase().includes(rechTrim),
      )
    : catalogue.articles.filter((a) => a.categorie_id === categorieActive);
  const combosVisibles = !enRecherche && categorieActive === categories[0]?.id ? catalogue.combos : [];
  const itemsActifs = commande.items.filter((i) => i.statut_cuisine !== 'ANNULE');
  const prenom = session?.utilisateur.nom_complet.split(' ')[0] ?? '';

  /**
   * Sortir d'une table où RIEN n'a été tapé la relibère : la commande vide est
   * abandonnée côté serveur (elle ne retient ni le plan de salle, ni la
   * clôture). Une table ouverte par erreur reste donc une table LIBRE.
   * Le serveur revérifie qu'aucune ligne n'existe — c'est lui qui tranche.
   */
  const quitter = async () => {
    if (commande.items.length === 0 && !saisie.enAttente) {
      try {
        await api(`/api/commandes/${commandeId}/abandonner`, { method: 'POST', corps: {} });
      } catch {
        // Sans réseau ni serveur, la table redevient de toute façon LIBRE :
        // une commande sans article n'occupe rien (état dérivé serveur).
      }
    }
    aller('accueil');
  };

  /**
   * Même geste que « Accueil » quand rien n'a été tapé, mais DIT : le caissier
   * qui veut vider une table ouverte par erreur cherche un bouton pour ça, pas
   * une flèche de retour. Aucun PIN : il n'y a rien à cacher.
   */
  const libererVide = async () => {
    await quitter();
    afficherToast(commande.table_numero ? `Table ${commande.table_numero} libérée` : 'Commande fermée');
  };

  // Code couleur du menu (§ 4.1 / § 7). La catégorie n'a pas de couleur en
  // base : elle vient de son nom, via le helper partagé — même teinte partout.
  const nomCategorie = new Map(categories.map((c) => [c.id, c.nom]));
  const couleurArticle = (articleId: string | null): string => {
    const article = articleId ? catalogue.articles.find((a) => a.id === articleId) : undefined;
    // Un combo n'appartient à aucune catégorie : il prend la couleur de marque.
    if (!article) return 'var(--marque)';
    return couleurCategorie(nomCategorie.get(article.categorie_id) ?? '');
  };

  /**
   * Taper la carte ajoute TOUJOURS le produit nu, même s'il a des options :
   * le client n'a le plus souvent rien demandé, et le caissier doit pouvoir
   * enchaîner sans qu'une modale s'interpose. Les options passent par le
   * bouton « + » de la carte.
   */
  const clicArticle = (a: ArticleVue) => {
    if (!a.disponible) return;
    saisie.ajouter(a.nom, 1, { article_id: a.id, quantite: 1, options: [], supplements: [] });
  };

  return (
    <div className="flex h-screen flex-col">
      {/* ---------- Barre ardoise (§ 6.4) ---------- */}
      <header className="flex h-[62px] flex-none items-center justify-between border-b border-ard-700 bg-ard-900 px-3.5 text-ard-txt">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={() => void quitter()}
            className="flex flex-none items-center gap-2 rounded-btn px-3 py-2 font-semibold text-ard-txt-doux transition hover:bg-ard-750 hover:text-ard-txt"
            title="Retour à l’accueil"
          >
            <IconArrowLeft size={19} />
            Accueil
          </button>
          <span className="h-6 w-px flex-none bg-ard-600" />
          <div className="min-w-0">
            <div className="truncate text-[17px] font-semibold tracking-tight">{session?.restaurant.nom}</div>
            <div className="truncate text-[12.5px] font-medium text-ard-txt-doux">
              Caissier : {prenom} · Service ouvert
            </div>
          </div>
        </div>
        <PiluleSync />
      </header>

      {/* Même ossature que le plan de salle : catégories / plan clair / addition,
          toujours en trois colonnes. L'addition vaut les 356 px de la maquette
          dès ~1320 px et se resserre en dessous, pour que la grille d'articles
          reste nettement la plus large sur un écran 1024. */}
      <div className="grid min-h-0 flex-1 grid-cols-[186px_1fr_clamp(280px,27vw,356px)]">
        {/* Colonne catégories, en ardoise avec les libellés (pas un rail d'icônes) */}
        <nav className="flex flex-col gap-[7px] overflow-y-auto border-r border-ard-700 bg-ard-800 p-3">
          <p className="px-3 pb-2.5 pt-1.5 text-[10.5px] font-bold uppercase tracking-[0.09em] text-ard-txt-faible">
            Catégories
          </p>
          {/* Pastille de la couleur de catégorie (§ 4.1) : c'est la même teinte
              que le liseré des cartes et le point des lignes d'addition — le
              caissier retrouve la famille du produit d'un écran à l'autre.
              Elle grossit sur la catégorie ouverte, comme la maquette. */}
          {categories.map((c) => {
            const actif = !enRecherche && c.id === categorieActive;
            const nb = catalogue.articles.filter((a) => a.categorie_id === c.id).length;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => { setCategorieId(c.id); setRecherche(''); }}
                className={`flex items-center gap-[11px] rounded-btn px-3 py-3.5 text-left text-[14.5px] font-semibold transition ${
                  actif ? 'bg-ard-700 text-ard-txt' : 'text-ard-txt-doux hover:bg-ard-750 hover:text-ard-txt'
                }`}
              >
                <span
                  className={`h-2.5 w-2.5 flex-none rounded-full transition-transform duration-200 ${actif ? 'scale-150' : ''}`}
                  style={{ background: couleurCategorie(c.nom) }}
                />
                <span className="truncate">{c.nom}</span>
                <span className="ml-auto flex-none text-[11.5px] font-semibold text-ard-txt-faible">{nb}</span>
              </button>
            );
          })}
        </nav>

        {/* Grille produits — plan de travail CLAIR */}
        <section className="flex min-w-0 flex-col overflow-hidden bg-plan p-5">
          <div className="mb-4 flex-none">
            <div className="relative max-w-sm">
              <IconSearch size={20} className="absolute left-3 top-1/2 -translate-y-1/2 text-doux" />
              <input
                type="text"
                value={recherche}
                onChange={(e) => setRecherche(e.target.value)}
                placeholder="Rechercher un produit…"
                className="champ pl-10"
              />
            </div>
          </div>

          {/* Grille de la maquette : `auto-fill` sur la largeur RÉELLE de la
              colonne centrale, et non des paliers calés sur le viewport — la
              colonne d'addition se resserre, la grille doit suivre.
              Minimum à 150 px et non aux 168 px de la maquette : sur l'écran du
              poste (1024), 168 px ne tiennent que DEUX colonnes — un catalogue
              de 128 articles se parcourrait au défilement. À 150 px on garde
              trois colonnes ici, et la grille en ajoute d'elle-même sur un
              écran plus large. */}
          <div className="grid auto-rows-min grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 overflow-y-auto pb-4 pr-1">
            {combosVisibles.map((combo) => (
              <button
                key={combo.id}
                type="button"
                disabled={!combo.disponible}
                onClick={() =>
                  saisie.ajouter(combo.nom, 1, { combo_id: combo.id, quantite: 1, options: [], supplements: [] })
                }
                // Un combo n'a pas de catégorie : son liseré est celui de la marque.
                style={{ borderLeft: '4px solid var(--marque)' }}
                className="carte group flex flex-col overflow-hidden p-0 text-left transition hover:-translate-y-0.5 active:scale-[0.98] active:brightness-95 disabled:opacity-45"
              >
                {/* Aplat franc, aucun dégradé (§ 2). */}
                <div className="flex h-[98px] w-full items-center justify-center bg-marque p-3 text-center text-sm font-bold leading-tight text-sur-marque">
                  {combo.nom}
                </div>
                <div className="flex items-center justify-between p-3">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-doux">Combo</span>
                  <span className="text-[17px] font-bold tabular-nums">{formatFCFA(combo.prix)}</span>
                </div>
              </button>
            ))}
            {/* `active:` est indispensable : `hover:` n'existe pas sur un écran
                tactile, un tap ne produisait donc AUCUN retour visuel. */}
            {articlesVisibles.map((a) => {
              const aDesOptions = a.options_extras.length > 0;
              const couleur = couleurArticle(a.id);
              return (
                // Le « + » est un bouton FRÈRE de la carte, pas un enfant :
                // un bouton dans un bouton est invalide en HTML.
                <div key={a.id} className="relative">
                <button
                  type="button"
                  disabled={!a.disponible}
                  onClick={() => clicArticle(a)}
                  // Liseré gauche de 4 px à la couleur de la catégorie (§ 4.1) :
                  // en recherche, les résultats mélangent les familles et c'est
                  // le seul repère qui reste.
                  style={{ borderLeft: `4px solid ${couleur}` }}
                  className="carte group flex h-full w-full flex-col overflow-hidden p-0 text-left transition hover:-translate-y-0.5 active:scale-[0.98] active:brightness-95"
                >
                  {/* Fond du visuel à ~11 % de la teinte (§ 7) : le code couleur
                      du menu tient même quand toutes les photos se ressemblent. */}
                  <div
                    className="relative h-[98px] w-full overflow-hidden"
                    style={{ background: `color-mix(in srgb, ${couleur} 11%, var(--carte))` }}
                  >
                    {a.image_url ? (
                      <img
                        src={a.image_url}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                      />
                    ) : (
                      <div
                        className="flex h-full w-full items-center justify-center text-2xl font-bold"
                        style={{ color: `color-mix(in srgb, ${couleur} 55%, transparent)` }}
                      >
                        {a.nom.slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    {!a.disponible && (
                      <div className="absolute inset-0 flex items-center justify-center bg-fort/45">
                        <span className="rounded-full bg-alerte px-3 py-0.5 text-xs font-bold text-white">Épuisé</span>
                      </div>
                    )}
                  </div>
                  {/* Prix en encre normale, pas en orange (maquette § 6.4) :
                      l'orange est réservé aux actions et aux totaux. */}
                  <div className="flex flex-1 flex-col justify-between gap-2.5 p-3 pt-3">
                    <p className="line-clamp-2 text-[15px] font-semibold leading-tight text-fort">{a.nom}</p>
                    <p className="text-[17px] font-bold tabular-nums text-fort">{formatFCFA(a.prix_base)}</p>
                  </div>
                </button>
                {/* Options : facultatives. 48 px de cible tactile (§UX). */}
                {aDesOptions && a.disponible && (
                  <button
                    type="button"
                    title={`Ajouter des options à ${a.nom}`}
                    aria-label={`Ajouter des options à ${a.nom}`}
                    onClick={() => setArticleOuvert(a)}
                    className="absolute right-2 top-2 flex h-12 w-12 items-center justify-center rounded-full bg-surface/95 text-marque-fonce shadow-e2 ring-1 ring-bordure transition hover:bg-marque hover:text-sur-marque active:scale-95"
                  >
                    <IconPlus size={24} stroke={2.4} />
                  </button>
                )}
                </div>
              );
            })}
            {articlesVisibles.length === 0 && (
              <p className="col-span-full pt-10 text-center text-doux">Aucun produit ne correspond.</p>
            )}
          </div>
        </section>

        {/* Addition */}
        {/* Panneau d'addition en ARDOISE (§ 6.4) : détaché du plan de travail,
            c'est la colonne que le caissier surveille pendant qu'il tape. */}
        <aside className="flex min-h-0 flex-col border-l border-ard-700 bg-ard-850 text-ard-txt">
          <div className="flex flex-none items-center justify-between border-b border-ard-700 px-4 py-[15px]">
            <div className="min-w-0">
              <p className="truncate text-lg font-bold">
                {commande.code_commande ? `${commande.code_commande} · ` : ''}
                {commande.table_numero ? `Table ${commande.table_numero}` : `Ticket n° ${commande.numero_ticket}`}
              </p>
              <p className="text-xs text-ard-txt-doux">Caissier : {prenom}</p>
            </div>
            <span className="flex-none rounded-full bg-ard-700 px-3 py-1 text-xs font-medium text-ard-txt">
              {LIBELLES_TYPES_COMMANDE[commande.type]}
            </span>
          </div>

          {/* Lignes */}
          <div className="flex-1 space-y-2 overflow-y-auto p-2">
            {itemsActifs.length === 0 && saisie.lignesEnAttente.length === 0 && (
              <div className="pt-10 text-center text-sm text-ard-txt-faible">Addition vide — touchez un article</div>
            )}
            {itemsActifs.map((item) => {
              const quantite = saisie.quantiteAffichee(item);
              const enRecalcul = saisie.ligneEnRecalcul(item.id);
              return (
                <div key={item.id} className="rounded-[7px] bg-ard-800 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-start gap-2.5">
                      {/* Point de couleur de la catégorie (§ 4.1) : relire une
                          addition de 15 lignes se fait par famille de produit. */}
                      <span
                        className="mt-[6px] h-[9px] w-[9px] flex-none rounded-full"
                        style={{ background: couleurArticle(item.article_id) }}
                      />
                      <div className="min-w-0">
                        <p className="font-semibold leading-tight">{item.nom_snapshot}</p>
                        <p className="text-sm text-marque-clair">{formatFCFA(item.prix_unitaire)}</p>
                      </div>
                    </div>
                    {/* Total de ligne en attente de recalcul serveur : on affiche
                        un point de suspension, jamais un montant calculé ici. */}
                    <p className="font-bold tabular-nums">
                      {enRecalcul ? '…' : formatFCFA(item.total_ligne)}
                    </p>
                  </div>
                  {/* Option offerte : pas de « (0 F) », comme sur le reçu. */}
                  {item.supplements.map((s) => (
                    <div key={s.nom} className="pl-1 text-xs text-ard-txt-doux">
                      + {s.nom}{s.prix > 0 ? ` (${formatFCFA(s.prix)})` : ''}
                    </div>
                  ))}
                  {item.options.filter((o) => o.choix.length > 0).map((o) => (
                    <div key={o.groupe} className="pl-1 text-xs text-ard-txt-doux">{o.groupe} : {o.choix.join(', ')}</div>
                  ))}
                  <div className="mt-2 flex items-center justify-between">
                    {item.envoye ? (
                      <span className="rounded-full bg-alerte/10 px-3 py-1 text-xs font-medium text-alerte">En cuisine</span>
                    ) : (
                      <div className="flex h-9 items-center overflow-hidden rounded-[10px] bg-ard-700">
                        <button
                          type="button"
                          className="flex h-full w-9 items-center justify-center text-marque-clair transition hover:bg-ard-650 disabled:opacity-40"
                          disabled={quantite <= 1}
                          onClick={() => saisie.changerQuantite(item, -1)}
                        >
                          <IconMinus size={16} />
                        </button>
                        <span className="w-9 text-center font-bold tabular-nums">{quantite}</span>
                        <button
                          type="button"
                          className="flex h-full w-9 items-center justify-center text-marque-clair transition hover:bg-ard-650 disabled:opacity-40"
                          disabled={quantite >= saisie.QUANTITE_MAX}
                          onClick={() => saisie.changerQuantite(item, 1)}
                        >
                          <IconPlus size={16} />
                        </button>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => setItemAAnnuler(item)}
                      className="flex h-9 w-9 items-center justify-center rounded-full text-ard-txt-faible transition hover:bg-alerte/20 hover:text-alerte"
                      title="Annuler l’article"
                    >
                      <IconX size={18} />
                    </button>
                  </div>
                </div>
              );
            })}

            {/* Lignes tapées, pas encore créées en base. Elles s'affichent SANS
                montant : le prix unitaire dépend du canal (emporter/livraison)
                et n'est connu qu'après la réponse du serveur. Ni quantité ni
                annulation ici — l'article n'existe pas encore côté serveur. */}
            {saisie.lignesEnAttente.map((ligne) => (
              <div
                key={ligne.cle}
                className="rounded-[7px] border border-dashed border-ard-600 p-3 opacity-70"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold leading-tight">
                    {ligne.nom}
                    {ligne.quantite > 1 && <span className="text-ard-txt-doux"> × {ligne.quantite}</span>}
                  </p>
                  <p className="font-bold tabular-nums text-ard-txt-doux">…</p>
                </div>
                <p className="mt-1 text-xs text-ard-txt-doux">Enregistrement…</p>
              </div>
            ))}
          </div>

          {/* Totaux + actions */}
          <div className="flex-none space-y-3 border-t border-ard-700 bg-ard-900 p-4">
            {/* Les montants restent EXACTEMENT ceux du serveur pendant qu'une
                saisie est en vol : on signale le recalcul, on ne devine rien. */}
            <div className={`space-y-1 ${saisie.enAttente ? 'opacity-60' : ''}`}>
              {commande.promo_montant > 0 && (
                <Ligne libelle={`Promo ${commande.promo_nom ?? ''}`} valeur={`−${formatFCFA(commande.promo_montant)}`} vert />
              )}
              {commande.remise_montant > 0 && (
                <Ligne libelle="Remise" valeur={`−${formatFCFA(commande.remise_montant)}`} vert />
              )}
              {commande.fidelite_montant > 0 && (
                <Ligne libelle="Fidélité" valeur={`−${formatFCFA(commande.fidelite_montant)}`} vert />
              )}
              <div className="flex items-baseline justify-between pb-3.5 pt-2.5">
                <span className="text-base font-semibold">
                  Total
                  {saisie.enAttente && (
                    <span className="ml-2 rounded-full bg-ard-700 px-2 py-0.5 text-[11px] font-semibold text-ard-txt-doux">
                      recalcul…
                    </span>
                  )}
                </span>
                <span className="text-[30px] font-bold tracking-tight text-marque-clair tabular-nums">
                  {formatFCFA(commande.total)}
                </span>
              </div>
            </div>

            {/* Trois actions secondaires, LOIN du bouton Encaisser : « Vider »
                est destructif, il ne doit jamais se toucher par erreur en
                visant l'encaissement. Il ouvre de toute façon une confirmation
                (PIN manager + motif dès qu'un produit a été tapé). */}
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setRemiseOuverte(true)}
                disabled={itemsActifs.length === 0 || saisie.enAttente}
                className="flex h-12 items-center justify-center gap-1.5 rounded-[13px] bg-ard-750 text-[13.5px] font-semibold text-ard-txt transition hover:bg-ard-700 disabled:opacity-40"
              >
                <IconTag size={18} /> Remise
              </button>
              <button
                type="button"
                onClick={() => imprimerFacture.mutate()}
                disabled={itemsActifs.length === 0 || imprimerFacture.isPending || saisie.enAttente}
                className="flex h-12 items-center justify-center gap-1.5 rounded-[13px] bg-ard-750 text-[13.5px] font-semibold text-ard-txt transition hover:bg-ard-700 disabled:opacity-40"
              >
                <IconPrinter size={18} /> {imprimerFacture.isPending ? '…' : 'Facture'}
              </button>
              {/* Rien de tapé : la commande n'existe pas pour la salle, on la
                  referme sans rien demander. Un seul article, même pas encore
                  parti en cuisine : c'est une annulation de commande. */}
              <button
                type="button"
                onClick={() => (commande.items.length === 0 ? void libererVide() : setAnnulationOuverte(true))}
                disabled={saisie.enAttente || annulerCommande.isPending}
                title={
                  commande.items.length === 0
                    ? 'Libérer la table — aucun produit tapé'
                    : 'Annuler la commande et libérer la table (PIN manager)'
                }
                className="flex h-12 items-center justify-center gap-1.5 rounded-[13px] bg-alerte/15 text-[13.5px] font-semibold text-[#ff9d9d] transition hover:bg-alerte/25 disabled:opacity-40"
              >
                <IconTrash size={18} /> {commande.items.length === 0 ? 'Libérer' : 'Vider'}
              </button>
            </div>
            <button
              type="button"
              onClick={() => envoyerCuisine.mutate()}
              disabled={itemsActifs.length === 0 || saisie.enAttente}
              className="flex h-14 w-full items-center justify-center gap-2 rounded-[13px] bg-marque-tint text-lg font-bold text-marque-fonce shadow-e1 transition hover:brightness-95 disabled:opacity-40"
            >
              <IconSend size={20} /> Envoyer en cuisine
            </button>
            {commande.statut === 'PRETE' && (
              <button
                type="button"
                onClick={() => servir.mutate()}
                disabled={saisie.enAttente}
                className="flex h-14 w-full items-center justify-center gap-2 rounded-[13px] bg-ok text-lg font-bold text-white shadow-e1 transition hover:brightness-105 active:translate-y-px disabled:opacity-40"
              >
                Servi ✔
              </button>
            )}
            {/* Un Kdo ne passe JAMAIS par l'écran de paiement : il n'y a rien à
                encaisser. Il se clôture ici, contre un motif obligatoire. */}
            <button
              type="button"
              onClick={() => (commande.offert ? setOffrirOuvert(true) : aller('paiement', commande.id))}
              disabled={commande.total <= 0 || saisie.enAttente}
              className="flex h-14 w-full items-center justify-center gap-2 rounded-[13px] bg-marque text-lg font-bold text-sur-marque shadow-e2 transition hover:brightness-105 active:translate-y-px disabled:opacity-40"
            >
              {commande.offert
                ? 'Valider le Kdo'
                : estLivraisonSansEncaissement(commande.partenaire)
                  ? 'Valider la livraison'
                  : 'Encaisser'}{' '}
              · {formatFCFA(commande.total)}
            </button>
          </div>
        </aside>
      </div>

      {articleOuvert && (
        <ModaleArticle
          article={articleOuvert}
          couleur={couleurArticle(articleOuvert.id)}
          onAjouter={(corps, quantite) => {
            saisie.ajouter(articleOuvert.nom, quantite, corps);
            setArticleOuvert(null);
          }}
          onFermer={() => setArticleOuvert(null)}
        />
      )}
      {itemAAnnuler && (
        <ModaleAnnulation
          item={itemAAnnuler}
          onConfirmer={(motif, pin) => annulerItem.mutate({ itemId: itemAAnnuler.id, motif, pin })}
          onFermer={() => setItemAAnnuler(null)}
          enCours={annulerItem.isPending}
        />
      )}
      {remiseOuverte && (
        <ModalePinManager
          titre="Remise (manager)"
          demanderMontant
          onConfirmer={({ pin, motif, montant }) => appliquerRemise.mutate({ montant, motif, pin })}
          onFermer={() => setRemiseOuverte(false)}
          enCours={appliquerRemise.isPending}
        />
      )}

      {/* Annulation de la commande entière : la trace (motif + manager) part au
          journal d'audit, et c'est elle qui fait apparaître les plats déjà
          lancés dans les RETOURS. */}
      {annulationOuverte && (
        <ModalePinManager
          titre={`Vider ${commande.table_numero ? `la table ${commande.table_numero}` : 'cette commande'} — ${formatFCFA(commande.total)} annulés`}
          onConfirmer={({ pin, motif }) => annulerCommande.mutate({ motif, pin })}
          onFermer={() => setAnnulationOuverte(false)}
          enCours={annulerCommande.isPending}
        />
      )}

      {offrirOuvert && (
        <ModaleMotifKdo
          total={commande.total}
          enCours={offrir.isPending}
          onConfirmer={(motif) => offrir.mutate(motif)}
          onFermer={() => setOffrirOuvert(false)}
        />
      )}
    </div>
  );
}

/**
 * Motif d'un Kdo. Pas de PIN manager (décision client : le caissier peut offrir
 * seul), mais le motif est obligatoire — c'est la seule trace qui distingue,
 * dans le journal d'audit, un geste commercial d'une marchandise disparue.
 */
function ModaleMotifKdo({
  total,
  enCours,
  onConfirmer,
  onFermer,
}: {
  total: number;
  enCours: boolean;
  onConfirmer: (motif: string) => void;
  onFermer: () => void;
}) {
  const [motif, setMotif] = useState('');
  const suggestions = ['Geste commercial', 'Client fidèle', 'Erreur cuisine', 'Invité de la maison'];
  const valide = motif.trim().length >= 3;

  return (
    <Modale titre="Valider le Kdo" onFermer={onFermer} enfants={
      <div className="space-y-4">
        <p className="text-doux">
          <span className="text-xl font-bold text-texte">{formatFCFA(total)}</span> seront offerts : rien ne sera
          encaissé. Le montant compte dans la vente du shift, pas dans le tiroir.
        </p>
        <div>
          <label htmlFor="motif-kdo" className="mb-1 block text-sm font-semibold text-doux">Pourquoi ce cadeau ?</label>
          <input
            id="motif-kdo"
            autoFocus
            value={motif}
            onChange={(e) => setMotif(e.target.value)}
            placeholder="Motif obligatoire"
            className="w-full rounded-[13px] border border-bordure bg-surface p-4 text-lg"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setMotif(s)}
              className="rounded-full border border-bordure bg-surface px-4 py-2 text-sm font-semibold hover:border-marque"
            >
              {s}
            </button>
          ))}
        </div>
        <button
          type="button"
          disabled={!valide || enCours}
          onClick={() => onConfirmer(motif.trim())}
          className="flex h-14 w-full items-center justify-center rounded-[13px] bg-marque text-lg font-bold text-sur-marque disabled:opacity-40"
        >
          {enCours ? 'Validation…' : 'Confirmer le Kdo'}
        </button>
      </div>
    } />
  );
}

/** Ligne de total du pied d'addition — sur ardoise, d'où le vert éclairci. */
function Ligne({ libelle, valeur, vert }: { libelle: string; valeur: string; vert?: boolean }) {
  return (
    <div className={`flex justify-between py-1 text-[13.5px] ${vert ? 'font-semibold text-[#6ee7a0]' : 'text-ard-txt-doux'}`}>
      <span>{libelle}</span>
      <span className="tabular-nums">{valeur}</span>
    </div>
  );
}

function ModaleArticle({
  article,
  couleur,
  onAjouter,
  onFermer,
}: {
  article: ArticleVue;
  couleur: string;
  onAjouter: (corps: unknown, quantite: number) => void;
  onFermer: () => void;
}) {
  const [quantite, setQuantite] = useState(1);
  // Liste plate d'extras à cocher (migration 0020) : chaque option porte son
  // prix, 0 = offerte. Plus de groupes ni de contrainte « choisir exactement 1 ».
  const [choisies, setChoisies] = useState<string[]>([]);

  const prixOptions = article.options_extras
    .filter((o) => choisies.includes(o.id))
    .reduce((somme, o) => somme + o.prix, 0);

  return (
    <Modale titre={article.nom} onFermer={onFermer} enfants={
      <div className="space-y-4">
        {/* Bandeau visuel de la fiche (§ 6.4 / § 7) : 156 px, fond à la teinte
            de la catégorie, la photo vient s'y loger sans rien déplacer. */}
        <div
          className="relative h-[156px] w-full overflow-hidden rounded-jeton"
          style={{ background: `color-mix(in srgb, ${couleur} 11%, var(--carte))` }}
        >
          {article.image_url ? (
            <img src={article.image_url} alt="" loading="lazy" className="h-full w-full object-cover" />
          ) : (
            <div
              className="flex h-full w-full items-center justify-center text-4xl font-bold"
              style={{ color: `color-mix(in srgb, ${couleur} 55%, transparent)` }}
            >
              {article.nom.slice(0, 2).toUpperCase()}
            </div>
          )}
          <span className="absolute left-0 top-0 h-full w-1" style={{ background: couleur }} />
        </div>
        {article.options_extras.length > 0 && (
          <div>
            <div className="mb-1.5 font-semibold">
              Options <span className="font-normal text-doux">— facultatives, une seule fois chacune</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {article.options_extras.map((o) => {
                const active = choisies.includes(o.id);
                return (
                  <button
                    key={o.id}
                    type="button"
                    className={`rounded-[13px] px-4 py-2 text-sm font-medium transition ${
                      active ? 'bg-marque text-sur-marque' : 'bg-surface-douce text-doux hover:bg-surface-haute'
                    }`}
                    onClick={() =>
                      setChoisies((prev) => (prev.includes(o.id) ? prev.filter((x) => x !== o.id) : [...prev, o.id]))
                    }
                  >
                    {o.nom}{' '}
                    <span className={active ? 'opacity-80' : 'text-doux'}>
                      {o.prix > 0 ? `+${formatFCFA(o.prix)}` : 'offert'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="flex items-center justify-center gap-4">
          <button type="button" className="touche h-12 w-12" onClick={() => setQuantite(Math.max(1, quantite - 1))}>−</button>
          <span className="w-10 text-center text-2xl font-bold tabular-nums">{quantite}</span>
          <button type="button" className="touche h-12 w-12" onClick={() => setQuantite(quantite + 1)}>+</button>
        </div>
        <button
          type="button"
          className="h-14 w-full rounded-[13px] bg-marque text-lg font-bold text-sur-marque shadow-e2 transition hover:brightness-105 active:translate-y-px"
          onClick={() =>
            onAjouter(
              {
                article_id: article.id,
                quantite,
                options: [],
                // Le serveur revalide ces ids contre les options réellement
                // liées à l'article et refige le prix depuis la base.
                supplements: choisies.map((id) => ({ id })),
              },
              quantite,
            )
          }
        >
          Ajouter — {formatFCFA((article.prix_base + prixOptions) * quantite)}
        </button>
      </div>
    } />
  );
}

function ModaleAnnulation({
  item,
  onConfirmer,
  onFermer,
  enCours,
}: {
  item: CommandeItemVue;
  onConfirmer: (motif: string, pin?: string) => void;
  onFermer: () => void;
  enCours: boolean;
}) {
  const dejaEnCuisine = item.envoye || item.statut_cuisine !== 'A_PREPARER';
  const [motif, setMotif] = useState('');

  if (dejaEnCuisine) {
    return (
      <ModalePinManager
        titre={`Annuler « ${item.nom_snapshot} » (en cuisine)`}
        onConfirmer={({ pin, motif: m }) => onConfirmer(m, pin)}
        onFermer={onFermer}
        enCours={enCours}
      />
    );
  }

  return (
    <Modale titre={`Annuler « ${item.nom_snapshot} »`} onFermer={onFermer} enfants={
      <div className="space-y-3">
        <label className="block text-sm text-doux">Motif (obligatoire)</label>
        <input className="champ" value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="ex : erreur de saisie" />
        <button
          type="button"
          className="btn-alerte w-full py-3"
          disabled={motif.trim().length < 3 || enCours}
          onClick={() => onConfirmer(motif.trim())}
        >
          {enCours ? 'Annulation…' : 'Confirmer l’annulation'}
        </button>
      </div>
    } />
  );
}
