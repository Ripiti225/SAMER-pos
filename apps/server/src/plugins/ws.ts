import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

/**
 * Types d'événements poussés sur le LAN. Préfixes utilisés par les clients :
 * `commande*` (caisse, KDS, tablette), `table*` (plans de salle), `service`,
 * `appel*` (appels client), `presence` (heartbeat serveurs).
 */
export type EvenementWs =
  | 'commande'
  | 'commande:envoyee'
  | 'commande:modifiee'
  | 'commande:prete'
  | 'commande:servie'
  | 'commande:client_a_valider'
  | 'commande_item:annule'
  | 'table:addition_demandee'
  | 'table:changee'
  | 'appel:nouveau'
  | 'service'
  | 'catalogue'
  | 'permissions';

/**
 * Présence des serveurs (point 1b) : un serveur est « présent » s'il a une
 * connexion WebSocket ouverte avec un battement de cœur reçu dans les
 * 2 dernières minutes. Déconnexion volontaire (socket fermée) ou tablette
 * hors ligne > 2 min = déconnecté.
 */
const FENETRE_PRESENCE_MS = 2 * 60 * 1000;

interface Connexion {
  socket: WebSocket;
  utilisateur_id: string | null;
  role: string | null;
  dernier_battement: number;
}

export class Presence {
  private connexions = new Set<Connexion>();

  ajouter(c: Connexion): void {
    this.connexions.add(c);
  }

  retirer(c: Connexion): void {
    this.connexions.delete(c);
  }

  battement(c: Connexion): void {
    c.dernier_battement = Date.now();
  }

  /** Un utilisateur est présent s'il a une connexion vivante (heartbeat récent). */
  estPresent(utilisateurId: string): boolean {
    const limite = Date.now() - FENETRE_PRESENCE_MS;
    for (const c of this.connexions) {
      if (
        c.utilisateur_id === utilisateurId &&
        c.socket.readyState === c.socket.OPEN &&
        c.dernier_battement >= limite
      ) {
        return true;
      }
    }
    return false;
  }

  /** Ids des serveurs actuellement connectés (présents). */
  serveursConnectes(): Set<string> {
    const limite = Date.now() - FENETRE_PRESENCE_MS;
    const ids = new Set<string>();
    for (const c of this.connexions) {
      if (
        c.role === 'SERVEUR' &&
        c.utilisateur_id &&
        c.socket.readyState === c.socket.OPEN &&
        c.dernier_battement >= limite
      ) {
        ids.add(c.utilisateur_id);
      }
    }
    return ids;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    diffuser: (type: EvenementWs, id?: string) => void;
    /** Diffuse un événement avec une charge utile (routage ciblé côté client). */
    diffuserPayload: (type: EvenementWs, payload: Record<string, unknown>) => void;
    presence: Presence;
  }
}

export async function enregistrerWs(app: FastifyInstance): Promise<void> {
  await app.register(websocket);

  const connexions = new Set<WebSocket>();
  const presence = new Presence();
  app.decorate('presence', presence);

  const envoyer = (message: string) => {
    for (const socket of connexions) {
      if (socket.readyState === socket.OPEN) socket.send(message);
    }
  };

  app.decorate('diffuser', (type: EvenementWs, id?: string) => {
    envoyer(JSON.stringify({ type, id: id ?? null, quand: Date.now() }));
  });
  app.decorate('diffuserPayload', (type: EvenementWs, payload: Record<string, unknown>) => {
    envoyer(JSON.stringify({ type, quand: Date.now(), ...payload }));
  });

  app.get('/ws', { websocket: true }, (socket, req) => {
    connexions.add(socket);
    const conn: Connexion = {
      socket,
      utilisateur_id: req.session?.utilisateur_id ?? null,
      role: req.session?.role_nom ?? null,
      dernier_battement: Date.now(),
    };
    presence.ajouter(conn);

    socket.on('message', () => presence.battement(conn));
    socket.on('close', () => {
      connexions.delete(socket);
      presence.retirer(conn);
    });
  });
}
