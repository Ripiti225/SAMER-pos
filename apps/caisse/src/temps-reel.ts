import type { QueryClient } from '@tanstack/react-query';

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
        const { type, id } = JSON.parse(evt.data as string) as { type: string; id: string | null };
        if (type === 'commande') {
          if (id) void queryClient.invalidateQueries({ queryKey: ['commande', id] });
          void queryClient.invalidateQueries({ queryKey: ['commandes-ouvertes'] });
          void queryClient.invalidateQueries({ queryKey: ['tables'] });
          void queryClient.invalidateQueries({ queryKey: ['mes-ventes'] });
        }
        if (type === 'catalogue') void queryClient.invalidateQueries({ queryKey: ['catalogue'] });
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
