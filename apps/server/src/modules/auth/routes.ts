import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import argon2 from 'argon2';
import { DeverrouillerSchema, LoginSchema, PoserPinSchema, TOUTES_PERMISSIONS, peutAccederCaisse } from '@pos/shared';
import type { SessionInfo } from '@pos/shared';
import { db } from '../../db/client.js';
import { parametresLocaux, restaurant, roles, servicesCaisse, utilisateurs } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { valider } from '../../lib/valider.js';
import { ErreurMetier } from '../../lib/erreurs.js';
import { effacerCookieSession, poserCookieSession, NOM_COOKIE, type SessionUtilisateur } from '../../plugins/sessions.js';
import { journaliser } from '../audit/audit.js';
import { permissionsDuRole } from '../roles/service.js';
import { verifierPinUtilisateur } from './pin.js';

async function construireSessionInfo(session: SessionUtilisateur): Promise<SessionInfo> {
  const [resto] = await db.select().from(restaurant).limit(1);
  if (!resto) throw new ErreurMetier('Le restaurant n’est pas encore configuré', 500);

  const params = await db.select().from(parametresLocaux);
  const lireParam = (cle: string, defaut: number): number => {
    const p = params.find((x) => x.cle === cle);
    return typeof p?.valeur === 'number' ? p.valeur : defaut;
  };
  const lireTexte = (cle: string): string => {
    const p = params.find((x) => x.cle === cle);
    return typeof p?.valeur === 'string' ? p.valeur : '';
  };

  const [service] = await db
    .select()
    .from(servicesCaisse)
    .where(and(eq(servicesCaisse.caissier_id, session.utilisateur_id), eq(servicesCaisse.statut, 'OUVERT')));

  // Permissions effectives (le propriétaire a tout, invariant 1.5)
  const perms = await permissionsEffectives(session.est_proprietaire, session.role_id);

  return {
    utilisateur: {
      id: session.utilisateur_id,
      nom_complet: session.nom_complet,
      role: session.role_nom,
      role_id: session.role_id,
      role_nom: session.role_nom,
      est_proprietaire: session.est_proprietaire,
      est_superviseur: session.est_superviseur,
    },
    permissions: perms,
    restaurant: {
      code: resto.code,
      nom: resto.nom,
      marque: resto.marque as 'SAMER' | 'AL_KAYAN',
      couleur_hex: resto.couleur_hex,
      entete: lireTexte('ticket_entete'),
      pied: lireTexte('ticket_pied'),
    },
    verrouillage_inactivite_secondes: lireParam('verrou_inactivite_caisse_secondes', 600),
    verrouillage_inactivite_serveur_secondes: lireParam('verrouillage_inactivite_serveur_secondes', 120),
    service_ouvert: service
      ? {
          id: service.id,
          fond_de_caisse: service.fond_de_caisse,
          ouvert_le: service.ouvert_le.toISOString(),
          statut: 'OUVERT',
        }
      : null,
  };
}

/** Permissions effectives d'un utilisateur (le propriétaire a tout, invariant 1.5). */
async function permissionsEffectives(estProprietaire: boolean, roleId: string | null): Promise<string[]> {
  return estProprietaire ? [...TOUTES_PERMISSIONS] : [...(await permissionsDuRole(roleId))];
}

/** Résout le rôle (nom, propriétaire/superviseur) d'un utilisateur. */
async function infoRole(roleId: string | null, fallbackEnum: string | null) {
  let nom = fallbackEnum ?? '';
  if (roleId) {
    const [r] = await db.select().from(roles).where(eq(roles.id, roleId));
    if (r) nom = r.nom;
  }
  return { role_id: roleId, role_nom: nom, est_proprietaire: nom === 'PROPRIETAIRE', est_superviseur: nom === 'SUPERVISEUR' };
}

