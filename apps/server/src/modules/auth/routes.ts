import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { DeverrouillerSchema, LoginSchema } from '@pos/shared';
import type { Role, SessionInfo } from '@pos/shared';
import { db } from '../../db/client.js';
import { parametresLocaux, restaurant, servicesCaisse, utilisateurs } from '../../db/schema/index.js';
import { valider } from '../../lib/valider.js';
import { ErreurMetier } from '../../lib/erreurs.js';
import { effacerCookieSession, poserCookieSession, NOM_COOKIE } from '../../plugins/sessions.js';
import { journaliser } from '../audit/audit.js';
import { verifierPinUtilisateur } from './pin.js';

async function construireSessionInfo(session: {
  utilisateur_id: string;
  nom_complet: string;
  role: Role;
}): Promise<SessionInfo> {
  const [resto] = await db.select().from(restaurant).limit(1);
  if (!resto) throw new ErreurMetier('Le restaurant n’est pas encore configuré', 500);

  const [param] = await db
    .select()
    .from(parametresLocaux)
    .where(eq(parametresLocaux.cle, 'verrouillage_inactivite_secondes'));

  const [service] = await db
    .select()
    .from(servicesCaisse)
    .where(and(eq(servicesCaisse.caissier_id, session.utilisateur_id), eq(servicesCaisse.statut, 'OUVERT')));

  return {
    utilisateur: { id: session.utilisateur_id, nom_complet: session.nom_complet, role: session.role },
    restaurant: {
      code: resto.code,
      nom: resto.nom,
      marque: resto.marque as 'SAMER' | 'AL_KAYAN',
      couleur_hex: resto.couleur_hex,
    },
    verrouillage_inactivite_secondes: typeof param?.valeur === 'number' ? param.valeur : 60,
    // Vue du service SANS especes_theorique (§14.3)
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

export function routesAuth(app: FastifyInstance): void {
  // Liste des utilisateurs actifs pour l'écran de connexion (pas de PIN exposé)
  app.get('/api/auth/utilisateurs', async () => {
    const lignes = await db
      .select({ id: utilisateurs.id, nom_complet: utilisateurs.nom_complet, role: utilisateurs.role })
      .from(utilisateurs)
      .where(eq(utilisateurs.actif, true));
    return lignes;
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { utilisateur_id, pin } = valider(LoginSchema, req.body);
    const u = await verifierPinUtilisateur(utilisateur_id, pin);

    const session = app.sessions.creer({
      utilisateur_id: u.id,
      nom_complet: u.nom_complet,
      role: u.role,
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
}
