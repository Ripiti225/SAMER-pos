import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ArticleVue, CatalogueVue, CommandeItemVue, CommandeVue } from '@pos/shared';
import { formatFCFA, LIBELLES_STATUTS_COMMANDE, LIBELLES_TYPES_COMMANDE } from '@pos/shared';
import { api } from '../api';
import { Modale } from '../components/Modale';
import { ModalePinManager } from '../components/ModalePinManager';
import { useCaisse } from '../stores/session';

export function Commande() {
  const { commandeId, aller, afficherToast } = useCaisse();
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

  const clicArticle = (a: ArticleVue) => {
    if (!a.disponible) return;
    if (a.groupes_options.length > 0 || a.supplements.length > 0) {
      setArticleOuvert(a);
    } else {
      ajouterItem.mutate({ article_id: a.id, quantite: 1, options: [], supplements: [] });
    }
  };

  return (
    <div className="flex h-screen flex-col bg-fond">
      <header className="z-10 flex items-center gap-3 border-b border-bordure bg-surface px-4 py-3 shadow-[var(--ombre-1)]">
        <button type="button" className="btn-blanc" onClick={() => aller('accueil')}>
          ← Accueil
        </button>
        <div className="flex-1">
          <div className="text-lg font-black text-marque-fonce">Ticket n° {commande.numero_ticket}</div>
          <div className="text-sm text-doux">
            {LIBELLES_TYPES_COMMANDE[commande.type]}
            {commande.table_numero ? ` — Table ${commande.table_numero}` : ''}
            {commande.partenaire ? ` — ${commande.partenaire}` : ''}
          </div>
        </div>
        <span className="rounded-full bg-marque-tint px-3 py-1 text-sm font-semibold text-marque-fonce">
          {LIBELLES_STATUTS_COMMANDE[commande.statut]}
        </span>
      </header>

      {/* Layout §15 : catégories à gauche, articles au centre, addition à droite */}
      <div className="flex flex-1 overflow-hidden">
        <nav className="w-44 shrink-0 space-y-1.5 overflow-y-auto border-r border-bordure bg-[var(--surface-douce)] p-2.5">
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`btn w-full justify-start ${c.id === categorieActive ? 'bg-marque text-white shadow-[var(--ombre-marque)]' : 'bg-transparent hover:bg-marque-tint'}`}
              onClick={() => setCategorieId(c.id)}
            >
              {c.nom}
            </button>
          ))}
        </nav>

        <main className="grid flex-1 auto-rows-min grid-cols-2 gap-3 overflow-y-auto p-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          {combosVisibles.map((combo) => (
            <button
              key={combo.id}
              type="button"
              disabled={!combo.disponible}
              className="carte group flex flex-col overflow-hidden p-0 text-left transition hover:-translate-y-0.5 disabled:opacity-40"
              onClick={() => ajouterItem.mutate({ combo_id: combo.id, quantite: 1, options: [], supplements: [] })}
            >
              <div className="flex aspect-[4/3] w-full items-center justify-center bg-gradient-to-br from-marque to-marque-fonce p-3 text-center text-lg font-black leading-tight text-white">
                {combo.nom}
              </div>
              <div className="flex items-center justify-between gap-1 p-2.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-doux">Combo</span>
                <span className="prix text-lg font-bold">{formatFCFA(combo.prix)}</span>
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
                  <div className="flex h-full w-full items-center justify-center text-2xl font-black text-marque-fonce/30">
                    {a.nom.slice(0, 2).toUpperCase()}
                  </div>
                )}
                {!a.disponible && (
                  <div className="absolute inset-0 flex items-center justify-center bg-fort/45">
                    <span className="rounded-full bg-alerte px-3 py-1 text-sm font-bold text-white">Épuisé</span>
                  </div>
                )}
              </div>
              <div className="flex flex-1 flex-col justify-between gap-1 p-2.5">
                <div className="line-clamp-2 font-semibold leading-tight">{a.nom}</div>
                <div className="prix text-lg font-bold">{formatFCFA(a.prix_base)}</div>
              </div>
            </button>
          ))}
        </main>

        <aside className="flex w-96 shrink-0 flex-col border-l border-bordure bg-surface">
          <div className="border-b border-bordure px-4 py-2.5 text-sm font-bold uppercase tracking-wide text-doux">
            Addition
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            {itemsActifs.length === 0 && (
              <div className="pt-10 text-center text-doux">Addition vide — touchez un article</div>
            )}
            {itemsActifs.map((item) => (
              <div key={item.id} className="carte p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold">{item.nom_snapshot}</div>
                    {item.supplements.map((s) => (
                      <div key={s.nom} className="text-xs text-doux">+ {s.nom} ({formatFCFA(s.prix)})</div>
                    ))}
                    {item.options.filter((o) => o.choix.length > 0).map((o) => (
                      <div key={o.groupe} className="text-xs text-doux">{o.groupe} : {o.choix.join(', ')}</div>
                    ))}
                    {item.envoye && (
                      <div className="mt-1 text-xs text-alerte">En cuisine</div>
                    )}
                  </div>
                  <div className="font-bold">{formatFCFA(item.total_ligne)}</div>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    className="btn-blanc h-12 w-12 p-0 text-xl"
                    disabled={item.quantite <= 1 || item.envoye}
                    onClick={() => changerQuantite.mutate({ itemId: item.id, quantite: item.quantite - 1 })}
                  >
                    −
                  </button>
                  <span className="w-8 text-center text-lg font-bold">{item.quantite}</span>
                  <button
                    type="button"
                    className="btn-blanc h-12 w-12 p-0 text-xl"
                    disabled={item.envoye}
                    onClick={() => changerQuantite.mutate({ itemId: item.id, quantite: item.quantite + 1 })}
                  >
                    +
                  </button>
                  <button type="button" className="btn-alerte ml-auto px-3" onClick={() => setItemAAnnuler(item)}>
                    Annuler
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-1 border-t border-bordure bg-[var(--surface-douce)] p-4 text-sm">
            <div className="flex justify-between text-doux"><span>Sous-total</span><span>{formatFCFA(commande.sous_total)}</span></div>
            {commande.promo_montant > 0 && (
              <div className="flex justify-between text-ok">
                <span>Promo {commande.promo_nom}</span><span>−{formatFCFA(commande.promo_montant)}</span>
              </div>
            )}
            {commande.remise_montant > 0 && (
              <div className="flex justify-between text-ok">
                <span>Remise</span><span>−{formatFCFA(commande.remise_montant)}</span>
              </div>
            )}
            <div className="mt-1 flex items-baseline justify-between border-t border-bordure pt-2">
              <span className="text-base font-bold">Total</span>
              <span className="text-3xl font-black text-marque-fonce">{formatFCFA(commande.total)}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 pt-2">
              <button type="button" className="btn-blanc" onClick={() => envoyerCuisine.mutate()} disabled={itemsActifs.length === 0}>
                Envoyer cuisine
              </button>
              <button type="button" className="btn-blanc" onClick={() => setRemiseOuverte(true)} disabled={itemsActifs.length === 0}>
                Remise
              </button>
              <button
                type="button"
                className="btn-ok col-span-2 py-4 text-xl"
                disabled={commande.total <= 0}
                onClick={() => aller('paiement', commande.id)}
              >
                Payer {formatFCFA(commande.total)}
              </button>
            </div>
          </div>
        </aside>
      </div>

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
