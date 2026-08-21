import { useQuery } from '@tanstack/react-query';
import { formatFCFA, LIBELLES_STATUTS_COMMANDE, LIBELLES_TYPES_COMMANDE, type RetoursVue, type StatutCommande, type TypeCommande } from '@pos/shared';
import { api } from '../api';
import { CarteSante } from '../components/SanteSync';
import { EnteteEcran } from '../components/EnteteEcran';
import { TableauBord } from '../components/TableauBord';
import { useCaisse } from '../stores/session';

interface MesVentesVue {
  service: { id: string; ouvert_le: string } | null;
  commandes: {
    id: string;
    numero_ticket: number;
    code_commande: string | null;
    type: TypeCommande;
    statut: StatutCommande;
    total: number;
    created_at: string;
  }[];
  produits?: { nom: string; quantite: number }[];
  nb_payees?: number;
  total_payees?: number;
  retours?: RetoursVue;
}

/** « Mes ventes » : les commandes du service en cours du caissier connecté. */
export function MesVentes() {
  const { aller, rentrer, session } = useCaisse();
  const estManager = session?.utilisateur.role === 'MANAGER' || session?.utilisateur.role === 'PROPRIETAIRE';
  // Voir les montants (CA) = permission Rapport X (manager/propriétaire). Un
  // caissier ne voit PAS l'argent, mais la liste des produits vendus (inventaire).
  const voitMontants = session?.permissions.includes('rapports.x') ?? false;

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
  const { data: retoursJour } = useQuery({
    queryKey: ['retours-jour'],
    queryFn: () => api<RetoursVue & { date: string }>('/api/rapports/retours-jour'),
    enabled: estManager,
  });
  const { data: parHeure } = useQuery({
    queryKey: ['par-heure'],
    queryFn: () => api<{ heure: number; nb: number; total: number }[]>('/api/rapports/par-heure'),
    enabled: estManager,
  });

  return (
    <div className="min-h-full bg-fond p-6">
      <EnteteEcran
        titre="Mes ventes"
        onRetour={rentrer}
        actions={data?.nb_payees !== undefined ? (
          <span className="rounded-full bg-surface-douce px-3 py-1.5 text-sm text-doux">
            {data.nb_payees} encaissées
            {voitMontants && <> · <span className="font-bold text-marque-fonce tabular-nums">{formatFCFA(data.total_payees ?? 0)}</span></>}
          </span>
        ) : undefined}
      />

      {!data?.service && <div className="carte p-6 text-center text-doux">Aucun service ouvert.</div>}

      <div className="space-y-2">
        {(data?.commandes ?? []).map((c) => (
          <button
            key={c.id}
            type="button"
            className="carte flex w-full items-center justify-between p-4 text-left shadow-e1 transition hover:shadow-e2"
            onClick={() => aller(c.statut === 'PAYEE' || c.statut === 'ANNULEE' ? 'paiement' : 'commande', c.id)}
          >
            <div>
              <span className="font-bold">{c.code_commande ?? `Ticket n° ${c.numero_ticket}`}</span>
              <span className="ml-3 text-sm text-doux">
                {LIBELLES_TYPES_COMMANDE[c.type]} — {new Date(c.created_at).toLocaleTimeString('fr-FR')}
              </span>
            </div>
            <div className="flex items-center gap-3 text-right">
              {voitMontants && <div className="font-bold tabular-nums">{formatFCFA(c.total)}</div>}
              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                c.statut === 'PAYEE' ? 'bg-ok-tint text-ok' : c.statut === 'ANNULEE' ? 'bg-alerte-tint text-alerte' : 'bg-surface-tres-haute text-doux'
              }`}>
                {LIBELLES_STATUTS_COMMANDE[c.statut]}
              </span>
            </div>
          </button>
        ))}
      </div>

      {/* Produits vendus du service — pour l'inventaire (quantités, sans montant) */}
      {(data?.produits?.length ?? 0) > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-lg font-bold">Produits vendus — inventaire</h2>
          <div className="carte divide-y divide-bordure p-0">
            {(data?.produits ?? []).map((p) => (
              <div key={p.nom} className="flex items-center justify-between px-4 py-2.5">
                <span>{p.nom}</span>
                <span className="text-lg font-bold tabular-nums">×{p.quantite}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* RETOURS du service : plats lancés en cuisine puis annulés au PIN
          manager. Ils ne sont NI dans les ventes ci-dessus, NI dans les
          produits vendus, NI dans les sorties d'inventaire — d'où leur place
          juste après, pour qu'on ne les cherche pas ailleurs. */}
      {(data?.retours?.nb ?? 0) > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-lg font-bold">
            Retours{' '}
            <span className="text-sm font-normal text-doux">
              — {data!.retours!.nb} article{data!.retours!.nb > 1 ? 's' : ''} refait
              {data!.retours!.nb > 1 ? 's' : ''}
              {voitMontants && <> · {formatFCFA(data!.retours!.montant)}</>}
            </span>
          </h2>
          <div className="carte divide-y divide-bordure p-0">
            {data!.retours!.detail.map((r, i) => (
              <div key={`${r.numero_ticket}-${r.nom}-${i}`} className="flex items-start justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <div className="font-semibold">
                    {r.quantite} × {r.nom}
                    <span className="ml-2 text-xs font-normal text-doux">ticket n° {r.numero_ticket}</span>
                  </div>
                  <div className="truncate text-xs text-doux">
                    {r.motif ?? 'sans motif'}
                    {r.par_nom ? ` — autorisé par ${r.par_nom}` : ''}
                  </div>
                </div>
                {voitMontants && <span className="tabular-nums text-doux">{formatFCFA(r.montant)}</span>}
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-doux">
            Sans effet sur la vente, le tiroir ou l’inventaire : ces plats ont été produits, pas vendus.
          </p>
        </section>
      )}

      {estManager && (
        <section className="mt-8 grid gap-4 lg:grid-cols-3">
          <div className="carte p-4">
            <h2 className="mb-2 font-bold">Ventes du jour</h2>
            {jour ? (
              <>
                <div className="text-3xl font-black text-marque-fonce">{formatFCFA(jour.total_ventes)}</div>
                <div className="text-sm text-doux">{jour.nb_commandes} commandes</div>
              </>
            ) : '…'}
          </div>
          <div className="carte p-4">
            <h2 className="mb-2 font-bold">Top plats</h2>
            {(topPlats ?? []).slice(0, 5).map((p) => (
              <div key={p.nom} className="flex justify-between text-sm">
                <span>{p.nom}</span>
                <span className="text-doux">×{p.quantite}</span>
              </div>
            ))}
          </div>
          {/* Retours du JOUR, tous services confondus : c'est la vue qui dit si
              le restaurant refait souvent ses plats, au-delà d'un seul shift. */}
          <div className="carte p-4">
            <h2 className="mb-2 font-bold">Retours du jour</h2>
            {retoursJour ? (
              retoursJour.nb === 0 ? (
                <div className="text-sm text-doux">Aucun plat refait aujourd’hui.</div>
              ) : (
                <>
                  <div className="text-3xl font-black text-attente-txt">{retoursJour.nb}</div>
                  <div className="text-sm text-doux">
                    article{retoursJour.nb > 1 ? 's' : ''} · {formatFCFA(retoursJour.montant)}
                  </div>
                  <div className="mt-2 space-y-0.5">
                    {retoursJour.par_produit.slice(0, 5).map((p) => (
                      <div key={p.nom} className="flex justify-between text-sm">
                        <span className="truncate">{p.nom}</span>
                        <span className="text-doux">×{p.quantite}</span>
                      </div>
                    ))}
                  </div>
                </>
              )
            ) : '…'}
          </div>
          <div className="carte p-4">
            <h2 className="mb-2 font-bold">Par heure</h2>
            {(parHeure ?? []).map((h) => (
              <div key={h.heure} className="flex justify-between text-sm">
                <span>{String(h.heure).padStart(2, '0')} h</span>
                <span className="text-doux">{formatFCFA(h.total)}</span>
              </div>
            ))}
          </div>
          <CarteSante />
          <TableauBord />
        </section>
      )}
    </div>
  );
}
