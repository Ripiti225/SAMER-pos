import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ErreurMetier } from '../lib/erreurs.js';
import { permissionsDuRole } from '../modules/roles/service.js';

export interface SessionUtilisateur {
  id: string;
  utilisateur_id: string;
  nom_complet: string;
  role_id: string | null;
  role_nom: string;
  est_proprietaire: boolean;
  est_superviseur: boolean;
  expire_a: number;
}

const DUREE_SESSION_MS = 12 * 60 * 60 * 1000; // 12 h (le service peut durer la journée)
export const NOM_COOKIE = 'pos_session';

export class MagasinSessions {
  private sessions = new Map<string, SessionUtilisateur>();

  creer(u: Omit<SessionUtilisateur, 'id' | 'expire_a'>): SessionUtilisateur {
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

  /** Coupe toutes les sessions d'un utilisateur (désactivation, réinit PIN). */
  detruirePourUtilisateur(utilisateurId: string): void {
    for (const [id, s] of this.sessions) {
      if (s.utilisateur_id === utilisateurId) this.sessions.delete(id);
    }
  }

  /**
   * Met à jour le rôle porté par les sessions ouvertes d'un utilisateur
   * (changement de rôle par un encadrant) : ses permissions suivent sans
   * reconnexion — les permissions sont résolues en direct depuis role_id.
   */
  majRoleUtilisateur(
    utilisateurId: string,
    r: Pick<SessionUtilisateur, 'role_id' | 'role_nom' | 'est_proprietaire' | 'est_superviseur'>,
  ): void {
    for (const s of this.sessions.values()) {
      if (s.utilisateur_id === utilisateurId) {
        s.role_id = r.role_id;
        s.role_nom = r.role_nom;
        s.est_proprietaire = r.est_proprietaire;
        s.est_superviseur = r.est_superviseur;
      }
    }
  }
}

/**
 * Le PROPRIETAIRE a TOUJOURS toutes les permissions (invariant anti-verrouillage
 * 1.5) : même si role_permissions était vide, il passe.
 */
export async function aPermission(session: SessionUtilisateur, cle: string): Promise<boolean> {
  if (session.est_proprietaire) return true;
  const perms = await permissionsDuRole(session.role_id);
  return perms.has(cle);
}

declare module 'fastify' {
  interface FastifyInstance {
    sessions: MagasinSessions;
    exigerAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Guard : la route exige la permission `cle` (403 sinon). */
    exigePermission: (cle: string) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
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

  app.decorate('exigePermission', (cle: string) => {
    return async (req: FastifyRequest) => {
      if (!req.session) throw new ErreurMetier('Connectez-vous pour continuer', 401);
      if (!(await aPermission(req.session, cle))) {
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
  });
}

export function effacerCookieSession(reply: FastifyReply): void {
  reply.clearCookie(NOM_COOKIE, { path: '/' });
}
