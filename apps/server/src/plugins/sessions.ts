import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@pos/shared';
import { ErreurMetier } from '../lib/erreurs.js';

export interface SessionUtilisateur {
  id: string;
  utilisateur_id: string;
  nom_complet: string;
  role: Role;
  expire_a: number;
}

const DUREE_SESSION_MS = 12 * 60 * 60 * 1000; // 12 h (le service peut durer la journée)
export const NOM_COOKIE = 'pos_session';

/**
 * Sessions serveur en mémoire, id opaque dans un cookie httpOnly (§14).
 * Un seul serveur local par restaurant : un store mémoire suffit en sprint 1.
 * Aucune donnée sensible côté navigateur autre que l'id de session.
 */
export class MagasinSessions {
  private sessions = new Map<string, SessionUtilisateur>();

  creer(u: { utilisateur_id: string; nom_complet: string; role: Role }): SessionUtilisateur {
    const session: SessionUtilisateur = {
      id: randomBytes(32).toString('hex'),
      ...u,
      expire_a: Date.now() + DUREE_SESSION_MS,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  lire(id: string | undefined): SessionUtilisateur | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.expire_a < Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    s.expire_a = Date.now() + DUREE_SESSION_MS; // TTL glissant
    return s;
  }

  detruire(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    sessions: MagasinSessions;
    exigerAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    exigerRole: (...roles: Role[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    session: SessionUtilisateur | null;
  }
}

export function enregistrerSessions(app: FastifyInstance): void {
  app.decorate('sessions', new MagasinSessions());
  app.decorateRequest('session', null);

  app.addHook('onRequest', async (req) => {
    req.session = app.sessions.lire(req.cookies[NOM_COOKIE]);
  });

  app.decorate('exigerAuth', async (req: FastifyRequest) => {
    if (!req.session) throw new ErreurMetier('Connectez-vous pour continuer', 401);
  });

  app.decorate('exigerRole', (...roles: Role[]) => {
    return async (req: FastifyRequest) => {
      if (!req.session) throw new ErreurMetier('Connectez-vous pour continuer', 401);
      if (!roles.includes(req.session.role)) {
        throw new ErreurMetier('Vous n’avez pas le droit d’effectuer cette action', 403);
      }
    };
  });
}

export function poserCookieSession(reply: FastifyReply, sessionId: string): void {
  reply.setCookie(NOM_COOKIE, sessionId, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // secure: false — réseau local sans TLS en sprint 1 (LAN du restaurant)
  });
}

export function effacerCookieSession(reply: FastifyReply): void {
  reply.clearCookie(NOM_COOKIE, { path: '/' });
}
