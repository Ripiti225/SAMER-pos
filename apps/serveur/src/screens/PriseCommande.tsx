import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { ArticleVue, CatalogueVue, CommandeVue, TableVue } from '@pos/shared';
import { formatFCFA } from '@pos/shared';
import { api, Modale } from '@pos/shared-ui';
import { fileAttente } from '../file-attente';

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
 * Prise de commande serveur (§B2) : panier LOCAL sur la tablette, puis un seul
 * bouton « Envoyer en cuisine ». L'envoi passe par la file anti-coupure :
 * même WiFi coupé, la commande part dès la reconnexion, sans doublon.
 * Ajout en plusieurs fois : chaque envoi ne contient que les nouveaux articles.
 */
export function PriseCommande({
  tableId,
  onRetour,
  afficherToast,
}: {
  tableId: string;
  onRetour: () => void;
  afficherToast: (m: string) => void;
}) {
  const [categorieId, setCategorieId] = useState<string | null>(null);
  const [articleOuvert, setArticleOuvert] = useState<ArticleVue | null>(null);
  const [panier, setPanier] = useState<LignePanier[]>([]);

  const { data: catalogue } = useQuery({
    queryKey: ['catalogue'],
    queryFn: () => api<CatalogueVue>('/api/catalogue'),
    staleTime: 5 * 60 * 1000,
  });
  const { data: tables } = useQuery({
    queryKey: ['tables'],
    queryFn: () => api<TableVue[]>('/api/tables'),
  });
  const table = tables?.find((t) => t.id === tableId);

  // Commande déjà en cours sur la table (articles déjà envoyés)
  const { data: commande } = useQuery({
    queryKey: ['commande', table?.commande_id],
    queryFn: () => api<CommandeVue>(`/api/commandes/${table!.commande_id}`),
    enabled: !!table?.commande_id,
  });

  const categories = catalogue?.categories ?? [];
  const categorieActive = categorieId ?? categories[0]?.id ?? null;
  const articlesVisibles = (catalogue?.articles ?? []).filter((a) => a.categorie_id === categorieActive);
  const combosVisibles = categorieActive === categories[0]?.id ? catalogue?.combos ?? [] : [];

  const totalPanier = panier.reduce(
    (s, l) => s + (l.prix_affiche + l.supplements.reduce((x, y) => x + y.prix, 0)) * l.quantite,
    0,
  );

  const ajouterAuPanier = (ligne: Omit<LignePanier, 'cle'>) => {
    setPanier((p) => [...p, { ...ligne, cle: crypto.randomUUID() }]);
  };

  const clicArticle = (a: ArticleVue) => {
    if (!a.disponible) return;
    if (a.groupes_options.length > 0 || a.supplements.length > 0) {
      setArticleOuvert(a);
    } else {
      ajouterAuPanier({ article_id: a.id, combo_id: null, nom: a.nom, prix_affiche: a.prix_base, quantite: 1, options: [], supplements: [] });
    }
  };

  const envoyerEnCuisine = async () => {
    if (panier.length === 0) return;
    await fileAttente.enfiler('ENVOYER_CUISINE', {
      action_uuid: crypto.randomUUID(),
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
    afficherToast('Envoyé en cuisine ✔ (livraison garantie même si le WiFi coupe)');
  };

  const demanderAddition = async () => {
    await fileAttente.enfiler('DEMANDER_ADDITION', {
      action_uuid: crypto.randomUUID(),
      table_id: tableId,
    });
    afficherToast('Addition demandée — la caisse est prévenue');
  };

  return (
    <div className="flex h-[calc(100vh-57px)] flex-col">
      <div className="flex items-center gap-3 border-b border-bordure p-3">
        <button type="button" className="btn-blanc" onClick={onRetour}>
          ← Salle
        </button>
        <span className="text-xl font-black">Table {table?.numero ?? '…'}</span>
        {commande && (
          <span className="text-sm text-doux">
            Ticket n° {commande.numero_ticket} — {formatFCFA(commande.total)}
          </span>
        )}
        <button
          type="button"
          className="btn-blanc ml-auto"
          disabled={!table?.commande_id && panier.length === 0}
          onClick={() => void demanderAddition()}
        >
          Demander l’addition
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <nav className="w-36 shrink-0 space-y-2 overflow-y-auto border-r border-bordure p-2">
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`btn w-full ${c.id === categorieActive ? 'bg-marque text-white' : 'border border-bordure bg-surface'}`}
              onClick={() => setCategorieId(c.id)}
            >
              {c.nom}
            </button>
          ))}
        </nav>

        <main className="grid flex-1 auto-rows-min grid-cols-2 gap-3 overflow-y-auto p-3 md:grid-cols-3">
          {combosVisibles.map((combo) => (
            <button
              key={combo.id}
              type="button"
              disabled={!combo.disponible}
              className="carte flex min-h-[88px] flex-col justify-between p-3 text-left hover:border-marque disabled:opacity-40"
              onClick={() =>
                ajouterAuPanier({ article_id: null, combo_id: combo.id, nom: combo.nom, prix_affiche: combo.prix, quantite: 1, options: [], supplements: [] })
              }
            >
              <div className="font-semibold">{combo.nom}</div>
              <div className="font-bold text-marque-fonce">{formatFCFA(combo.prix)}</div>
            </button>
          ))}
          {articlesVisibles.map((a) => (
            <button
              key={a.id}
              type="button"
              disabled={!a.disponible}
              className="carte flex min-h-[88px] flex-col justify-between p-3 text-left hover:border-marque disabled:opacity-45"
              onClick={() => clicArticle(a)}
            >
              <div>
                <div className="font-semibold">{a.nom}</div>
                {!a.disponible && <div className="text-xs font-semibold text-alerte">Épuisé</div>}
              </div>
              <div className="font-bold text-marque-fonce">{formatFCFA(a.prix_base)}</div>
            </button>
          ))}
        </main>

        <aside className="flex w-80 shrink-0 flex-col border-l border-bordure">
          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            {commande && commande.items.length > 0 && (
              <div className="mb-2">
                <div className="mb-1 text-xs font-semibold text-doux">Déjà en cuisine</div>
                {commande.items.map((i) => (
                  <div
                    key={i.id}
                    className={`text-sm ${i.statut_cuisine === 'ANNULE' ? 'text-alerte line-through' : 'text-doux'}`}
                  >
                    {i.quantite} × {i.nom_snapshot}
                  </div>
                ))}
              </div>
            )}

            <div className="text-xs font-semibold text-doux">Nouveaux articles</div>
            {panier.length === 0 && <div className="pt-2 text-sm text-doux">Touchez un article…</div>}
            {panier.map((l) => (
              <div key={l.cle} className="carte p-3">
                <div className="flex justify-between">
                  <div className="font-semibold">{l.nom}</div>
                  <div className="font-bold">
                    {formatFCFA((l.prix_affiche + l.supplements.reduce((x, y) => x + y.prix, 0)) * l.quantite)}
                  </div>
                </div>
                {l.supplements.map((s) => (
                  <div key={s.id} className="text-xs text-doux">+ {s.nom}</div>
                ))}
                {l.options.filter((o) => o.choix.length > 0).map((o) => (
                  <div key={o.groupe} className="text-xs text-doux">{o.groupe} : {o.choix.join(', ')}</div>
                ))}
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    className="btn-blanc h-12 w-12 p-0 text-xl"
                    onClick={() =>
                      setPanier((p) =>
                        p.map((x) => (x.cle === l.cle ? { ...x, quantite: Math.max(1, x.quantite - 1) } : x)),
                      )
                    }
                  >
                    −
                  </button>
                  <span className="w-8 text-center font-bold">{l.quantite}</span>
                  <button
                    type="button"
                    className="btn-blanc h-12 w-12 p-0 text-xl"
                    onClick={() => setPanier((p) => p.map((x) => (x.cle === l.cle ? { ...x, quantite: x.quantite + 1 } : x)))}
                  >
                    +
                  </button>
                  <button type="button" className="btn-alerte ml-auto px-3" onClick={() => setPanier((p) => p.filter((x) => x.cle !== l.cle))}>
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="border-t border-bordure p-3">
            {/* Bouton UNIQUE « Envoyer en cuisine » (§B2) — pas d'encaissement ici */}
            <button
              type="button"
              className="btn-accent w-full py-5 text-xl"
              disabled={panier.length === 0}
              onClick={() => void envoyerEnCuisine()}
            >
              Envoyer en cuisine {panier.length > 0 ? `(${formatFCFA(totalPanier)})` : ''}
            </button>
          </div>
        </aside>
      </div>

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

  const supplementsChoisis = article.supplements.filter((s) => supplements.includes(s.id));
  const prixLigne = (article.prix_base + supplementsChoisis.reduce((x, y) => x + y.prix, 0)) * quantite;

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
                    setSupplements((prev) => (prev.includes(s.id) ? prev.filter((x) => x !== s.id) : [...prev, s.id]))
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
              combo_id: null,
              nom: article.nom,
              prix_affiche: article.prix_base,
              quantite,
              options: Object.entries(choix).map(([groupe, valeurs]) => ({ groupe, choix: valeurs })),
              supplements: supplementsChoisis.map((s) => ({ id: s.id, nom: s.nom, prix: s.prix })),
            })
          }
        >
          Ajouter — {formatFCFA(prixLigne)}
        </button>
      </div>
    } />
  );
}
