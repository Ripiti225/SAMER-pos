/**
 * Pointage par téléphone (décidé le 2026-11-19).
 *
 * La page `/pointage.html` est servie par le mini-PC : elle ne s'ouvre que
 * sur le wifi du restaurant, ce qui prouve la présence sur place. Chaque
 * pointage demande le PIN de l'employé et un selfie, et passe par le MÊME
 * journal que la pointeuse : le premier pointage gagne, l'autre est refusé.
 *
 * Routes publiques (pas de session caisse : un employé ne doit RIEN pouvoir
 * faire d'autre depuis son téléphone) :
 *   GET  /api/pointage-tel/etat       restaurant + compte rattaché à ce téléphone
 *   GET  /api/pointage-tel/comptes    comptes à choisir (téléphone pas encore rattaché)
 *   POST /api/pointage-tel/identifier PIN → rattachement + présence du jour
 *   POST /api/pointage-tel/pointer    PIN + selfie → arrivée ou départ
 * Routes du gérant (session caisse) : demandes de changement, selfies, réglage.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import { PinSaisiSchema } from '@pos/shared';
import { db } from '../../db/client.js';
import {
  appareilsPointage,
  equipeService,
  parametresLocaux,
  photosPointage,
  pointeuseEvenements,
  restaurant,
  utilisateurs,
} from '../../db/schema/index.js';
import { ErreurMetier, introuvable } from '../../lib/erreurs.js';
import QRCode from 'qrcode';
import { adresseReseauLocale } from '../../lib/reseau.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';
import { verifierPinManager, verifierPinUtilisateur } from '../auth/pin.js';
import { appliquerEvenement, CLE_TELEPHONE_ACTIF, PREFIXE_TELEPHONE, telephoneActif } from '../pointeuse/presence.js';
import {
  appareilDuCompte,
  compteDeLAppareil,
  COOKIE_APPAREIL,
  DUREE_COOKIE_S,
  libelleNavigateur,
  MESSAGE_AUTRE_TELEPHONE,
  rattacherAppareil,
} from './appareil.js';
import { estJpegValide, jpegDepuisDataUrl, TAILLE_MAX_SELFIE } from './photo.js';
import { etatPresence, heureLisible, libelleSource, type EtatPresence } from './presence.js';

/** Selfies gardés 60 jours : assez pour une contestation de paie du mois. */
const CONSERVATION_PHOTOS_MS = 60 * 24 * 3600_000;
/** Base64 du selfie (+33 %) et marge pour le reste du corps. */
const LIMITE_CORPS_OCTETS = Math.ceil(TAILLE_MAX_SELFIE * 1.4) + 4096;

const IdentifierSchema = z.object({
  utilisateur_id: z.string().uuid('Compte invalide'),
  pin: PinSaisiSchema,
});

const PointerSchema = IdentifierSchema.extend({
  sens: z.enum(['ENTREE', 'SORTIE'], { errorMap: () => ({ message: 'Arrivée ou départ ?' }) }),
  photo: z.string({ required_error: 'Le selfie est obligatoire' }).min(1, 'Le selfie est obligatoire'),
});

const DecisionSchema = z.object({ pin_manager: PinSaisiSchema });
const ReglageSchema = z.object({ actif: z.boolean({ invalid_type_error: 'Activé ou non ?' }) });

function cleDuCookie(req: FastifyRequest): string | null {
  const v = req.cookies[COOKIE_APPAREIL];
  return typeof v === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(v) ? v : null;
}

function poserCleAppareil(reply: FastifyReply, cle: string): void {
  reply.setCookie(COOKIE_APPAREIL, cle, {
    path: '/api/pointage-tel',
    httpOnly: true,
    sameSite: 'strict',
    maxAge: DUREE_COOKIE_S,
  });
}

function vuePresence(p: EtatPresence) {
  return {
    service_ouvert: p.service_ouvert,
    arrivee: p.arrivee?.toISOString() ?? null,
    depart: p.depart?.toISOString() ?? null,
    source: p.source,
    en_attente: p.en_attente,
    action: p.action,
  };
}

async function exigerActif(): Promise<void> {
  if (!(await telephoneActif())) {
    throw new ErreurMetier('Le pointage par téléphone n’est pas activé dans ce restaurant. Pointez à la pointeuse ou à la caisse.', 403);
  }
}

