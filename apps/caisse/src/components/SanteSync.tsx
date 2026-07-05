import { useQuery } from '@tanstack/react-query';
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
