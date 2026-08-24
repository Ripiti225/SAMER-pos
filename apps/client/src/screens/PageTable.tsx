import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { CatalogueVue, TableClientVue } from '@pos/shared';
import { formatFCFA, LIBELLES_ETAT_TABLE } from '@pos/shared';
import { api } from '../api';
import { ConfirmationPaiement } from './ConfirmationPaiement';
import { SuiviCommandes } from './SuiviCommandes';

interface LignePanier {
  cle: string;
  article_id: string;
  nom: string;
  prix: number;
  quantite: number;
}

/**
 * Identifiant de ligne (clé React). `crypto.randomUUID()` n'existe QUE en
 * contexte sécurisé : sur un téléphone qui ouvre l'app en http://IP-LAN (QR de
 * table), il est absent → repli sans plantage.
 */
function nouvelleCle(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function PageTable({ jeton, table }: { jeton: string; table: TableClientVue }) {
  const queryClient = useQueryClient();
  const [categorieId, setCategorieId] = useState<string | null>(null);
  const [panier, setPanier] = useState<LignePanier[]>([]);
  const [telephone, setTelephone] = useState('');
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
        corps: {
          items: panier.map((l) => ({ article_id: l.article_id, quantite: l.quantite, options: [], supplements: [] })),
          // Champ vide = pas de numéro : le serveur l'accepte, sans fidélité.
          telephone: telephone.trim(),
        },
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
      return [...p, { cle: nouvelleCle(), article_id: id, nom, prix, quantite: 1 }];
    });
  };

  return (
    <div className="min-h-full bg-fond text-fort">
      <header className="sticky top-0 z-10 border-b border-bordure bg-surface px-4 py-3 shadow-e1">
        <div className="text-sm font-medium text-doux">{table.restaurant.nom}</div>
        <div className="flex items-center justify-between">
          <div className="text-2xl font-bold text-marque-fonce">Table {table.numero}</div>
          {table.etat !== 'LIBRE' && (
            <span className="rounded-full bg-marque-tint px-3 py-1 text-xs font-semibold text-marque-fonce">
              {LIBELLES_ETAT_TABLE[table.etat]}
            </span>
          )}
        </div>
        <span className="text-xs text-doux">{table.zone_nom}</span>
      </header>

      <div className="space-y-5 p-4">
        {/* Deux boutons d'appel */}
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            className="flex min-h-[60px] items-center justify-center rounded-[13px] bg-marque text-lg font-bold text-sur-marque shadow-e2 transition active:translate-y-px disabled:opacity-40"
            disabled={appeler.isPending}
            onClick={() => appeler.mutate('APPEL_SERVEUR')}
          >
            Appeler le serveur
          </button>
          <button
            type="button"
            className="flex min-h-[60px] items-center justify-center rounded-[13px] border-2 border-bordure-forte text-lg font-semibold text-marque-fonce transition hover:bg-marque/5 disabled:opacity-40"
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
                className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold transition ${
                  c.id === categorieActive ? 'bg-marque text-sur-marque shadow-e1' : 'border border-bordure bg-surface text-doux'
                }`}
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
                className="carte flex flex-col overflow-hidden p-0 text-left shadow-e1 transition active:scale-[0.98]"
                onClick={() => ajouter(a.id, a.nom, a.prix_base)}
              >
                <div className="relative aspect-[4/3] w-full overflow-hidden bg-marque-tint">
                  {a.image_url ? (
                    <img src={a.image_url} alt="" loading="lazy" className="h-full w-full object-cover" />
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
                  {a.description && <div className="line-clamp-1 text-xs text-doux">{a.description}</div>}
                  <div className="prix text-base font-bold">{formatFCFA(a.prix_base)}</div>
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>

      {/* Panier fixe en bas */}
      {panier.length > 0 && (
        <div className="sticky bottom-0 border-t border-bordure bg-surface p-4 shadow-e3">
          <div className="mb-3 max-h-32 space-y-1.5 overflow-y-auto">
            {panier.map((l) => (
              <div key={l.cle} className="flex items-center gap-2 text-sm">
                <span className="flex-1">{l.quantite} × {l.nom}</span>
                <span className="prix font-semibold tabular-nums">{formatFCFA(l.prix * l.quantite)}</span>
                <button
                  type="button"
                  className="rounded-full px-2 py-0.5 text-xs font-medium text-alerte transition hover:bg-alerte/10"
                  onClick={() => setPanier((p) => p.filter((x) => x.cle !== l.cle))}
                >
                  retirer
                </button>
              </div>
            ))}
          </div>
          {/* Numéro TOUJOURS demandé, JAMAIS obligatoire : sans lui la commande
              part quand même, et le libellé du bouton dit ce qui est perdu. */}
          <label className="mb-3 block">
            <span className="mb-1 block text-sm font-semibold">
              Votre numéro pour cumuler vos points de fidélité
            </span>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="07 00 00 00 00"
              value={telephone}
              onChange={(e) => setTelephone(e.target.value)}
              className="min-h-[52px] w-full rounded-[13px] border-2 border-bordure bg-fond px-4 text-lg tabular-nums outline-none focus:border-marque"
            />
            <span className="mt-1 block text-xs text-doux">
              Facultatif — sans numéro, pas de points sur cette commande.
            </span>
          </label>
          <button
            type="button"
            className="flex min-h-[56px] w-full items-center justify-center rounded-[13px] bg-marque text-lg font-bold text-sur-marque shadow-e2 transition active:translate-y-px disabled:opacity-40"
            disabled={envoyer.isPending}
            onClick={() => envoyer.mutate()}
          >
            {telephone.trim()
              ? `Envoyer à mon serveur · ${formatFCFA(totalPanier)}`
              : `Commander sans points · ${formatFCFA(totalPanier)}`}
          </button>
          <p className="mt-2 text-center text-xs text-doux">Votre serveur validera la commande avant la cuisine.</p>
        </div>
      )}

      {message && (
        <div className="fixed bottom-24 left-1/2 z-20 -translate-x-1/2 rounded-xl bg-marque-fonce px-5 py-3 text-white shadow-xl">
          {message}
        </div>
      )}

      <ConfirmationPaiement jeton={jeton} />
    </div>
  );
}
