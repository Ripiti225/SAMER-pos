import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  IconCash,
  IconFlagCheck,
  IconFlame,
  IconLayoutGrid,
  IconList,
  IconPlus,
  IconPrinter,
  IconReceipt,
  IconSend,
} from '@tabler/icons-react';
import type { ArticleVue, CatalogueVue, CommandeItemVue, CommandeVue } from '@pos/shared';
import { formatFCFA, LIBELLES_STATUTS_COMMANDE, LIBELLES_TYPES_COMMANDE } from '@pos/shared';
import { api } from '../api';
import { imprimerFactureNavigateur } from '../facture';
import { Modale } from '../components/Modale';
import { ModalePinManager } from '../components/ModalePinManager';
import { PiluleSync } from '../components/SanteSync';
import { useCaisse } from '../stores/session';

export function Commande() {
  const { commandeId, aller, afficherToast, session } = useCaisse();
  const queryClient = useQueryClient();
  const [categorieId, setCategorieId] = useState<string | null>(null);
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
  // Montant encaissé du service (pastille d'en-tête)
  const { data: mesVentes } = useQuery({
    queryKey: ['mes-ventes'],
    queryFn: () => api<{ total_payees?: number }>('/api/rapports/mes-ventes'),
  });

  const rafraichir = (vue: CommandeVue) => {
    queryClient.setQueryData(['commande', commandeId], vue);
  };
  const surErreur = (e: Error) => afficherToast(e.message);

  const ajouterItem = useMutation({
    mutationFn: (corps: unknown) =>
      api<CommandeVue>(`/api/commandes/${commandeId}/items`, { method: 'POST', corps }),
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
    onSuccess: (vue) => {
      rafraichir(vue);
      setItemAAnnuler(null);
    },
    onError: surErreur,
  });
  const envoyerCuisine = useMutation({
    mutationFn: () => api<CommandeVue>(`/api/commandes/${commandeId}/envoyer`, { method: 'POST', corps: {} }),
    onSuccess: (vue) => {
      rafraichir(vue);
      afficherToast('Commande envoyée en cuisine');
    },
    onError: surErreur,
  });
  const imprimerFacture = useMutation({
    mutationFn: () => api<CommandeVue>(`/api/commandes/${commandeId}/facture`, { method: 'POST', corps: {} }),
    onSuccess: (vue) => {
      rafraichir(vue);
      // Impression navigateur (80 mm) vers l'imprimante par défaut du terminal.
      imprimerFactureNavigateur(vue, session?.restaurant.nom ?? '');
    },
    onError: surErreur,
  });
  const appliquerRemise = useMutation({
    mutationFn: ({ montant, motif, pin }: { montant: number; motif: string; pin: string }) =>
      api<CommandeVue>(`/api/commandes/${commandeId}/remise`, {
        method: 'POST',
        corps: { montant, motif, pin_manager: pin },
      }),
    onSuccess: (vue) => {
      rafraichir(vue);
      setRemiseOuverte(false);
      afficherToast('Remise appliquée');
    },
    onError: surErreur,
  });

  if (!commande || !catalogue) {
    return <div className="flex min-h-full items-center justify-center text-doux">Chargement…</div>;
  }

  const categories = catalogue.categories;
  const categorieActive = categorieId ?? categories[0]?.id ?? null;
  const articlesVisibles = catalogue.articles.filter((a) => a.categorie_id === categorieActive);
  const combosVisibles = categorieActive === categories[0]?.id ? catalogue.combos : [];
  const itemsActifs = commande.items.filter((i) => i.statut_cuisine !== 'ANNULE');
  const prenom = session?.utilisateur.nom_complet.split(' ')[0] ?? '';

  const clicArticle = (a: ArticleVue) => {
    if (!a.disponible) return;
    if (a.groupes_options.length > 0 || a.supplements.length > 0) {
      setArticleOuvert(a);
    } else {
      ajouterItem.mutate({ article_id: a.id, quantite: 1, options: [], supplements: [] });
    }
  };

  return (
    <div className="flex h-screen flex-col gap-3 bg-fond p-3">
      {/* En-tête (maquette rush) */}
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            className="flex h-[38px] w-[38px] items-center justify-center rounded-[9px] bg-marque text-[#412402]"
            onClick={() => aller('accueil')}
            title="Accueil"
          >
            <IconFlame size={20} />
          </button>
          <div>
            <div className="text-[15px] font-bold text-marque-fonce">{session?.restaurant.nom}</div>
            <div className="text-xs text-doux">Caissier : {prenom} · Service ouvert</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <PiluleSync />
          <span className="rounded-full bg-marque-tint px-3 py-1 text-xs font-medium text-marque-fonce">
            {formatFCFA(mesVentes?.total_payees ?? 0)}
          </span>
        </div>
      </header>

      {/* 3 zones : catégories (rail gauche) · produits (centre) · addition (droite) */}
      <div className="grid flex-1 grid-cols-[150px_1fr_0.72fr] gap-3 overflow-hidden">
        {/* Rail catégories vertical */}
        <nav className="flex flex-col gap-1.5 overflow-y-auto pr-1">
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`rounded-[9px] px-3 py-3 text-left text-sm font-medium transition ${
                c.id === categorieActive
                  ? 'bg-marque text-[#412402] shadow-[var(--ombre-marque)]'
                  : 'border border-bordure bg-surface text-doux hover:bg-marque-tint'
              }`}
              onClick={() => setCategorieId(c.id)}
            >
              {c.nom}
            </button>
          ))}
        </nav>

        {/* Grille produits (photo + nom + prix) */}
        <div className="flex flex-col overflow-hidden">
          <div className="grid auto-rows-min grid-cols-3 gap-2.5 overflow-y-auto pr-1 xl:grid-cols-4">
            {combosVisibles.map((combo) => (
              <button
                key={combo.id}
                type="button"
                disabled={!combo.disponible}
                className="carte group flex flex-col overflow-hidden p-0 text-left transition hover:-translate-y-0.5 disabled:opacity-45"
                onClick={() => ajouterItem.mutate({ combo_id: combo.id, quantite: 1, options: [], supplements: [] })}
              >
                <div className="flex aspect-[4/3] w-full items-center justify-center bg-gradient-to-br from-marque to-marque-fonce p-2 text-center text-sm font-black leading-tight text-white">
                  {combo.nom}
                </div>
                <div className="flex items-center justify-between p-2">
                  <span className="text-[11px] font-semibold uppercase text-doux">Combo</span>
                  <span className="prix text-sm">{formatFCFA(combo.prix)}</span>
                </div>
              </button>
            ))}
            {articlesVisibles.map((a) => (
              <button
                key={a.id}
                type="button"
                disabled={!a.disponible}
                className="carte group flex flex-col overflow-hidden p-0 text-left transition hover:-translate-y-0.5 disabled:opacity-100"
                onClick={() => clicArticle(a)}
              >
                <div className="relative aspect-[4/3] w-full overflow-hidden bg-marque-tint">
                  {a.image_url ? (
                    <img
                      src={a.image_url}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover transition duration-200 group-hover:scale-105"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-xl font-black text-marque-fonce/30">
                      {a.nom.slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  {!a.disponible && (
                    <div className="absolute inset-0 flex items-center justify-center bg-fort/45">
                      <span className="rounded-full bg-alerte px-2.5 py-0.5 text-xs font-bold text-white">Épuisé</span>
                    </div>
                  )}
                </div>
                <div className="flex flex-1 flex-col gap-0.5 p-2">
                  <div className="line-clamp-2 text-sm font-semibold leading-tight">{a.nom}</div>
                  <div className="prix text-sm">{formatFCFA(a.prix_base)}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Addition */}
        <aside className="carte flex flex-col overflow-hidden p-3.5">
          <div className="mb-2.5 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              <IconReceipt size={17} />
              {commande.table_numero ? `Table ${commande.table_numero}` : `Ticket n° ${commande.numero_ticket}`}
            </span>
            <span className="rounded-full bg-info-tint px-2.5 py-0.5 text-[11px] font-medium text-info">
              {LIBELLES_TYPES_COMMANDE[commande.type]}
            </span>
          </div>

          <div className="flex-1 space-y-1 overflow-y-auto border-t border-bordure pt-2 text-sm">
            {itemsActifs.length === 0 && <div className="pt-6 text-center text-doux">Addition vide — touchez un article</div>}
            {itemsActifs.map((item) => (
              <div key={item.id} className="rounded-lg px-1 py-1.5 hover:bg-[var(--surface-douce)]">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium">{item.quantite}× {item.nom_snapshot}</span>
                  <span className="font-semibold tabular-nums">{formatFCFA(item.total_ligne)}</span>
                </div>
                {item.supplements.map((s) => (
                  <div key={s.nom} className="pl-3 text-xs text-doux">+ {s.nom} ({formatFCFA(s.prix)})</div>
                ))}
                {item.options.filter((o) => o.choix.length > 0).map((o) => (
                  <div key={o.groupe} className="pl-3 text-xs text-doux">{o.groupe} : {o.choix.join(', ')}</div>
                ))}
                <div className="mt-1 flex items-center gap-1.5">
                  {item.envoye ? (
                    <span className="text-xs text-alerte">En cuisine</span>
                  ) : (
                    <>
                      <button type="button" className="btn-blanc h-8 w-8 p-0" disabled={item.quantite <= 1} onClick={() => changerQuantite.mutate({ itemId: item.id, quantite: item.quantite - 1 })}>−</button>
                      <span className="w-6 text-center font-bold">{item.quantite}</span>
                      <button type="button" className="btn-blanc h-8 w-8 p-0" onClick={() => changerQuantite.mutate({ itemId: item.id, quantite: item.quantite + 1 })}>+</button>
                    </>
                  )}
                  <button type="button" className="ml-auto text-xs font-medium text-alerte" onClick={() => setItemAAnnuler(item)}>
                    Annuler
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-auto border-t border-bordure pt-2.5">
            {commande.promo_montant > 0 && (
              <div className="flex justify-between text-xs text-ok"><span>Promo {commande.promo_nom}</span><span>−{formatFCFA(commande.promo_montant)}</span></div>
            )}
            {commande.remise_montant > 0 && (
              <div className="flex justify-between text-xs text-ok"><span>Remise</span><span>−{formatFCFA(commande.remise_montant)}</span></div>
            )}
            {commande.fidelite_montant > 0 && (
              <div className="flex justify-between text-xs text-ok"><span>Fidélité</span><span>−{formatFCFA(commande.fidelite_montant)}</span></div>
            )}
            <div className="mb-2.5 flex items-baseline justify-between">
              <span className="text-sm text-doux">Total</span>
              <span className="text-[23px] font-black text-marque-fonce">{formatFCFA(commande.total)}</span>
            </div>
            <button
              type="button"
              className="btn-blanc mb-1.5 w-full py-2.5"
              disabled={itemsActifs.length === 0 || imprimerFacture.isPending}
              onClick={() => imprimerFacture.mutate()}
            >
              <IconPrinter size={17} /> {imprimerFacture.isPending ? 'Impression…' : 'Imprimer la facture'}
            </button>
            <button
              type="button"
              className="btn-ok w-full py-3.5"
              disabled={commande.total <= 0}
              onClick={() => aller('paiement', commande.id)}
            >
              <IconCash size={18} /> Encaisser
            </button>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              <button type="button" className="btn-blanc text-[13px]" onClick={() => envoyerCuisine.mutate()} disabled={itemsActifs.length === 0}>
                <IconSend size={16} /> Envoyer en cuisine
              </button>
              <button type="button" className="btn-blanc text-[13px]" onClick={() => setRemiseOuverte(true)} disabled={itemsActifs.length === 0}>
                Remise
              </button>
            </div>
          </div>
        </aside>
      </div>

      {/* Navigation 4 tuiles (maquette) */}
      <nav className="grid grid-cols-4 gap-2.5">
        <NavTuile principal libelle="Nouvelle commande" onClick={() => aller('accueil')}><IconPlus size={19} /></NavTuile>
        <NavTuile libelle="Tables" onClick={() => aller('tables')}><IconLayoutGrid size={19} /></NavTuile>
        <NavTuile libelle="Mes ventes" onClick={() => aller('mes-ventes')}><IconList size={19} /></NavTuile>
        <NavTuile libelle="J’ai fini" onClick={() => aller('cloture')}><IconFlagCheck size={19} /></NavTuile>
      </nav>

      {articleOuvert && (
        <ModaleArticle
          article={articleOuvert}
          onAjouter={(corps) => {
            ajouterItem.mutate(corps);
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
    </div>
  );
}

function NavTuile({
  libelle,
  principal,
  onClick,
  children,
}: {
  libelle: string;
  principal?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-center gap-0.5 rounded-[10px] px-3 py-3 text-[13px] font-medium transition active:scale-[0.98] ${
        principal ? 'bg-marque text-[#412402] shadow-[var(--ombre-marque)]' : 'carte text-fort'
      }`}
    >
      {children}
      {libelle}
    </button>
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
            <div className="mb-1 font-semibold">{g.nom}</div>
            <div className="flex flex-wrap gap-2">
              {g.options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className={`btn ${choix[g.nom]?.includes(o.nom) ? 'bg-marque text-white' : 'border border-bordure bg-surface'}`}
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
            <div className="mb-1 font-semibold">Suppléments</div>
            <div className="flex flex-wrap gap-2">
              {article.supplements.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={`btn ${supplements.includes(s.id) ? 'bg-marque text-white' : 'border border-bordure bg-surface'}`}
                  onClick={() =>
                    setSupplements((prev) =>
                      prev.includes(s.id) ? prev.filter((x) => x !== s.id) : [...prev, s.id],
                    )
                  }
                >
                  {s.nom} +{formatFCFA(s.prix)}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex items-center gap-3">
          <button type="button" className="btn-blanc h-12 w-12 p-0 text-xl" onClick={() => setQuantite(Math.max(1, quantite - 1))}>−</button>
          <span className="w-8 text-center text-xl font-bold">{quantite}</span>
          <button type="button" className="btn-blanc h-12 w-12 p-0 text-xl" onClick={() => setQuantite(quantite + 1)}>+</button>
        </div>
        <button
          type="button"
          className="btn-accent w-full py-4 text-lg"
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

  // Article déjà envoyé en cuisine → PIN manager obligatoire (action protégée)
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
