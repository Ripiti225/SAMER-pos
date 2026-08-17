import type { QueryClient } from '@tanstack/react-query';
import type { SessionInfo } from '@pos/shared';
import { api } from './api';
import { consommerEcho } from './echo-mutations';
import { sons } from './sons';
import { useCaisse } from './stores/session';

/** WebSocket LAN : invalide les requêtes quand le serveur pousse un changement. */
export function connecterTempsReel(queryClient: QueryClient): () => void {
  let socket: WebSocket | null = null;
  let arrete = false;

  const connecter = () => {
    if (arrete) return;
    const protocole = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${protocole}://${location.host}/ws`);
    socket.onmessage = (evt) => {
      try {
        const { type, id, quand } = JSON.parse(evt.data as string) as {
          type: string;
          id: string | null;
          quand: number;
        };
        // Correction 2 : la demande d'addition fait sonner la caisse (une fois)
        if (type === 'table:addition_demandee') {
          sons.additionDemandee(`${id}:${quand}`);
        }
        // Sprint 2 : événements nommés (commande:envoyee, commande_item:annule,
        // table:addition…) — on invalide par préfixe.
        if (type.startsWith('commande')) {
          // Écho de NOTRE propre mutation d'article : la réponse HTTP nous a
          // déjà livré la CommandeVue complète, issue de la même transaction.
          // Réinvalider ici écraserait la saisie en cours et provoquerait un
          // GET inutile. On ne saute que le type `commande` nu : le KDS émet
          // `commande:modifiee`/`commande:servie`, jamais neutralisés (voir
          // echo-mutations.ts pour le détail des garde-fous).
          const notreEcho = type === 'commande' && !!id && consommerEcho(id);
          if (id && !notreEcho) void queryClient.invalidateQueries({ queryKey: ['commande', id] });
          void queryClient.invalidateQueries({ queryKey: ['tables'] });
          void queryClient.invalidateQueries({ queryKey: ['mes-ventes'] });
        }
        if (type.startsWith('table')) void queryClient.invalidateQueries({ queryKey: ['tables'] });
        if (type === 'catalogue') {
          void queryClient.invalidateQueries({ queryKey: ['catalogue'] });
          void queryClient.invalidateQueries({ queryKey: ['admin', 'disponibilite'] });
        }
        // Sprint 4C : un rôle a changé → on rafraîchit les permissions en direct
        // (les sections retirées disparaissent sans reconnexion).
        if (type === 'permissions') {
          void api<SessionInfo>('/api/auth/moi')
            .then((s) => useCaisse.getState().majPermissions(s))
            .catch(() => {});
          void queryClient.invalidateQueries({ queryKey: ['admin'] });
        }
      } catch {
        /* message ignoré */
      }
    };
    socket.onclose = () => {
      if (!arrete) setTimeout(connecter, 2000);
    };
  };

  connecter();
  return () => {
    arrete = true;
    socket?.close();
  };
}
