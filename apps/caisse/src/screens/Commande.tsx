import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ComponentType, useState } from 'react';
import {
  IconArrowLeft,
  IconCirclePlus,
  IconCoffee,
  IconGlassFull,
  IconIceCream,
  IconMeat,
  IconMinus,
  IconPizza,
  IconPlus,
  IconPrinter,
  IconSalad,
  IconSearch,
  IconSend,
  IconTag,
  IconToolsKitchen2,
  IconX,
  type IconProps,
} from '@tabler/icons-react';
import type { ArticleVue, CatalogueVue, CommandeItemVue, CommandeVue } from '@pos/shared';
import { formatFCFA, LIBELLES_TYPES_COMMANDE } from '@pos/shared';
import { api } from '../api';
import { Modale } from '../components/Modale';
import { ModalePinManager } from '../components/ModalePinManager';
import { PiluleSync } from '../components/SanteSync';
import { useCaisse } from '../stores/session';

/** Icône de catégorie (heuristique par nom — nos catégories sont dynamiques). */
function iconeCategorie(nom: string): ComponentType<IconProps> {
  const n = nom.toLowerCase();
  if (/(boisson|jus|soda|eau|drink)/.test(n)) return IconGlassFull;
  if (/pizza/.test(n)) return IconPizza;
  if (/(dessert|glace|sucr)/.test(n)) return IconIceCream;
  if (/(caf|thé|the)/.test(n)) return IconCoffee;
  if (/(entrée|entree|salade)/.test(n)) return IconSalad;
  if (/(grill|viande|boeuf|agneau|poulet|brochette)/.test(n)) return IconMeat;
  return IconToolsKitchen2;
}

