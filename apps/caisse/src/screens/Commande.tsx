import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ArticleVue, CatalogueVue, CommandeItemVue, CommandeVue } from '@pos/shared';
import { formatFCFA, LIBELLES_TYPES_COMMANDE } from '@pos/shared';
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
    return <div className="flex min-h-full items-center justify-center text-zinc-400">Chargement…</div>;
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
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-zinc-800 p-3">
        <button type="button" className="btn-sombre" onClick={() => aller('accueil')}>
          ← Accueil
        </button>
        <div className="flex-1">
          <span className="font-bold">Ticket n° {commande.numero_ticket}</span>
          <span className="ml-3 text-sm text-zinc-400">
            {LIBELLES_TYPES_COMMANDE[commande.type]}
            {commande.table_numero ? ` — Table ${commande.table_numero}` : ''}
            {commande.partenaire ? ` — ${commande.partenaire}` : ''}
          </span>
        </div>
        <span className="rounded-full bg-zinc-800 px-3 py-1 text-sm">{commande.statut}</span>
      </header>

      {/* Layout §15 : catégories à gauche, articles au centre, addition à droite */}
      <div className="flex flex-1 overflow-hidden">
        <nav className="w-40 shrink-0 space-y-2 overflow-y-auto border-r border-zinc-800 p-2">
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`btn w-full ${c.id === categorieActive ? 'bg-accent text-zinc-950' : 'bg-zinc-800'}`}
              onClick={() => setCategorieId(c.id)}
            >
              {c.nom}
            </button>
          ))}
        </nav>

        <main className="grid flex-1 auto-rows-min grid-cols-2 gap-3 overflow-y-auto p-3 md:grid-cols-3 xl:grid-cols-4">
          {combosVisibles.map((combo) => (
            <button
              key={combo.id}
              type="button"
              disabled={!combo.disponible}
              className="carte flex min-h-[96px] flex-col justify-between p-3 text-left hover:border-accent disabled:opacity-40"
              onClick={() => ajouterItem.mutate({ combo_id: combo.id, quantite: 1, options: [], supplements: [] })}
            >
              <div className="font-semibold">🎁 {combo.nom}</div>
              <div className="text-accent font-bold">{formatFCFA(combo.prix)}</div>
            </button>
          ))}
          {articlesVisibles.map((a) => (
            <button
              key={a.id}
              type="button"
              disabled={!a.disponible}
              className="carte flex min-h-[96px] flex-col justify-between p-3 text-left hover:border-accent disabled:opacity-40"
              onClick={() => clicArticle(a)}
            >
              <div>
                {a.image_url ? (
                  <img src={a.image_url} alt="" className="mb-1 h-12 w-full rounded object-cover" />
                ) : null}
                <div className="font-semibold">{a.nom}</div>
              </div>
              <div className="text-accent font-bold">{formatFCFA(a.prix_base)}</div>
            </button>
          ))}
        </main>

        <aside className="flex w-96 shrink-0 flex-col border-l border-zinc-800">
          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            {itemsActifs.length === 0 && (
              <div className="pt-8 text-center text-zinc-500">Addition vide — touchez un article</div>
            )}
            {itemsActifs.map((item) => (
              <div key={item.id} className="carte p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold">{item.nom_snapshot}</div>
                    {item.supplements.map((s) => (
                      <div key={s.nom} className="text-xs text-zinc-400">+ {s.nom} ({formatFCFA(s.prix)})</div>
                    ))}
                    {item.options.filter((o) => o.choix.length > 0).map((o) => (
                      <div key={o.groupe} className="text-xs text-zinc-400">{o.groupe} : {o.choix.join(', ')}</div>
                    ))}
                    {item.envoye && (
                      <div className="mt-1 text-xs text-amber-400">En cuisine</div>
                    )}
                  </div>
                  <div className="font-bold">{formatFCFA(item.total_ligne)}</div>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    className="btn-sombre h-12 w-12 p-0 text-xl"
                    disabled={item.quantite <= 1 || item.envoye}
                    onClick={() => changerQuantite.mutate({ itemId: item.id, quantite: item.quantite - 1 })}
                  >
                    −
                  </button>
                  <span className="w-8 text-center text-lg font-bold">{item.quantite}</span>
                  <button
                    type="button"
                    className="btn-sombre h-12 w-12 p-0 text-xl"
                    disabled={item.envoye}
                    onClick={() => changerQuantite.mutate({ itemId: item.id, quantite: item.quantite + 1 })}
                  >
                    +
                  </button>
                  <button type="button" className="btn-danger ml-auto px-3" onClick={() => setItemAAnnuler(item)}>
                    Annuler
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-1 border-t border-zinc-800 p-3 text-sm">
            <div className="flex justify-between"><span>Sous-total</span><span>{formatFCFA(commande.sous_total)}</span></div>
            {commande.promo_montant > 0 && (
              <div className="flex justify-between text-emerald-400">
                <span>Promo {commande.promo_nom}</span><span>−{formatFCFA(commande.promo_montant)}</span>
              </div>
            )}
            {commande.remise_montant > 0 && (
              <div className="flex justify-between text-emerald-400">
                <span>Remise</span><span>−{formatFCFA(commande.remise_montant)}</span>
              </div>
            )}
            <div className="flex justify-between pt-1 text-xl font-black">
              <span>TOTAL</span><span className="text-accent">{formatFCFA(commande.total)}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 pt-2">
              <button type="button" className="btn-sombre" onClick={() => envoyerCuisine.mutate()} disabled={itemsActifs.length === 0}>
                Envoyer cuisine
              </button>
              <button type="button" className="btn-sombre" onClick={() => setRemiseOuverte(true)} disabled={itemsActifs.length === 0}>
                Remise
              </button>
              <button
                type="button"
                className="btn-accent col-span-2 py-4 text-xl"
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
                  className={`btn ${choix[g.nom]?.includes(o.nom) ? 'bg-accent text-zinc-950' : 'bg-zinc-800'}`}
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
                  className={`btn ${supplements.includes(s.id) ? 'bg-accent text-zinc-950' : 'bg-zinc-800'}`}
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
          <button type="button" className="btn-sombre h-12 w-12 p-0 text-xl" onClick={() => setQuantite(Math.max(1, quantite - 1))}>−</button>
          <span className="w-8 text-center text-xl font-bold">{quantite}</span>
          <button type="button" className="btn-sombre h-12 w-12 p-0 text-xl" onClick={() => setQuantite(quantite + 1)}>+</button>
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
        <label className="block text-sm text-zinc-400">Motif (obligatoire)</label>
        <input className="champ" value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="ex : erreur de saisie" />
        <button
          type="button"
          className="btn-danger w-full py-3"
          disabled={motif.trim().length < 3 || enCours}
          onClick={() => onConfirmer(motif.trim())}
        >
          {enCours ? 'Annulation…' : 'Confirmer l’annulation'}
        </button>
      </div>
    } />
  );
}
