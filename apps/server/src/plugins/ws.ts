import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

declare module 'fastify' {
  interface FastifyInstance {
    diffuser: (type: 'commande' | 'service' | 'catalogue', id?: string) => void;
  }
}

/**
 * Temps réel LAN : pousse aux caisses un signal d'invalidation
 * (type + id) quand une commande/un service change.
 */
export async function enregistrerWs(app: FastifyInstance): Promise<void> {
  await app.register(websocket);

  const connexions = new Set<WebSocket>();

  app.decorate('diffuser', (type: 'commande' | 'service' | 'catalogue', id?: string) => {
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
