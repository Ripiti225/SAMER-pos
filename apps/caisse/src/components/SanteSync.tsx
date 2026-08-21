import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconRefresh, IconWifi } from '@tabler/icons-react';
import { api } from '../api';
import { useCaisse } from '../stores/session';

interface EtatSante {
  voyant: { couleur: 'vert' | 'orange' | 'rouge'; message: string };
  lignes_en_attente: number;
  dernier_acquittement: string | null;
  derniere_erreur: string | null;
  derniere_reconciliation: { jour: string; statut: 'OK' | 'ECART'; ecart: number; quand: string } | null;
}

const COULEUR: Record<string, string> = {
  vert: 'bg-ok',
  orange: 'bg-[#D85A30]',
  rouge: 'bg-alerte',
};

function useSante() {
  const { session } = useCaisse();
  return useQuery({
    queryKey: ['sante-synchro'],
    queryFn: () => api<EtatSante>('/api/sante/synchro'),
    enabled: !!session,
    refetchInterval: 30_000,
  });
}

/** Pastille discrète (en-tête caisse) : vert / orange / rouge. */
export function PastilleSync() {
  const { data } = useSante();
  if (!data) return null;
  return (
    <span className="flex items-center gap-1.5" title={data.voyant.message}>
      <span className={`inline-block h-3 w-3 rounded-full ${COULEUR[data.voyant.couleur]}`} />
      {data.lignes_en_attente > 0 && (
        <span className="text-xs text-doux">{data.lignes_en_attente} en attente</span>
      )}
    </span>
  );
}

const PILULE: Record<string, string> = {
  vert: 'bg-ok-tint text-ok',
  orange: 'bg-marque-tint text-marque-fonce',
  rouge: 'bg-alerte-tint text-alerte',
};

/** Pastille « Synchronisé » cliquable : force une montée immédiate. */
export function PiluleSync() {
  const { data } = useSante();
  const queryClient = useQueryClient();
  const { afficherToast } = useCaisse();

  const forcer = useMutation({
    mutationFn: () => api<EtatSante & { synchro_active: boolean }>('/api/sante/synchro/forcer', { method: 'POST', corps: {} }),
    onSuccess: (frais) => {
      queryClient.setQueryData(['sante-synchro'], frais);
      if (!frais.synchro_active) {
        afficherToast('Synchronisation cloud non configurée sur ce poste');
      } else if (frais.lignes_en_attente === 0) {
        afficherToast('Tout est synchronisé');
      } else if (frais.derniere_erreur) {
        // Dire la cause. « Encore en attente » tout court laissait le
        // restaurateur appuyer en boucle sans savoir quoi faire (17/08).
        afficherToast(`${frais.lignes_en_attente} en attente — ${frais.derniere_erreur}`);
      } else {
        afficherToast(`${frais.lignes_en_attente} vente(s) encore en attente`);
      }
    },
    onError: (e: Error) => afficherToast(e.message),
  });

  const couleur = data?.voyant.couleur ?? 'vert';
  const libelle = forcer.isPending
    ? 'Envoi…'
    : couleur === 'vert'
      ? 'Synchronisé'
      : couleur === 'orange'
        ? `${data?.lignes_en_attente ?? 0} en attente`
        : 'Hors ligne';
  return (
    <button
      type="button"
      onClick={() => forcer.mutate()}
      disabled={forcer.isPending}
      className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition hover:brightness-95 ${PILULE[couleur]}`}
      title="Synchroniser maintenant"
    >
      {forcer.isPending ? <IconRefresh size={14} className="animate-spin" /> : <IconWifi size={14} />}
      {libelle}
    </button>
  );
}

/** Carte détaillée (page santé du manager). */
export function CarteSante() {
  const { data } = useSante();
  if (!data) return null;
  const heure = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('fr-FR') : '—');
  return (
    <div className="carte p-4">
      <h2 className="mb-2 flex items-center gap-2 font-bold">
        <span className={`inline-block h-3 w-3 rounded-full ${COULEUR[data.voyant.couleur]}`} />
        Internet / Synchro
      </h2>
      <p className="text-sm text-doux">{data.voyant.message}</p>
      <div className="mt-2 space-y-1 text-sm">
        <div className="flex justify-between">
          <span className="text-doux">Ventes en attente</span>
          <span className="font-semibold">{data.lignes_en_attente}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-doux">Dernier envoi acquitté</span>
          <span className="font-semibold">{heure(data.dernier_acquittement)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-doux">Dernière réconciliation</span>
          <span className="font-semibold">
            {data.derniere_reconciliation
              ? `${data.derniere_reconciliation.jour} — ${data.derniere_reconciliation.statut}${
                  data.derniere_reconciliation.ecart ? ` (écart ${data.derniere_reconciliation.ecart})` : ''
                }`
              : '—'}
          </span>
        </div>
        {data.derniere_erreur && data.voyant.couleur !== 'vert' && (
          <div className="text-xs text-alerte">{data.derniere_erreur}</div>
        )}
      </div>
    </div>
  );
}
