import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ComponentType, useState } from 'react';
import {
  IconArrowLeft,
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
import { estLivraisonSansEncaissement, formatFCFA, LIBELLES_TYPES_COMMANDE } from '@pos/shared';
import { api } from '../api';
import { Modale } from '../components/Modale';
import { ModalePinManager } from '../components/ModalePinManager';
import { PiluleSync } from '../components/SanteSync';
import { useSaisieOptimiste } from '../saisie-optimiste';
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
  const [offrirOuvert, setOffrirOuvert] = useState(false);

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
                onClick={() =>
                  saisie.ajouter(combo.nom, 1, { combo_id: combo.id, quantite: 1, options: [], supplements: [] })
                }
                className="carte group flex flex-col overflow-hidden p-0 text-left transition hover:-translate-y-0.5 active:scale-[0.98] active:brightness-95 disabled:opacity-45"
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
            {/* `active:` est indispensable : `hover:` n'existe pas sur un écran
                tactile, un tap ne produisait donc AUCUN retour visuel. */}
            {articlesVisibles.map((a) => {
              const aDesOptions = a.options_extras.length > 0;
              return (
                // Le « + » est un bouton FRÈRE de la carte, pas un enfant :
                // un bouton dans un bouton est invalide en HTML.
                <div key={a.id} className="relative">
                <button
                  type="button"
                  disabled={!a.disponible}
                  onClick={() => clicArticle(a)}
                  className="carte group flex h-full w-full flex-col overflow-hidden p-0 text-left transition hover:-translate-y-0.5 active:scale-[0.98] active:brightness-95"
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
        <aside className="flex min-h-0 flex-col border-l border-bordure bg-surface-douce">
          <div className="flex flex-none items-center justify-between border-b border-bordure bg-surface-haute/60 p-4">
            <div>
              <p className="text-lg font-bold text-marque-fonce">
                {commande.code_commande ? `${commande.code_commande} · ` : ''}
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
            {itemsActifs.length === 0 && saisie.lignesEnAttente.length === 0 && (
              <div className="pt-10 text-center text-sm text-doux">Addition vide — touchez un article</div>
            )}
            {itemsActifs.map((item) => {
              const quantite = saisie.quantiteAffichee(item);
              const enRecalcul = saisie.ligneEnRecalcul(item.id);
              return (
                <div key={item.id} className="rounded-[13px] border border-bordure bg-surface p-3 shadow-e1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold leading-tight text-fort">{item.nom_snapshot}</p>
                      <p className="prix text-sm">{formatFCFA(item.prix_unitaire)}</p>
                    </div>
                    {/* Total de ligne en attente de recalcul serveur : on affiche
                        un point de suspension, jamais un montant calculé ici. */}
                    <p className="font-bold tabular-nums text-fort">
                      {enRecalcul ? '…' : formatFCFA(item.total_ligne)}
                    </p>
                  </div>
                  {/* Option offerte : pas de « (0 F) », comme sur le reçu. */}
                  {item.supplements.map((s) => (
                    <div key={s.nom} className="pl-1 text-xs text-doux">
                      + {s.nom}{s.prix > 0 ? ` (${formatFCFA(s.prix)})` : ''}
                    </div>
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
                          className="flex h-full w-9 items-center justify-center text-marque-fonce transition hover:bg-marque/10 active:bg-marque/20 disabled:opacity-40"
                          disabled={quantite <= 1}
                          onClick={() => saisie.changerQuantite(item, -1)}
                        >
                          <IconMinus size={16} />
                        </button>
                        <span className="w-9 text-center font-bold tabular-nums text-fort">{quantite}</span>
                        <button
                          type="button"
                          className="flex h-full w-9 items-center justify-center text-marque-fonce transition hover:bg-marque/10 active:bg-marque/20 disabled:opacity-40"
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
                      className="flex h-9 w-9 items-center justify-center rounded-full text-doux transition hover:bg-alerte/10 hover:text-alerte"
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
                className="rounded-[13px] border border-dashed border-bordure-forte bg-surface p-3 opacity-70"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold leading-tight text-fort">
                    {ligne.nom}
                    {ligne.quantite > 1 && <span className="text-doux"> × {ligne.quantite}</span>}
                  </p>
                  <p className="font-bold tabular-nums text-doux">…</p>
                </div>
                <p className="mt-1 text-xs text-doux">Enregistrement…</p>
              </div>
            ))}
          </div>

          {/* Totaux + actions */}
          <div className="flex-none space-y-3 border-t border-bordure bg-surface-haute/60 p-4">
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
              <div className="flex items-baseline justify-between pt-1">
                <span className="text-lg font-semibold text-fort">
                  Total
                  {saisie.enAttente && (
                    <span className="ml-2 rounded-full bg-info-tint px-2 py-0.5 text-[11px] font-semibold text-info">
                      recalcul…
                    </span>
                  )}
                </span>
                <span className="text-2xl font-extrabold text-marque-fonce tabular-nums">{formatFCFA(commande.total)}</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setRemiseOuverte(true)}
                disabled={itemsActifs.length === 0 || saisie.enAttente}
                className="flex h-12 items-center justify-center gap-2 rounded-[13px] border border-bordure-forte font-semibold text-marque-fonce transition hover:bg-marque/5 disabled:opacity-40"
              >
                <IconTag size={18} /> Remise
              </button>
              <button
                type="button"
                onClick={() => imprimerFacture.mutate()}
                disabled={itemsActifs.length === 0 || imprimerFacture.isPending || saisie.enAttente}
                className="flex h-12 items-center justify-center gap-2 rounded-[13px] border border-bordure-forte font-semibold text-marque-fonce transition hover:bg-marque/5 disabled:opacity-40"
              >
                <IconPrinter size={18} /> {imprimerFacture.isPending ? '…' : 'Facture'}
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