export function routesAuth(app: FastifyInstance): void {
  // Liste des utilisateurs actifs pour l'écran de connexion (pas de PIN exposé)
  app.get('/api/auth/utilisateurs', async () => {
    const lignes = await db
      .select({
        id: utilisateurs.id,
        nom_complet: utilisateurs.nom_complet,
        role: utilisateurs.role,
        role_id: utilisateurs.role_id,
        role_nom: roles.nom,
        doit_definir_pin: utilisateurs.doit_definir_pin,
      })
      .from(utilisateurs)
      .leftJoin(roles, eq(roles.id, utilisateurs.role_id))
      .where(eq(utilisateurs.actif, true));

    // On n'affiche pas les comptes réservés à la cuisine (KDS) : ils ne se
    // connectent pas au POS caisse (même règle que le login, appliquée serveur).
    const avecAcces = await Promise.all(
      lignes.map(async (l) => ({
        ligne: l,
        acces: peutAccederCaisse(await permissionsEffectives(l.role_nom === 'PROPRIETAIRE', l.role_id)),
      })),
    );
    return avecAcces.filter((x) => x.acces).map((x) => x.ligne);
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { utilisateur_id, pin } = valider(LoginSchema, req.body);
    const u = await verifierPinUtilisateur(utilisateur_id, pin);
    const ir = await infoRole(u.role_id, u.role);

    // La cuisine ne se connecte pas au POS caisse (elle travaille sur le KDS).
    const perms = await permissionsEffectives(ir.est_proprietaire, ir.role_id);
    if (!peutAccederCaisse(perms)) {
      throw new ErreurMetier('Ce compte est réservé à la cuisine, il ne se connecte pas à la caisse', 403);
    }

    const session = app.sessions.creer({
      utilisateur_id: u.id,
      nom_complet: u.nom_complet,
      ...ir,
    });
    poserCookieSession(reply, session.id);

    await db.transaction(async (tx) => {
      await journaliser(tx, { user_id: u.id, action: 'CONNEXION', entite: 'utilisateurs', entite_id: u.id });
    });

    return construireSessionInfo(session);
  });

  // « Se déconnecter » : ferme la session, le service reste OUVERT (§ deux sorties)
  app.post('/api/auth/logout', { preHandler: app.exigerAuth }, async (req, reply) => {
    const userId = req.session!.utilisateur_id;
    app.sessions.detruire(req.cookies[NOM_COOKIE]);
    effacerCookieSession(reply);
    await db.transaction(async (tx) => {
      await journaliser(tx, { user_id: userId, action: 'DECONNEXION', entite: 'utilisateurs', entite_id: userId });
    });
    return { ok: true };
  });

  app.get('/api/auth/moi', { preHandler: app.exigerAuth }, async (req) => {
    return construireSessionInfo(req.session!);
  });

  // Déverrouillage après inactivité : re-saisie du PIN de l'utilisateur courant
  app.post('/api/auth/deverrouiller', { preHandler: app.exigerAuth }, async (req) => {
    const { pin } = valider(DeverrouillerSchema, req.body);
    await verifierPinUtilisateur(req.session!.utilisateur_id, pin);
    return { ok: true };
  });

  /**
   * Pose du PIN par l'employé lui-même (2.1) : code temporaire à usage unique
   * + PIN choisi deux fois. Aucune session requise (l'employé n'a pas encore de
   * PIN utilisable). Le code est consommé, le compte devient utilisable.
   */
  app.post('/api/auth/poser-pin', async (req) => {
    const corps = valider(PoserPinSchema, req.body);
    const [u] = await db
      .select()
      .from(utilisateurs)
      .where(and(eq(utilisateurs.id, corps.utilisateur_id), eq(utilisateurs.actif, true)));
    if (!u || !u.doit_definir_pin || !u.pin_temporaire_hash) {
      throw new ErreurMetier('Aucune définition de PIN en attente pour ce compte', 400);
    }
    if (u.pin_temporaire_expire && u.pin_temporaire_expire.getTime() < Date.now()) {
      throw new ErreurMetier('Le code temporaire a expiré — demandez-en un nouveau', 400);
    }
    if (!(await argon2.verify(u.pin_temporaire_hash, corps.code_temporaire))) {
      throw new ErreurMetier('Code temporaire incorrect', 403);
    }
    await db.transaction(async (tx) => {
      const [maj] = await tx
        .update(utilisateurs)
        .set({
          pin_hash: await argon2.hash(corps.pin, { type: argon2.argon2id }),
          doit_definir_pin: false,
          pin_temporaire_hash: null,
          pin_temporaire_expire: null,
          tentatives_pin: 0,
          verrou_jusqua: null,
          updated_at: new Date(),
        })
        .where(eq(utilisateurs.id, u.id))
        .returning();
      await ecrireOutbox(tx, 'utilisateurs', 'UPDATE', u.id, maj as unknown as Record<string, unknown>);
    });
    return { ok: true };
  });
}
