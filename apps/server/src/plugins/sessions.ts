import { randomBytes } from 'node:crypto';
import { eq, gt, lt } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../db/client.js';
import { sessions as tableSessions } from '../db/schema/index.js';
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

// Intervalle minimal entre deux écritures de l'expiration glissante en base
// (le TTL glisse à chaque requête, mais on ne persiste pas à chaque fois).
const THROTTLE_PERSIST_MS = 10 * 60 * 1000;

/** Écritures DB « best-effort » : une panne base ne bloque jamais une vente. */
function bestEffort(p: Promise<unknown>): void {
  void p.catch(() => undefined);
}

/**
 * Magasin de sessions : cache mémoire (accès synchrone) ADOSSÉ à la base.
 * Les sessions sont persistées et rechargées au démarrage (`charger`) → un
 * redémarrage du serveur/mini-PC ne déconnecte plus personne. Les écritures
 * base sont best-effort (jamais bloquantes pour une vente).
 */
export class MagasinSessions {
  private sessions = new Map<string, SessionUtilisateur>();
  private prochainePersist = new Map<string, number>();

  /** Recharge les sessions non expirées depuis la base (au démarrage). */
  async charger(): Promise<void> {
    bestEffort(db.delete(tableSessions).where(lt(tableSessions.expire_a, new Date())));
    const lignes = await db.select().from(tableSessions).where(gt(tableSessions.expire_a, new Date()));
    for (const l of lignes) {
      this.sessions.set(l.id, {
        id: l.id,
        utilisateur_id: l.utilisateur_id,
        nom_complet: l.nom_complet,
        role_id: l.role_id,
        role_nom: l.role_nom,
        est_proprietaire: l.est_proprietaire,
        est_superviseur: l.est_superviseur,
        expire_a: l.expire_a.getTime(),
      });
    }
  }

  creer(u: Omit<SessionUtilisateur, 'id' | 'expire_a'>): SessionUtilisateur {
    const session: SessionUtilisateur = {
      id: randomBytes(32).toString('hex'),
      ...u,
      expire_a: Date.now() + DUREE_SESSION_MS,
    };
    this.sessions.set(session.id, session);
    this.prochainePersist.set(session.id, Date.now() + THROTTLE_PERSIST_MS);
    bestEffort(
      db.insert(tableSessions).values({
        id: session.id,
        utilisateur_id: session.utilisateur_id,
        nom_complet: session.nom_complet,
        role_id: session.role_id,
        role_nom: session.role_nom,
        est_proprietaire: session.est_proprietaire,
        est_superviseur: session.est_superviseur,
        expire_a: new Date(session.expire_a),
      }),
    );
    return session;
  }

  lire(id: string | undefined): SessionUtilisateur | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.expire_a < Date.now()) {
      this.detruire(id);
      return null;
    }
    s.expire_a = Date.now() + DUREE_SESSION_MS; // TTL glissant
    // Persistance throttlée de l'expiration (pas à chaque requête).
    const quand = this.prochainePersist.get(id) ?? 0;
    if (Date.now() > quand) {
      this.prochainePersist.set(id, Date.now() + THROTTLE_PERSIST_MS);
      bestEffort(
        db.update(tableSessions).set({ expire_a: new Date(s.expire_a) }).where(eq(tableSessions.id, id)),
      );
    }
    return s;
  }

  detruire(id: string | undefined): void {
    if (!id) return;
    this.sessions.delete(id);
    this.prochainePersist.delete(id);
    bestEffort(db.delete(tableSessions).where(eq(tableSessions.id, id)));
  }

  /** Coupe toutes les sessions d'un utilisateur (désactivation, réinit PIN). */
  detruirePourUtilisateur(utilisateurId: string): void {
    for (const [id, s] of this.sessions) {
      if (s.utilisateur_id === utilisateurId) {
        this.sessions.delete(id);
        this.prochainePersist.delete(id);
      }
    }
    bestEffort(db.delete(tableSessions).where(eq(tableSessions.utilisateur_id, utilisateurId)));
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
    bestEffort(
      db
        .update(tableSessions)
        .set({ role_id: r.role_id, role_nom: r.role_nom, est_proprietaire: r.est_proprietaire, est_superviseur: r.est_superviseur })
        .where(eq(tableSessions.utilisateur_id, utilisateurId)),
    );
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
    // Cookie PERSISTANT (pas seulement « de session ») : survit à la fermeture
    // de l'onglet, à la mise en veille et au rechargement, sur toute la durée
    // de vie de la session serveur. Évite les reconnexions intempestives.
    maxAge: DUREE_SESSION_MS / 1000,
  });
}

export function effacerCookieSession(reply: FastifyReply): void {
  reply.clearCookie(NOM_COOKIE, { path: '/' });
}
