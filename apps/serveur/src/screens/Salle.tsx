import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { TableVue } from '@pos/shared';
import { api, PlanSalle } from '@pos/shared-ui';

/** Plan de salle (§B1) : composant commun avec la caisse, sans tables partenaires. */
export function Salle({
  onTable,
  moiServeurId,
  afficherToast,
}: {
  onTable: (tableId: string) => void;
  moiServeurId: string;
  afficherToast: (m: string) => void;
}) {
  const queryClient = useQueryClient();
  const { data: tables } = useQuery({
    queryKey: ['tables'],
    queryFn: () => api<TableVue[]>('/api/tables'),
    refetchInterval: 10000,
  });

  // Statuts de table en temps réel
  useEffect(() => {
    let socket: WebSocket | null = null;
    let arrete = false;
    const connecter = () => {
      if (arrete) return;
      const protocole = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocole}://${location.host}/ws`);
      socket.onmessage = (evt) => {
        try {
          const { type } = JSON.parse(evt.data as string) as { type: string };
          if (type.startsWith('commande') || type.startsWith('table')) {
            void queryClient.invalidateQueries({ queryKey: ['tables'] });
          }
        } catch { /* ignoré */ }
      };
      socket.onclose = () => {
        if (!arrete) setTimeout(connecter, 2000);
      };
    };
    connecter();
    return () => { arrete = true; socket?.close(); };
  }, [queryClient]);

  return (
    <div className="marge-sure-cotes marge-sure-bas h-full overflow-y-auto p-3 sm:p-4">
      <PlanSalle
        tables={tables ?? []}
        onTable={(t) => onTable(t.id)}
        masquerPartenaires
        moiServeurId={moiServeurId}
        onBloque={(t) => afficherToast(`Table de ${(t.ouverte_par_nom ?? 'un autre serveur').split(' ')[0]} — accès réservé`)}
      />
    </div>
  );
}
