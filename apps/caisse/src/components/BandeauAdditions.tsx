import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { TableVue } from '@pos/shared';
import { api } from '../api';
import { sons } from '../sons';
import { useCaisse } from '../stores/session';

/**
 * Correction 2 : notification visible et persistante des demandes d'addition.
 * Le bandeau liste chaque table en attente et reste affiché jusqu'à ce que le
 * caissier OUVRE la table. L'état vient de la base (statut ADDITION_DEMANDEE),
 * rafraîchi en temps réel par WebSocket : il survit à un rechargement.
 */
export function BandeauAdditions() {
  const { session, aller, tablesVues, marquerTableVue, reconcilierTablesVues } = useCaisse();
  const [muet, setMuet] = useState(sons.muet);

  const { data: tables } = useQuery({
    queryKey: ['tables'],
    queryFn: () => api<TableVue[]>('/api/tables'),
    enabled: !!session,
    refetchInterval: 20000,
  });

  const enAttente = (tables ?? []).filter((t) => t.statut === 'ADDITION_DEMANDEE');

  // Une table encaissée sort du registre « vues » pour la prochaine demande
  const clesEnAttente = enAttente.map((t) => t.id).join(',');
  useEffect(() => {
    if (tables) reconcilierTablesVues(clesEnAttente ? clesEnAttente.split(',') : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clesEnAttente]);

  const aAfficher = enAttente.filter((t) => !tablesVues.includes(t.id));
  if (aAfficher.length === 0) return null;

  return (
    <div className="fixed left-1/2 top-3 z-[55] w-full max-w-xl -translate-x-1/2 px-3">
      <div className="carte border-2 border-info bg-info-tint p-3 shadow-2xl">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold text-info">Addition demandée</span>
          <button
            type="button"
            className="btn-blanc ml-auto min-h-[36px] px-3 text-sm"
            onClick={() => {
              sons.basculerMute();
              setMuet(sons.muet);
            }}
          >
            {muet ? 'Son coupé (15 min max)' : 'Couper le son'}
          </button>
        </div>
        <div className="mt-2 space-y-2">
          {aAfficher.map((t) => (
            <div key={t.id} className="flex items-center gap-3">
              <span className="text-fort">
                Table <span className="font-black">{t.numero}</span> ({t.zone_nom}) demande l’addition
              </span>
              <button
                type="button"
                className="btn-accent ml-auto min-h-[40px] px-4"
                onClick={() => {
                  marquerTableVue(t.id);
                  if (t.commande_id) aller('paiement', t.commande_id);
                  else aller('tables');
                }}
              >
                Encaisser
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Compteur permanent pour l'accueil : nombre d'additions en attente. */
export function useNbAdditionsEnAttente(): number {
  const { session } = useCaisse();
  const { data: tables } = useQuery({
    queryKey: ['tables'],
    queryFn: () => api<TableVue[]>('/api/tables'),
    enabled: !!session,
    refetchInterval: 20000,
  });
  return (tables ?? []).filter((t) => t.statut === 'ADDITION_DEMANDEE').length;
}
