import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

/**
 * Types d'événements poussés sur le LAN. Préfixes utilisés par les clients :
 * `commande*` (caisse, KDS, tablette), `table*` (plans de salle), `service`.
 * Événements nommés sprint 2 : commande:envoyee, commande_item:annule,
 * commande:modifiee, table:addition.
 */
export type EvenementWs =
  | 'commande'
  | 'commande:envoyee'
  | 'commande:modifiee'
  | 'commande_item:annule'
  | 'table:addition'
  | 'service'
  | 'catalogue';

declare module 'fastify' {
  interface FastifyInstance {
    diffuser: (type: EvenementWs, id?: string) => void;
  }
}

/**
 * Temps réel LAN : pousse aux terminaux un signal d'invalidation
 * (type + id) quand une commande/une table/un service change.
 */
export async function enregistrerWs(app: FastifyInstance): Promise<void> {
  await app.register(websocket);

  const connexions = new Set<WebSocket>();

  app.decorate('diffuser', (type: EvenementWs, id?: string) => {
    const message = JSON.stringify({ type, id: id ?? null, quand: Date.now() });
    for (const socket of connexions) {
      if (socket.readyState === socket.OPEN) socket.send(message);
    }
  });

  app.get('/ws', { websocket: true }, (socket) => {
    connexions.add(socket);
    socket.on('close', () => connexions.delete(socket));
  });
}
