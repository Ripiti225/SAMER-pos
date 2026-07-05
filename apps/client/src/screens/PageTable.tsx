import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { CatalogueVue, TableClientVue } from '@pos/shared';
import { formatFCFA, LIBELLES_ETAT_TABLE } from '@pos/shared';
import { api } from '../api';
import { SuiviCommandes } from './SuiviCommandes';

interface LignePanier {
  cle: string;
  article_id: string;
  nom: string;
  prix: number;
  quantite: number;
}

export function PageTable({ jeton, table }: { jeton: string; table: TableClientVue }) {
  const queryClient = useQueryClient();
  const [categorieId, setCategorieId] = useState<string | null>(null);
  const [panier, setPanier] = useState<LignePanier[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const { data: catalogue } = useQuery({
    queryKey: ['catalogue-client', jeton],
    queryFn: () => api<CatalogueVue>(`/api/client/${jeton}/catalogue`),
    staleTime: 5 * 60 * 1000,
  });

  const flash = (m: string) => {
    setMessage(m);
    setTimeout(() => setMessage((x) => (x === m ? null : x)), 4000);
  };

  const appeler = useMutation({
    mutationFn: (type: 'APPEL_SERVEUR' | 'DEMANDE_FACTURE') =>
      api<{ confirmation: string }>(`/api/client/${jeton}/appel`, { method: 'POST', corps: { type } }),
    onSuccess: (r) => flash(r.confirmation),
    onError: (e: Error) => flash(e.message),
  });

  const envoyer = useMutation({
    mutationFn: () =>
      api<{ confirmation: string }>(`/api/client/${jeton}/commande`, {
        method: 'POST',
        corps: { items: panier.map((l) => ({ article_id: l.article_id, quantite: l.quantite, options: [], supplements: [] })) },
      }),
    onSuccess: (r) => {
      setPanier([]);
      flash(r.confirmation);
      void queryClient.invalidateQueries({ queryKey: ['suivi', jeton] });
    },
    onError: (e: Error) => flash(e.message),
  });

  const categories = catalogue?.categories ?? [];
  const categorieActive = categorieId ?? categories[0]?.id ?? null;
  const articles = (catalogue?.articles ?? []).filter((a) => a.categorie_id === categorieActive);
  const totalPanier = panier.reduce((s, l) => s + l.prix * l.quantite, 0);

  const ajouter = (id: string, nom: string, prix: number) => {
    setPanier((p) => {
      const existe = p.find((l) => l.article_id === id);
      if (existe) return p.map((l) => (l.article_id === id ? { ...l, quantite: l.quantite + 1 } : l));
      return [...p, { cle: crypto.randomUUID(), article_id: id, nom, prix, quantite: 1 }];
    });
  };

  return (
    <div className="min-h-full bg-fond text-fort">
      <header className="sticky top-0 z-10 border-b border-bordure bg-surface px-4 py-3">
        <div className="text-sm text-doux">{table.restaurant.nom}</div>
        <div className="text-2xl font-black text-marque-fonce">Table {table.numero}</div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-doux">{table.zone_nom}</span>
          {table.etat !== 'LIBRE' && (
            <span className="rounded-full bg-marque-tint px-2 py-0.5 text-xs font-semibold text-marque-fonce">
              {LIBELLES_ETAT_TABLE[table.etat]}
            </span>
          )}
        </div>
      </header>

      <div className="space-y-4 p-4">
        {/* Deux boutons d'appel */}
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            className="btn-accent min-h-[56px]"
            disabled={appeler.isPending}
            onClick={() => appeler.mutate('APPEL_SERVEUR')}
          >
            Appeler le serveur
          </button>
          <button
            type="button"
            className="btn-blanc min-h-[56px]"
            disabled={appeler.isPending}
            onClick={() => appeler.mutate('DEMANDE_FACTURE')}
          >
            Demander la facture
          </button>
        </div>

        {/* Suivi de commande (point 1c) */}
        <SuiviCommandes jeton={jeton} />

        {/* Menu + panier */}
        <section>
          <h2 className="mb-2 text-lg font-bold">Commander</h2>
          <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
            {categories.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`btn shrink-0 ${c.id === categorieActive ? 'bg-marque text-white' : 'border border-bordure bg-surface'}`}
                onClick={() => setCategorieId(c.id)}
              >
                {c.nom}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {articles.map((a) => (
              <button
                key={a.id}
                type="button"
                disabled={!a.disponible}
                className="carte flex min-h-[84px] flex-col justify-between p-3 text-left disabled:opacity-45"
                onClick={() => ajouter(a.id, a.nom, a.prix_base)}
              >
                <div>
                  <div className="font-semibold">{a.nom}</div>
                  {!a.disponible && <div className="text-xs font-semibold text-alerte">Épuisé</div>}
                </div>
                <div className="prix font-bold">{formatFCFA(a.prix_base)}</div>
              </button>
            ))}
          </div>
        </section>
      </div>

      {/* Panier fixe en bas */}
      {panier.length > 0 && (
        <div className="sticky bottom-0 border-t border-bordure bg-surface p-4">
          <div className="mb-2 max-h-32 space-y-1 overflow-y-auto">
            {panier.map((l) => (
              <div key={l.cle} className="flex items-center gap-2 text-sm">
                <span className="flex-1">{l.quantite} × {l.nom}</span>
                <span className="prix font-semibold">{formatFCFA(l.prix * l.quantite)}</span>
                <button type="button" className="text-alerte" onClick={() => setPanier((p) => p.filter((x) => x.cle !== l.cle))}>
                  retirer
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="btn-ok min-h-[52px] w-full text-lg"
            disabled={envoyer.isPending}
            onClick={() => envoyer.mutate()}
          >
            Envoyer à mon serveur — {formatFCFA(totalPanier)}
          </button>
          <p className="mt-1 text-center text-xs text-doux">Votre serveur validera la commande avant la cuisine.</p>
        </div>
      )}

      {message && (
        <div className="fixed bottom-24 left-1/2 z-20 -translate-x-1/2 rounded-xl bg-marque-fonce px-5 py-3 text-white shadow-xl">
          {message}
        </div>
      )}
    </div>
  );
}