/** Le geste demandé est-il encore possible ? Sinon, message clair (premier pointage gagne). */
function verifierGeste(sens: 'ENTREE' | 'SORTIE', p: EtatPresence): void {
  const ou = (d: Date) => `${heureLisible(d)}${p.source ? ` (${libelleSource(p.source)})` : ''}`;
  if (sens === 'ENTREE') {
    if (p.depart) throw new ErreurMetier(`Votre départ est déjà pointé à ${heureLisible(p.depart)}. À demain !`, 409);
    if (p.arrivee) throw new ErreurMetier(`Votre arrivée est déjà pointée à ${ou(p.arrivee)}.`, 409);
    return;
  }
  if (!p.arrivee) throw new ErreurMetier('Pointez d’abord votre arrivée.', 409);
  if (p.depart) throw new ErreurMetier(`Votre départ est déjà pointé à ${ou(p.depart)}.`, 409);
  if (!p.service_ouvert) {
    throw new ErreurMetier('Le shift n’est pas encore ouvert à la caisse : votre départ ne peut pas encore être pointé.', 409);
  }
}

export function routesPointageTelephone(app: FastifyInstance): void {
  const gardeGerant = app.exigePermission('pointage.gerer');
  const gardeReglages = app.exigePermission('reglages.parametres');

  // ── Téléphone de l'employé ──────────────────────────────────────────────

  app.get('/api/pointage-tel/etat', async (req) => {
    const [resto] = await db.select().from(restaurant).limit(1);
    const appareil = await compteDeLAppareil(db, cleDuCookie(req));
    const [compte] = appareil
      ? await db
          .select({ id: utilisateurs.id, nom_complet: utilisateurs.nom_complet, photo_url: utilisateurs.photo_url, doit_definir_pin: utilisateurs.doit_definir_pin })
          .from(utilisateurs)
          .where(and(eq(utilisateurs.id, appareil.utilisateur_id), eq(utilisateurs.actif, true)))
      : [];
    return {
      actif: await telephoneActif(),
      restaurant: resto ? { nom: resto.nom, marque: resto.marque, couleur_hex: resto.couleur_hex } : null,
      compte: compte ?? null,
    };
  });

  app.get('/api/pointage-tel/comptes', async (req) => {
    await exigerActif();
    // Téléphone déjà rattaché : pas de liste, il ne sert qu'à son compte.
    if (await compteDeLAppareil(db, cleDuCookie(req))) return [];
    return db
      .select({ id: utilisateurs.id, nom_complet: utilisateurs.nom_complet, photo_url: utilisateurs.photo_url, doit_definir_pin: utilisateurs.doit_definir_pin })
      .from(utilisateurs)
      .where(eq(utilisateurs.actif, true))
      .orderBy(asc(utilisateurs.nom_complet));
  });

  app.post('/api/pointage-tel/identifier', async (req, reply) => {
    await exigerActif();
    const corps = valider(IdentifierSchema, req.body);
    const u = await verifierPinUtilisateur(corps.utilisateur_id, corps.pin);

    const resultat = await db.transaction((tx) =>
      rattacherAppareil(tx, u.id, cleDuCookie(req), libelleNavigateur(req.headers['user-agent'])));
    // Refus APRÈS la transaction : la tentative reste dans l'audit.
    if (resultat.statut === 'REFUSE') throw new ErreurMetier(resultat.message, 409);
    if (resultat.cleAPoser) poserCleAppareil(reply, resultat.cleAPoser);
    if (resultat.statut === 'EN_ATTENTE') throw new ErreurMetier(MESSAGE_AUTRE_TELEPHONE, 409);

    return {
      compte: { id: u.id, nom_complet: u.nom_complet, photo_url: u.photo_url },
      presence: vuePresence(await etatPresence(db, u.id)),
    };
  });

  app.post('/api/pointage-tel/pointer', { bodyLimit: LIMITE_CORPS_OCTETS }, async (req) => {
    await exigerActif();
    const corps = valider(PointerSchema, req.body);
    const u = await verifierPinUtilisateur(corps.utilisateur_id, corps.pin);
    const appareil = await appareilDuCompte(db, u.id, cleDuCookie(req));
    if (!appareil) {
      throw new ErreurMetier('Ce téléphone n’est pas celui de votre compte. Reconnectez-vous avec votre PIN.', 403);
    }
    const jpeg = jpegDepuisDataUrl(corps.photo);
    if (!jpeg || !estJpegValide(jpeg)) {
      throw new ErreurMetier('Le selfie n’a pas pu être lu. Reprenez la photo.', 400);
    }

    const maintenant = new Date();
    const nomAppareil = `${PREFIXE_TELEPHONE}${appareil.id}`;
    const resultat = await db.transaction(async (tx) => {
      verifierGeste(corps.sens, await etatPresence(tx, u.id));
      const numero = maintenant.getTime();
      const statut = await appliquerEvenement(
        tx,
        nomAppareil,
        { numero, employe_no: u.pointeuse_no ?? 'TELEPHONE', nom: u.nom_complet, sens: corps.sens, pointe_le: maintenant },
        { utilisateurId: u.id },
      );
      if (statut !== 'APPLIQUE' && statut !== 'EN_ATTENTE') {
        throw new ErreurMetier('Ce pointage est déjà enregistré.', 409);
      }
      await tx.insert(photosPointage).values({ appareil: nomAppareil, numero, jpeg });
      await tx.delete(photosPointage).where(lt(photosPointage.cree_le, new Date(maintenant.getTime() - CONSERVATION_PHOTOS_MS)));
      await journaliser(tx, {
        user_id: u.id,
        action: 'POINTAGE_TELEPHONE',
        entite: 'pointeuse_evenements',
        meta: { sens: corps.sens, statut, appareil: appareil.id, libelle: appareil.libelle },
      });
      return { statut, presence: await etatPresence(tx, u.id) };
    });
    app.diffuser('pointage');

    const heure = heureLisible(maintenant);
    const message = corps.sens === 'SORTIE'
      ? `Départ pointé à ${heure}. Bonne fin de journée !`
      : resultat.statut === 'EN_ATTENTE'
        ? `Arrivée pointée à ${heure}. Elle sera reprise à l’ouverture du shift.`
        : `Arrivée pointée à ${heure}. Bon service !`;
    return { statut: resultat.statut, heure: maintenant.toISOString(), message, presence: vuePresence(resultat.presence) };
  });

  // ── Gérant, sur la caisse ───────────────────────────────────────────────

  /** Changements de téléphone en attente (le 1er téléphone se rattache seul). */
  app.get('/api/pointage-tel/demandes', { preHandler: gardeGerant }, async () => {
    const demandes = await db
      .select({
        id: appareilsPointage.id,
        utilisateur_id: appareilsPointage.utilisateur_id,
        nom_complet: utilisateurs.nom_complet,
        libelle: appareilsPointage.libelle,
        cree_le: appareilsPointage.cree_le,
      })
      .from(appareilsPointage)
      .innerJoin(utilisateurs, eq(utilisateurs.id, appareilsPointage.utilisateur_id))
      .where(eq(appareilsPointage.statut, 'EN_ATTENTE'))
      .orderBy(asc(appareilsPointage.cree_le));
    return demandes.map((d) => ({ ...d, cree_le: d.cree_le.toISOString() }));
  });

  app.post('/api/pointage-tel/demandes/:id/accepter', { preHandler: gardeGerant }, async (req) => {
    const { id } = req.params as { id: string };
    const { pin_manager } = valider(DecisionSchema, req.body);
    const manager = await verifierPinManager(pin_manager, 'APPAREIL_POINTAGE');
    await db.transaction(async (tx) => {
      const [demande] = await tx
        .select()
        .from(appareilsPointage)
        .where(and(eq(appareilsPointage.id, id), eq(appareilsPointage.statut, 'EN_ATTENTE')));
      if (!demande) throw introuvable('Demande');
      // Entre-temps, ce téléphone a pu servir à un autre compte : on refuse.
      const [prisAilleurs] = await tx
        .select({ id: appareilsPointage.id })
        .from(appareilsPointage)
        .where(and(eq(appareilsPointage.cle_hash, demande.cle_hash), eq(appareilsPointage.statut, 'ACTIF')));
      if (prisAilleurs) throw new ErreurMetier('Ce téléphone est déjà rattaché à un autre compte : refusez la demande.', 409);
      const maintenant = new Date();
      await tx
        .update(appareilsPointage)
        .set({ statut: 'REMPLACE', decide_par: manager.id, decide_le: maintenant })
        .where(and(eq(appareilsPointage.utilisateur_id, demande.utilisateur_id), eq(appareilsPointage.statut, 'ACTIF')));
      await tx
        .update(appareilsPointage)
        .set({ statut: 'ACTIF', decide_par: manager.id, decide_le: maintenant })
        .where(eq(appareilsPointage.id, demande.id));
      await journaliser(tx, {
        user_id: manager.id,
        action: 'APPAREIL_CHANGEMENT_ACCEPTE',
        entite: 'appareils_pointage',
        entite_id: demande.id,
        meta: { agent_id: demande.utilisateur_id, libelle: demande.libelle },
      });
    });
    return { ok: true };
  });

  app.post('/api/pointage-tel/demandes/:id/refuser', { preHandler: gardeGerant }, async (req) => {
    const { id } = req.params as { id: string };
    const { pin_manager } = valider(DecisionSchema, req.body);
    const manager = await verifierPinManager(pin_manager, 'APPAREIL_POINTAGE');
    await db.transaction(async (tx) => {
      const [demande] = await tx
        .update(appareilsPointage)
        .set({ statut: 'REFUSE', decide_par: manager.id, decide_le: new Date() })
        .where(and(eq(appareilsPointage.id, id), eq(appareilsPointage.statut, 'EN_ATTENTE')))
        .returning();
      if (!demande) throw introuvable('Demande');
      await journaliser(tx, {
        user_id: manager.id,
        action: 'APPAREIL_CHANGEMENT_REFUSE',
        entite: 'appareils_pointage',
        entite_id: demande.id,
        meta: { agent_id: demande.utilisateur_id, libelle: demande.libelle },
      });
    });
    return { ok: true };
  });

  /** Selfie d'une arrivée ou d'un départ pointé au téléphone (fiche du bandeau). */
  app.get('/api/pointage-tel/selfie/:equipeId/:sens', { preHandler: gardeGerant }, async (req, reply) => {
    const { equipeId, sens } = req.params as { equipeId: string; sens: string };
    if (sens !== 'ENTREE' && sens !== 'SORTIE') throw introuvable('Selfie');
    const [membre] = await db.select().from(equipeService).where(eq(equipeService.id, equipeId));
    if (!membre) throw introuvable('Selfie');
    const [photo] = await db
      .select({ jpeg: photosPointage.jpeg })
      .from(pointeuseEvenements)
      .innerJoin(photosPointage, and(
        eq(photosPointage.appareil, pointeuseEvenements.appareil),
        eq(photosPointage.numero, pointeuseEvenements.numero),
      ))
      .where(and(
        eq(pointeuseEvenements.service_id, membre.service_id),
        eq(pointeuseEvenements.utilisateur_id, membre.utilisateur_id),
        eq(pointeuseEvenements.sens, sens),
        eq(pointeuseEvenements.statut, 'APPLIQUE'),
      ))
      .orderBy(desc(pointeuseEvenements.pointe_le))
      .limit(1);
    if (!photo) throw introuvable('Selfie');
    return reply.header('Cache-Control', 'private, max-age=3600').type('image/jpeg').send(photo.jpeg);
  });

  // ── Réglages › Pointage par téléphone ───────────────────────────────────

  app.get('/api/admin/pointage-telephone', { preHandler: gardeReglages }, async () => {
    const ip = adresseReseauLocale();
    const port = Number(process.env.PORT ?? 3001);
    const rattaches = await db
      .select({
        utilisateur_id: appareilsPointage.utilisateur_id,
        nom_complet: utilisateurs.nom_complet,
        libelle: appareilsPointage.libelle,
        cree_le: appareilsPointage.cree_le,
      })
      .from(appareilsPointage)
      .innerJoin(utilisateurs, eq(utilisateurs.id, appareilsPointage.utilisateur_id))
      .where(eq(appareilsPointage.statut, 'ACTIF'))
      .orderBy(asc(utilisateurs.nom_complet));
    const url = ip ? `http://${ip}:${port}/pointage.html` : null;
    return {
      actif: await telephoneActif(),
      url,
      // À afficher près de la pointeuse / en salle de pause : on le scanne connecté au wifi.
      qr: url ? await QRCode.toDataURL(url, { margin: 1, width: 320 }) : null,
      telephones: rattaches.map((r) => ({ ...r, cree_le: r.cree_le.toISOString() })),
    };
  });

  app.put('/api/admin/pointage-telephone', { preHandler: gardeReglages }, async (req) => {
    const { actif } = valider(ReglageSchema, req.body);
    await db.transaction(async (tx) => {
      await tx
        .insert(parametresLocaux)
        .values({ cle: CLE_TELEPHONE_ACTIF, valeur: actif as never })
        .onConflictDoUpdate({ target: parametresLocaux.cle, set: { valeur: actif as never, updated_at: new Date() } });
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'REGLAGE_POINTAGE_TELEPHONE',
        entite: 'parametres_locaux',
        meta: { actif },
      });
    });
    return { actif };
  });
}