export function Commande() {
  const { commandeId, aller, afficherToast, session } = useCaisse();
  const queryClient = useQueryClient();
  const [categorieId, setCategorieId] = useState<string | null>(null);
  const [recherche, setRecherche] = useState('');
  const [articleOuvert, setArticleOuvert] = useState<ArticleVue | null>(null);
  const [itemAAnnuler, setItemAAnnuler] = useState<CommandeItemVue | null>(null);
  const [remiseOuverte, setRemiseOuverte] = useState(false);

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

  const ajouterItem = useMutation({
    mutationFn: (corps: unknown) => api<CommandeVue>(`/api/commandes/${commandeId}/items`, { method: 'POST', corps }),
    onSuccess: rafraichir,
    onError: surErreur,
  });
  const changerQuantite = useMutation({
    mutationFn: ({ itemId, quantite }: { itemId: string; quantite: number }) =>
      api<CommandeVue>(`/api/commandes/${commandeId}/items/${itemId}`, { method: 'PATCH', corps: { quantite } }),
    onSuccess: rafraichir,
    onError: surErreur,
  });
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
  // La caisse peut aussi marquer une commande SERVIE (pas seulement la cuisine).
  const servir = useMutation({
    mutationFn: () => api<CommandeVue>(`/api/commandes/${commandeId}/servir`, { method: 'POST', corps: {} }),
    onSuccess: (vue) => { rafraichir(vue); afficherToast('Commande servie ✔'); },
    onError: surErreur,
  });

  if (!commande || !catalogue) {
    return <div className="flex min-h-full items-center justify-center text-doux">Chargement…</div>;
  }

  const categories = catalogue.categories;
  const categorieActive = categorieId ?? categories[0]?.id ?? null;
  const rechTrim = recherche.trim().toLowerCase();
  const enRecherche = rechTrim.length > 0;
  const articlesVisibles = enRecherche
    ? catalogue.articles.filter((a) => a.nom.toLowerCase().includes(rechTrim))
    : catalogue.articles.filter((a) => a.categorie_id === categorieActive);
  const combosVisibles = !enRecherche && categorieActive === categories[0]?.id ? catalogue.combos : [];
  const itemsActifs = commande.items.filter((i) => i.statut_cuisine !== 'ANNULE');
  const prenom = session?.utilisateur.nom_complet.split(' ')[0] ?? '';

  const clicArticle = (a: ArticleVue) => {
    if (!a.disponible) return;
    if (a.groupes_options.length > 0 || a.supplements.length > 0) setArticleOuvert(a);
    else ajouterItem.mutate({ article_id: a.id, quantite: 1, options: [], supplements: [] });
  };

  return (
    <div className="flex h-screen flex-col bg-fond">
      {/* ---------- Barre supérieure ---------- */}
      <header className="flex h-16 flex-none items-center justify-between border-b border-bordure bg-surface px-4 shadow-e1">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => aller('accueil')}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-douce text-doux transition hover:bg-marque-tint hover:text-marque-fonce"
            title="Retour à l’accueil"
          >
            <IconArrowLeft size={20} />
          </button>
          <div>
            <div className="font-bold text-marque-fonce">{session?.restaurant.nom}</div>
            <div className="text-xs text-doux">Caissier : {prenom} · Service ouvert</div>
          </div>
        </div>
        <PiluleSync />
      </header>

      {/* ---------- 3 zones ---------- */}
      <div className="grid min-h-0 flex-1 grid-cols-[96px_1fr_360px] xl:grid-cols-[116px_1fr_400px]">
        {/* Rail catégories */}
        <nav className="flex flex-col gap-1 overflow-y-auto border-r border-bordure bg-surface-douce py-3">
          {categories.map((c) => {
            const Icone = iconeCategorie(c.nom);
            const actif = !enRecherche && c.id === categorieActive;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => { setCategorieId(c.id); setRecherche(''); }}
                className={`flex flex-col items-center gap-1.5 px-1 py-4 text-center transition ${
                  actif
                    ? 'border-r-4 border-marque bg-marque-tint text-marque-fonce'
                    : 'text-doux hover:bg-surface-haute'
                }`}
              >
                <Icone size={28} stroke={1.8} />
                <span className="text-xs font-medium leading-tight">{c.nom}</span>
              </button>
            );
          })}
        </nav>

        {/* Grille produits */}
        <section className="flex min-w-0 flex-col overflow-hidden p-5">
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

          <div className="grid auto-rows-min grid-cols-2 gap-4 overflow-y-auto pr-1 pb-4 lg:grid-cols-3 xl:grid-cols-4">
            {combosVisibles.map((combo) => (
              <button
                key={combo.id}
                type="button"
                disabled={!combo.disponible}
                onClick={() => ajouterItem.mutate({ combo_id: combo.id, quantite: 1, options: [], supplements: [] })}
                className="carte group flex flex-col overflow-hidden p-0 text-left transition hover:-translate-y-0.5 disabled:opacity-45"
              >
                <div className="flex h-28 w-full items-center justify-center bg-gradient-to-br from-marque to-marque-fonce p-3 text-center text-sm font-bold leading-tight text-white">
                  {combo.nom}
                </div>
                <div className="flex items-center justify-between p-3">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-doux">Combo</span>
                  <span className="prix">{formatFCFA(combo.prix)}</span>
                </div>
              </button>
            ))}
            {articlesVisibles.map((a) => {
              const aDesOptions = a.groupes_options.length > 0 || a.supplements.length > 0;
              return (
                <button
                  key={a.id}
                  type="button"
                  disabled={!a.disponible}
                  onClick={() => clicArticle(a)}
                  className="carte group flex flex-col overflow-hidden p-0 text-left transition hover:-translate-y-0.5"
                >
                  <div className="relative h-28 w-full overflow-hidden bg-marque-tint">
                    {a.image_url ? (
                      <img
                        src={a.image_url}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-2xl font-bold text-marque-fonce/30">
                        {a.nom.slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    {!a.disponible && (
                      <div className="absolute inset-0 flex items-center justify-center bg-fort/45">
                        <span className="rounded-full bg-alerte px-3 py-0.5 text-xs font-bold text-white">Épuisé</span>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-1 flex-col gap-1 p-3">
                    <p className="line-clamp-2 font-semibold leading-tight text-fort">{a.nom}</p>
                    <p className="prix text-lg">{formatFCFA(a.prix_base)}</p>
                    {aDesOptions && (
                      <span className="mt-0.5 flex items-center gap-1 text-xs text-doux">
                        <IconCirclePlus size={14} /> Options
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
            {articlesVisibles.length === 0 && (
              <p className="col-span-full pt-10 text-center text-doux">Aucun produit ne correspond.</p>
            )}
          </div>
        </section>

        {/* Addition */}
        <aside className="flex min-h-0 flex-col border-l border-bordure bg-surface-douce">
          <div className="flex flex-none items-center justify-between border-b border-bordure bg-surface-haute/60 p-4">
            <div>
              <p className="text-lg font-bold text-marque-fonce">
                {commande.table_numero ? `Table ${commande.table_numero}` : `Ticket n° ${commande.numero_ticket}`}
              </p>
              <p className="text-xs text-doux">Caissier : {prenom}</p>
            </div>
            <span className="rounded-full bg-info-tint px-3 py-1 text-xs font-medium text-info">
              {LIBELLES_TYPES_COMMANDE[commande.type]}
            </span>
          </div>

          {/* Lignes */}
          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {itemsActifs.length === 0 && (
              <div className="pt-10 text-center text-sm text-doux">Addition vide — touchez un article</div>
            )}
            {itemsActifs.map((item) => (
              <div key={item.id} className="rounded-[13px] border border-bordure bg-surface p-3 shadow-e1">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold leading-tight text-fort">{item.nom_snapshot}</p>
                    <p className="prix text-sm">{formatFCFA(item.prix_unitaire)}</p>
                  </div>
                  <p className="font-bold tabular-nums text-fort">{formatFCFA(item.total_ligne)}</p>
                </div>
                {item.supplements.map((s) => (
                  <div key={s.nom} className="pl-1 text-xs text-doux">+ {s.nom} ({formatFCFA(s.prix)})</div>
                ))}
                {item.options.filter((o) => o.choix.length > 0).map((o) => (
                  <div key={o.groupe} className="pl-1 text-xs text-doux">{o.groupe} : {o.choix.join(', ')}</div>
                ))}
                <div className="mt-2 flex items-center justify-between">
                  {item.envoye ? (
                    <span className="rounded-full bg-alerte/10 px-3 py-1 text-xs font-medium text-alerte">En cuisine</span>
                  ) : (
                    <div className="flex h-9 items-center overflow-hidden rounded-[10px] bg-surface-haute">
                      <button
                        type="button"
                        className="flex h-full w-9 items-center justify-center text-marque-fonce transition hover:bg-marque/10 disabled:opacity-40"
                        disabled={item.quantite <= 1}
                        onClick={() => changerQuantite.mutate({ itemId: item.id, quantite: item.quantite - 1 })}
                      >
                        <IconMinus size={16} />
                      </button>
                      <span className="w-9 text-center font-bold tabular-nums text-fort">{item.quantite}</span>
                      <button
                        type="button"
                        className="flex h-full w-9 items-center justify-center text-marque-fonce transition hover:bg-marque/10"
                        onClick={() => changerQuantite.mutate({ itemId: item.id, quantite: item.quantite + 1 })}
                      >
                        <IconPlus size={16} />
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => setItemAAnnuler(item)}
                    className="flex h-9 w-9 items-center justify-center rounded-full text-doux transition hover:bg-alerte/10 hover:text-alerte"
                    title="Annuler l’article"
                  >
                    <IconX size={18} />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Totaux + actions */}
          <div className="flex-none space-y-3 border-t border-bordure bg-surface-haute/60 p-4">
            <div className="space-y-1">
              {commande.promo_montant > 0 && (
                <Ligne libelle={`Promo ${commande.promo_nom ?? ''}`} valeur={`−${formatFCFA(commande.promo_montant)}`} vert />
              )}
              {commande.remise_montant > 0 && (
                <Ligne libelle="Remise" valeur={`−${formatFCFA(commande.remise_montant)}`} vert />
              )}
              {commande.fidelite_montant > 0 && (
                <Ligne libelle="Fidélité" valeur={`−${formatFCFA(commande.fidelite_montant)}`} vert />
              )}
              <div className="flex items-baseline justify-between pt-1">
                <span className="text-lg font-semibold text-fort">Total</span>
                <span className="text-2xl font-extrabold text-marque-fonce tabular-nums">{formatFCFA(commande.total)}</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setRemiseOuverte(true)}
                disabled={itemsActifs.length === 0}
                className="flex h-12 items-center justify-center gap-2 rounded-[13px] border border-bordure-forte font-semibold text-marque-fonce transition hover:bg-marque/5 disabled:opacity-40"
              >
                <IconTag size={18} /> Remise
              </button>
              <button
                type="button"
                onClick={() => imprimerFacture.mutate()}
                disabled={itemsActifs.length === 0 || imprimerFacture.isPending}
                className="flex h-12 items-center justify-center gap-2 rounded-[13px] border border-bordure-forte font-semibold text-marque-fonce transition hover:bg-marque/5 disabled:opacity-40"
              >
                <IconPrinter size={18} /> {imprimerFacture.isPending ? '…' : 'Facture'}
              </button>
            </div>
            <button
              type="button"
              onClick={() => envoyerCuisine.mutate()}
              disabled={itemsActifs.length === 0}
              className="flex h-14 w-full items-center justify-center gap-2 rounded-[13px] bg-marque-tint text-lg font-bold text-marque-fonce shadow-e1 transition hover:brightness-95 disabled:opacity-40"
            >
              <IconSend size={20} /> Envoyer en cuisine
            </button>
            {commande.statut === 'PRETE' && (
              <button
                type="button"
                onClick={() => servir.mutate()}
                className="flex h-14 w-full items-center justify-center gap-2 rounded-[13px] bg-ok text-lg font-bold text-white shadow-e1 transition hover:brightness-105 active:translate-y-px"
              >
                Servi ✔
              </button>
            )}
            <button
              type="button"
              onClick={() => aller('paiement', commande.id)}
              disabled={commande.total <= 0}
              className="flex h-14 w-full items-center justify-center gap-2 rounded-[13px] bg-marque text-lg font-bold text-sur-marque shadow-e2 transition hover:brightness-105 active:translate-y-px disabled:opacity-40"
            >
              Encaisser · {formatFCFA(commande.total)}
            </button>
          </div>
        </aside>
      </div>

      {articleOuvert && (
        <ModaleArticle
          article={articleOuvert}
          onAjouter={(corps) => { ajouterItem.mutate(corps); setArticleOuvert(null); }}
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
    </div>
  );
}

function Ligne({ libelle, valeur, vert }: { libelle: string; valeur: string; vert?: boolean }) {
  return (
    <div className={`flex justify-between text-sm ${vert ? 'text-ok' : 'text-doux'}`}>
      <span>{libelle}</span>
      <span className="tabular-nums">{valeur}</span>
    </div>
  );
}

function ModaleArticle({
  article,
  onAjouter,
  onFermer,
}: {
  article: ArticleVue;
  onAjouter: (corps: unknown) => void;
  onFermer: () => void;
}) {
  const [quantite, setQuantite] = useState(1);
  const [choix, setChoix] = useState<Record<string, string[]>>({});
  const [supplements, setSupplements] = useState<string[]>([]);

  const basculerChoix = (groupe: string, option: string, max: number) => {
    setChoix((prev) => {
      const actuels = prev[groupe] ?? [];
      if (actuels.includes(option)) return { ...prev, [groupe]: actuels.filter((o) => o !== option) };
      if (max === 1) return { ...prev, [groupe]: [option] };
      if (actuels.length >= max) return prev;
      return { ...prev, [groupe]: [...actuels, option] };
    });
  };

  const prixSupplements = article.supplements
    .filter((s) => supplements.includes(s.id))
    .reduce((somme, s) => somme + s.prix, 0);

  return (
    <Modale titre={article.nom} onFermer={onFermer} enfants={
      <div className="space-y-4">
        {article.groupes_options.map((g) => (
          <div key={g.id}>
            <div className="mb-1.5 font-semibold">{g.nom}</div>
            <div className="flex flex-wrap gap-2">
              {g.options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className={`rounded-[13px] px-4 py-2 text-sm font-medium transition ${
                    choix[g.nom]?.includes(o.nom) ? 'bg-marque text-sur-marque' : 'bg-surface-douce text-doux hover:bg-surface-haute'
                  }`}
                  onClick={() => basculerChoix(g.nom, o.nom, g.choix_max)}
                >
                  {o.nom}
                </button>
              ))}
            </div>
          </div>
        ))}
        {article.supplements.length > 0 && (
          <div>
            <div className="mb-1.5 font-semibold">Suppléments</div>
            <div className="flex flex-wrap gap-2">
              {article.supplements.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`rounded-[13px] px-4 py-2 text-sm font-medium transition ${
                    supplements.includes(s.id) ? 'bg-marque text-sur-marque' : 'bg-surface-douce text-doux hover:bg-surface-haute'
                  }`}
                  onClick={() =>
                    setSupplements((prev) => (prev.includes(s.id) ? prev.filter((x) => x !== s.id) : [...prev, s.id]))
                  }
                >
                  {s.nom} +{formatFCFA(s.prix)}
                </button>
              ))}
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
            onAjouter({
              article_id: article.id,
              quantite,
              options: Object.entries(choix).map(([groupe, valeurs]) => ({ groupe, choix: valeurs })),
              supplements: supplements.map((id) => ({ id })),
            })
          }
        >
          Ajouter — {formatFCFA((article.prix_base + prixSupplements) * quantite)}
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
