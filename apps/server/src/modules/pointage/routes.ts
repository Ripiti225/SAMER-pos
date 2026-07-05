/**
 * Pointage (§7) — 3 méthodes : PIN au POS (A1), géolocalisation (A2), SMS (A3).
 * Les 3 sont ouvertes sans session (l'employé pointe sans ouvrir de caisse).
 * Présences + correction sont réservées au manager.
 */
import { createHash, randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import {
  CorrectionPointageSchema,
  PointageGeolocSchema,
  PointagePinSchema,
  PointageSmsDemandeSchema,
  PointageSmsValiderSchema,
} from '@pos/shared';
import { db } from '../../db/client.js';
import { codesPointage, pointages, utilisateurs } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier, introuvable } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';
import { verifierPinManager, verifierPinUtilisateur } from '../auth/pin.js';
import { pointageOuvert, pointerBascule, verifierDansRayon } from './service.js';
import { smsService } from './sms.js';

function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

async function utilisateurParTelephone(telephone: string) {
  const [u] = await db
    .select()
    .from(utilisateurs)
    .where(and(eq(utilisateurs.telephone, telephone), eq(utilisateurs.actif, true)));
  return u ?? null;
}

export function routesPointage(app: FastifyInstance): void {
  // A1 — PIN au POS (fonctionne 100 % hors ligne)
  app.post('/api/pointage/pin', async (req) => {
    const corps = valider(PointagePinSchema, req.body);
    await verifierPinUtilisateur(corps.utilisateur_id, corps.pin);
    return pointerBascule(corps.utilisateur_id, 'PIN_POS');
  });

  // A2 — Géolocalisation (vérification de distance CÔTÉ SERVEUR)
  app.post('/api/pointage/geoloc', async (req) => {
    const corps = valider(PointageGeolocSchema, req.body);
    const u = await utilisateurParTelephone(corps.telephone);
    if (!u) throw introuvable('Employé');
    await verifierPinUtilisateur(u.id, corps.pin);
    await verifierDansRayon(corps.lat, corps.lng);
    return pointerBascule(u.id, 'GEOFENCING');
  });

  // A3 — SMS : demander un code (usage unique, expire 10 min)
  app.post('/api/pointage/sms/demander', async (req) => {
    const corps = valider(PointageSmsDemandeSchema, req.body);
    const u = await utilisateurParTelephone(corps.telephone);
    if (!u) throw introuvable('Employé');

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await db.insert(codesPointage).values({
      user_id: u.id,
      code_hash: sha256(code),
      expire_a: new Date(Date.now() + 10 * 60 * 1000),
    });
    await smsService.envoyer(u.telephone!, `Chez Samer — votre code de pointage : ${code} (valable 10 min)`);
    return { ok: true, message: 'Code envoyé par SMS' };
  });

  // A3 — SMS : valider le code (sur /pointage ou saisi au POS par le caissier)
  app.post('/api/pointage/sms/valider', async (req) => {
    const corps = valider(PointageSmsValiderSchema, req.body);
    const u = corps.utilisateur_id
      ? (await db.select().from(utilisateurs).where(eq(utilisateurs.id, corps.utilisateur_id)))[0]
      : corps.telephone
        ? await utilisateurParTelephone(corps.telephone)
        : null;
    if (!u) throw introuvable('Employé');

    const [code] = await db
      .select()
      .from(codesPointage)
      .where(and(eq(codesPointage.user_id, u.id), isNull(codesPointage.utilise_a)))
      .orderBy(desc(codesPointage.expire_a));
    if (!code || code.expire_a.getTime() < Date.now() || code.code_hash !== sha256(corps.code)) {
      throw new ErreurMetier('Code invalide ou expiré', 401);
    }
    await db.update(codesPointage).set({ utilise_a: new Date() }).where(eq(codesPointage.id, code.id));
    return pointerBascule(u.id, 'SMS_MDP');
  });

  // État de pointage d'un employé (pour l'écran : propose arrivée ou départ)
  app.get('/api/pointage/etat/:utilisateur_id', async (req) => {
    const { utilisateur_id } = req.params as { utilisateur_id: string };
    const ouvert = await pointageOuvert(db, utilisateur_id);
    return { en_poste: !!ouvert, depuis: ouvert?.arrivee.toISOString() ?? null };
  });

  // A4 — Présences du jour (manager)
  app.get('/api/pointage/presences', { preHandler: app.exigerRole('MANAGER', 'PROPRIETAIRE') }, async () => {
    const debut = new Date();
    debut.setHours(0, 0, 0, 0);
    const lignes = await db
      .select({
        id: pointages.id,
        user_id: pointages.user_id,
        nom: utilisateurs.nom_complet,
        role: utilisateurs.role,
        methode: pointages.methode,
        arrivee: pointages.arrivee,
        depart: pointages.depart,
        depart_oublie: pointages.depart_oublie,
      })
      .from(pointages)
      .innerJoin(utilisateurs, eq(utilisateurs.id, pointages.user_id))
      .where(gte(pointages.arrivee, debut))
      .orderBy(desc(pointages.arrivee));
    return lignes.map((l) => ({
      id: l.id,
      user_id: l.user_id,
      nom: l.nom,
      role: l.role,
      methode: l.methode,
      arrivee: l.arrivee.toISOString(),
      depart: l.depart?.toISOString() ?? null,
      depart_oublie: l.depart_oublie,
      en_poste: !l.depart,
    }));
  });

  // Correction d'un pointage : PIN manager + motif → audit CORRECTION_POINTAGE
  app.post('/api/pointage/:id/corriger', { preHandler: app.exigerRole('MANAGER', 'PROPRIETAIRE') }, async (req) => {
    const { id } = req.params as { id: string };
    const corps = valider(CorrectionPointageSchema, req.body);
    const manager = await verifierPinManager(corps.pin_manager, 'CORRECTION_POINTAGE');

    return db.transaction(async (tx) => {
      const [p] = await tx.select().from(pointages).where(eq(pointages.id, id));
      if (!p) throw introuvable('Pointage');
      const maj: Partial<typeof pointages.$inferInsert> = { depart_oublie: false };
      if (corps.arrivee) maj.arrivee = new Date(corps.arrivee);
      if (corps.depart !== undefined) maj.depart = corps.depart ? new Date(corps.depart) : null;
      const [modifie] = await tx.update(pointages).set(maj).where(eq(pointages.id, id)).returning();
      await ecrireOutbox(tx, 'pointages', 'UPDATE', id, modifie as unknown as Record<string, unknown>);
      await journaliser(tx, {
        user_id: manager.id,
        action: 'CORRECTION_POINTAGE',
        entite: 'pointages',
        entite_id: id,
        motif: corps.motif,
        meta: { avant: { arrivee: p.arrivee, depart: p.depart } },
      });
      return { ok: true };
    });
  });
}
