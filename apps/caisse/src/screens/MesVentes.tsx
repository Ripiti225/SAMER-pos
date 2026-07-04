import { useQuery } from '@tanstack/react-query';
import { formatFCFA, LIBELLES_TYPES_COMMANDE, type StatutCommande, type TypeCommande } from '@pos/shared';
import { api } from '../api';
import { useCaisse } from '../stores/session';

interface MesVentesVue {
  service: { id: string; ouvert_le: string } | null;
  commandes: {
    id: string;
    numero_ticket: number;
    type: TypeCommande;
    statut: StatutCommande;
    total: number;
    created_at: string;
  }[];
  nb_payees?: number;
  total_payees?: number;
}

const COULEURS_STATUT: Record<string, string> = {
  PAYEE: 'text-emerald-400',
  ANNULEE: 'text-red-400',
};

/** « Mes ventes » : les commandes du service en cours du caissier connecté. */
export function MesVentes() {
  const { aller, session } = useCaisse();
  const estManager = session?.utilisateur.role === 'MANAGER' || session?.utilisateur.role === 'PROPRIETAIRE';

  const { data } = useQuery({
    queryKey: ['mes-ventes'],
    queryFn: () => api<MesVentesVue>('/api/rapports/mes-ventes'),
  });
  const { data: jour } = useQuery({
    queryKey: ['rapport-jour'],
    queryFn: () => api<{ nb_commandes: number; total_ventes: number; par_mode: Record<string, number> }>('/api/rapports/jour'),
    enabled: estManager,
  });
  const { data: topPlats } = useQuery({
    queryKey: ['top-plats'],
    queryFn: () => api<{ nom: string; quantite: number; total: number }[]>('/api/rapports/top-plats'),
    enabled: estManager,
  });
  const { data: parHeure } = useQuery({
    queryKey: ['par-heure'],
    queryFn: () => api<{ heure: number; nb: number; total: number }[]>('/api/rapports/par-heure'),
    enabled: estManager,
  });

  return (
    <div className="min-h-full p-6">
      <header className="mb-6 flex items-center gap-4">
        <button type="button" className="btn-sombre" onClick={() => aller('accueil')}>
          ← Accueil
        </button>
        <h1 className="text-2xl font-bold">Mes ventes</h1>
        {data?.nb_payees !== undefined && (
          <span className="ml-auto text-zinc-400">
            {data.nb_payees} encaissées — <span className="font-bold text-accent">{formatFCFA(data.total_payees ?? 0)}</span>
          </span>
        )}
      </header>

      {!data?.service && <div className="text-zinc-400">Aucun service ouvert.</div>}

      <div className="space-y-2">
        {(data?.commandes ?? []).map((c) => (
          <button
            key={c.id}
            type="button"
            className="carte flex w-full items-center justify-between p-4 text-left hover:border-accent"
            onClick={() => aller(c.statut === 'PAYEE' || c.statut === 'ANNULEE' ? 'paiement' : 'commande', c.id)}
          >
            <div>
              <span className="font-bold">Ticket n° {c.numero_ticket}</span>
              <span className="ml-3 text-sm text-zinc-400">
                {LIBELLES_TYPES_COMMANDE[c.type]} — {new Date(c.created_at).toLocaleTimeString('fr-FR')}
              </span>
            </div>
            <div className="text-right">
              <div className="font-bold">{formatFCFA(c.total)}</div>
              <div className={`text-sm ${COULEURS_STATUT[c.statut] ?? 'text-zinc-400'}`}>{c.statut}</div>
            </div>
          </button>
        ))}
      </div>

      {estManager && (
        <section className="mt-8 grid gap-4 lg:grid-cols-3">
          <div className="carte p-4">
            <h2 className="mb-2 font-bold">Ventes du jour</h2>
            {jour ? (
              <>
                <div className="text-3xl font-black text-accent">{formatFCFA(jour.total_ventes)}</div>
                <div className="text-sm text-zinc-400">{jour.nb_commandes} commandes</div>
              </>
            ) : '…'}
          </div>
          <div className="carte p-4">
            <h2 className="mb-2 font-bold">Top plats</h2>
            {(topPlats ?? []).slice(0, 5).map((p) => (
              <div key={p.nom} className="flex justify-between text-sm">
                <span>{p.nom}</span>
                <span className="text-zinc-400">×{p.quantite}</span>
              </div>
            ))}
          </div>
          <div className="carte p-4">
            <h2 className="mb-2 font-bold">Par heure</h2>
            {(parHeure ?? []).map((h) => (
              <div key={h.heure} className="flex justify-between text-sm">
                <span>{String(h.heure).padStart(2, '0')} h</span>
                <span className="text-zinc-400">{formatFCFA(h.total)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
