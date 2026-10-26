import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatFCFA, LIBELLES_MODES, LIBELLES_STATUTS_COMMANDE, LIBELLES_TYPES_COMMANDE, type CommandeVue, type RetoursVue, type StatutCommande, type TypeCommande } from '@pos/shared';
import { api } from '../api';
import { Modale } from '../components/Modale';
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

/** « Tables en cours » (ex-« Mes ventes », renommé le 2026-10-26) : les commandes pas encore encaissées du service du caissier connecté. */
export function MesVentes() {
  const { aller, rentrer, session } = useCaisse();
  // Le chiffre d'affaires en temps réel est réservé au PROPRIÉTAIRE
  // (2026-10-26) : les autres comptes savent combien de tables sont encaissées,
  // pas combien elles ont rapporté. Le serveur applique la même règle.
  const estProprio = session?.utilisateur.role === 'PROPRIETAIRE';
  const voitMontants = estProprio;
  const estManager = estProprio;

  const { data } = useQuery({
    queryKey: ['mes-ventes'],
    queryFn: () => api<MesVentesVue>('/api/rapports/mes-ventes'),
  });
  // Seules les tables EN COURS (2026-10-26) : une table payée n'a plus rien à
  // faire ici — l'ouvrir menait à son écran de paiement, ce que le
  // propriétaire ne veut plus. Elles restent comptées dans « N encaissées ».
  // La liste des produits vendus a été retirée en même temps : l'inventaire
  // a son propre écran.
  const enCours = (data?.commandes ?? []).filter((c) => c.statut !== 'PAYEE' && c.statut !== 'ANNULEE');
  const { data: jour } = useQuery({
    queryKey: ['rapport-jour'],
    queryFn: () =>
      api<{ nb_commandes: number; total_ventes: number; par_mode: Record<string, number>; en_direct: boolean; shifts_en_cours: number }>('/api/rapports/jour'),
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
        titre="Tables en cours"
        onRetour={rentrer}
        actions={data?.nb_payees !== undefined ? (
          <span className="rounded-full bg-surface-douce px-3 py-1.5 text-sm text-doux">
            {data.nb_payees} encaissées
            {voitMontants && <> · <span className="font-bold text-marque-fonce tabular-nums">{formatFCFA(data.total_payees ?? 0)}</span></>}
          </span>
        ) : undefined}
      />

      {!data?.service && !estProprio && <div className="carte p-6 text-center text-doux">Aucun service ouvert.</div>}
      {data?.service && enCours.length === 0 && (
        <div className="carte p-6 text-center text-doux">Aucune table en cours : tout est encaissé.</div>
      )}

      <div className="space-y-2">
        {enCours.map((c) => (
          <button
            key={c.id}
            type="button"
            className="carte flex w-full items-center justify-between p-4 text-left shadow-e1 transition hover:shadow-e2"
            onClick={() => aller('commande', c.id)}
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

      {estProprio && <TablesEncaissees />}

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

      {/* Le serveur ne compte que les shifts CLÔTURÉS pour tout autre que le
          propriétaire : on le dit, sinon un total bas passerait pour une
          mauvaise journée. */}
      {estManager && jour && !jour.en_direct && jour.shifts_en_cours > 0 && (
        <p className="mt-8 rounded-xl bg-attente-tint px-4 py-3 text-sm font-semibold text-attente-txt">
          {jour.shifts_en_cours} shift{jour.shifts_en_cours > 1 ? 's' : ''} en cours : {jour.shifts_en_cours > 1 ? 'leurs ventes apparaîtront' : 'ses ventes apparaîtront'} ici à la clôture du caissier.
        </p>
      )}
      {estManager && (
        <section className="mt-8 grid gap-4 lg:grid-cols-3">
          <div className="carte p-4">
            <h2 className="mb-2 font-bold">{jour && !jour.en_direct ? 'Ventes des shifts clôturés' : 'Ventes du jour'}</h2>
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

interface TableEncaissee {
  id: string;
  numero_ticket: number;
  code_commande: string | null;
  type: TypeCommande;
  total: number;
  encaissee_le: string;
  table_numero: string | null;
  caissier: string;
}

const nomTable = (t: { table_numero: string | null; code_commande: string | null; numero_ticket: number }) =>
  t.table_numero ? `Table ${t.table_numero}` : t.code_commande ?? `Ticket n° ${t.numero_ticket}`;

/**
 * PROPRIÉTAIRE seulement (2026-10-26) : les tables payées du shift en cours,
 * consultables SANS passer en mode caissier. À la clôture, elles partent avec
 * le shift ; celles du shift suivant arrivent. Lecture seule : « Voir » ouvre
 * le ticket dans une fenêtre (l'écran de paiement exigerait un fond de
 * caisse). La réouverture d'une table payée garde sa règle (PIN manager).
 */
function TablesEncaissees() {
  const [aVoir, setAVoir] = useState<TableEncaissee | null>(null);
  const { data } = useQuery({
    queryKey: ['tables-encaissees'],
    queryFn: () => api<TableEncaissee[]>('/api/rapports/tables-encaissees'),
    refetchInterval: 30_000,
  });
  const lignes = data ?? [];
  return (
    <section className="mt-8">
      <h2 className="mb-2 text-lg font-bold">
        Tables encaissées <span className="text-sm font-normal text-doux">— visible du propriétaire seulement</span>
      </h2>
      {lignes.length === 0 && (
        <div className="carte p-4 text-center text-doux">Aucune table encaissée sur les shifts en cours.</div>
      )}
      <div className="space-y-2">
        {lignes.map((t) => (
          <div key={t.id} className="carte flex items-center justify-between gap-3 p-4 shadow-e1">
            <div className="min-w-0">
              <span className="font-bold">{nomTable(t)}</span>
              <span className="ml-3 text-sm text-doux">
                {LIBELLES_TYPES_COMMANDE[t.type]} — encaissée à{' '}
                {new Date(t.encaissee_le).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} · {t.caissier}
              </span>
            </div>
            <div className="flex flex-none items-center gap-2">
              <span className="mr-2 font-bold tabular-nums">{formatFCFA(t.total)}</span>
              <button type="button" className="btn-blanc" onClick={() => setAVoir(t)}>Voir</button>
            </div>
          </div>
        ))}
      </div>

      {aVoir && <TicketEncaisse table={aVoir} onFermer={() => setAVoir(null)} />}
    </section>
  );
}

/** Le ticket d'une table encaissée, en lecture seule. */
function TicketEncaisse({ table, onFermer }: { table: TableEncaissee; onFermer: () => void }) {
  const { data: c, isLoading } = useQuery({
    queryKey: ['commande', table.id],
    queryFn: () => api<CommandeVue>(`/api/commandes/${table.id}`),
  });
  return (
    <Modale
      titre={`${nomTable(table)} — ${table.caissier}`}
      onFermer={onFermer}
      enfants={
        isLoading || !c ? (
          <p className="text-doux">Chargement du ticket…</p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              {c.items.filter((i) => i.statut_cuisine !== 'ANNULE').map((i) => (
                <div key={i.id} className="flex justify-between gap-3">
                  <span>{i.quantite}× {i.nom_snapshot}</span>
                  <span className="font-semibold tabular-nums">{formatFCFA(i.total_ligne)}</span>
                </div>
              ))}
            </div>
            <div className="flex items-baseline justify-between border-t border-bordure pt-3">
              <span className="font-semibold">Total</span>
              <span className="text-xl font-extrabold tabular-nums">{formatFCFA(c.total)}</span>
            </div>
            <div className="space-y-1 rounded-xl bg-surface-douce p-3 text-sm">
              {c.paiements.map((p) => (
                <div key={p.id} className="flex justify-between">
                  <span>{LIBELLES_MODES[p.mode]}</span>
                  <span className="font-semibold tabular-nums">{formatFCFA(p.montant)}</span>
                </div>
              ))}
            </div>
          </div>
        )
      }
    />
  );
}
