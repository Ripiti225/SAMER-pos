/**
 * SPRINT 4C — Équipe (2.1). Guard : permission `reglages.equipe`.
 * Le PIN n'est jamais saisi par l'encadrant : à la création / réinitialisation,
 * un code temporaire à usage unique est émis, l'employé pose son PIN ensuite
 * (route publique /api/auth/poser-pin). Jamais de suppression, seulement
 * désactivation. Invariant 1.3 appliqué côté serveur.
 */
import type { FastifyInstance } from 'fastify';
import { desc, eq, sql } from 'drizzle-orm';
import { CreerEmployeSchema, MajDisponibiliteSchema, ModifierEmployeSchema } from '@pos/shared';
import { db } from '../../db/client.js';
import { equipeService, roles, utilisateurs } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier, introuvable } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';
import type { SessionUtilisateur } from '../../plugins/sessions.js';
import {
  estRoleSensible,
  genererCodeTemporaire,
  hachInutilisable,
  hacher,
  nomDuRole,
} from './service.js';

const MSG_PROTEGE = 'Le compte propriétaire est protégé';
const CODE_VALIDE_JOURS = 7;

export function routesEquipe(app: FastifyInstance): void {
  const garde = app.exigePermission('reglages.equipe');

  /**
   * Vérifie qu'une opération sur un compte est permise (1.3). `cibleNom` = rôle
   * actuel du compte visé, `nouveauNom` = rôle qu'on veut lui donner.
   * Toute opération « sensible » exige une session PROPRIETAIRE.
   */
  async function exigerDroitCompte(
    session: SessionUtilisateur,
    cibleNom: string | null,
    nouveauNom: string | null,
    detail: string,
  ): Promise<void> {
    const sensible = estRoleSensible(cibleNom) || estRoleSensible(nouveauNom);
    if (sensible && !session.est_proprietaire) {
      await db.transaction(async (tx) => {
        await journaliser(tx, {
          user_id: session.utilisateur_id,
          action: 'ACCES_PROTEGE_REFUSE',
          entite: 'utilisateurs',
          meta: { detail, cibleNom, nouveauNom },
        });
      });
      throw new ErreurMetier(
        cibleNom === 'PROPRIETAIRE' || nouveauNom === 'PROPRIETAIRE'
          ? MSG_PROTEGE
          : 'Seul un propriétaire gère les comptes superviseur',
        403,
      );
    }
  }

  // Liste des employés (avec rôle, dernier pointage)
  app.get('/api/admin/equipe', { preHandler: garde }, async () => {
    const lignes = await db
      .select({
        id: utilisateurs.id,
        nom_complet: utilisateurs.nom_complet,
        role_id: utilisateurs.role_id,
        role_nom: roles.nom,
        poste_cuisine: utilisateurs.poste_cuisine,
        poste: utilisateurs.poste,
        photo_url: utilisateurs.photo_url,
        disponibilite: utilisateurs.disponibilite,
        telephone: utilisateurs.telephone,
        actif: utilisateurs.actif,
        doit_definir_pin: utilisateurs.doit_definir_pin,
      })
      .from(utilisateurs)
      .leftJoin(roles, eq(roles.id, utilisateurs.role_id))
      .orderBy(utilisateurs.nom_complet);

    // Dernière présence connue (équipe du jour) par employé
    const derniers = await db
      .select({ user_id: equipeService.utilisateur_id, dernier: sql<string>`MAX(${equipeService.created_at})` })
      .from(equipeService)
      .groupBy(equipeService.utilisateur_id);
    const parUser = new Map(derniers.map((d) => [d.user_id, d.dernier]));

    return lignes.map((l) => ({ ...l, derniere_presence: parUser.get(l.id) ?? null }));
  });

  // Créer un employé (le PIN est posé ensuite par l'employé)
  app.post('/api/admin/equipe', { preHandler: garde }, async (req) => {
    const corps = valider(CreerEmployeSchema, req.body);
    const nouveauNom = await nomDuRole(db, corps.role_id);
    if (!nouveauNom) throw new ErreurMetier('Rôle inconnu', 400);
    await exigerDroitCompte(req.session!, null, nouveauNom, `Création employé rôle ${nouveauNom}`);

    const code = genererCodeTemporaire();
    const expire = new Date(Date.now() + CODE_VALIDE_JOURS * 24 * 3600 * 1000);
    const cree = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(utilisateurs)
        .values({
          nom_complet: corps.nom_complet,
          role_id: corps.role_id,
          poste_cuisine: corps.poste_cuisine ?? null,
          telephone: corps.telephone ?? null,
          pin_hash: await hachInutilisable(),
          doit_definir_pin: true,
          pin_temporaire_hash: await hacher(code),
          pin_temporaire_expire: expire,
        })
        .returning();
      await ecrireOutbox(tx, 'utilisateurs', 'INSERT', u!.id, u as unknown as Record<string, unknown>);
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'CREATION_EMPLOYE',
        entite: 'utilisateurs',
        entite_id: u!.id,
        meta: { nom_complet: u!.nom_complet, role: nouveauNom },
      });
      return u!;
    });
    // Le code n'est montré QU'UNE FOIS à l'écran de l'encadrant.
    return { id: cree.id, code_temporaire: code, expire_le: expire.toISOString() };
  });

  // Modifier un employé (rôle, poste, téléphone)
  app.patch('/api/admin/equipe/:id', { preHandler: garde }, async (req) => {
    const { id } = req.params as { id: string };
    const corps = valider(ModifierEmployeSchema, req.body);
    const [cible] = await db.select().from(utilisateurs).where(eq(utilisateurs.id, id));
    if (!cible) throw introuvable('Employé');
    const cibleNom = await nomDuRole(db, cible.role_id);
    const nouveauNom = corps.role_id ? await nomDuRole(db, corps.role_id) : cibleNom;
    if (corps.role_id && !nouveauNom) throw new ErreurMetier('Rôle inconnu', 400);
    await exigerDroitCompte(req.session!, cibleNom, nouveauNom, `Modification employé ${id}`);

    const maj = await db.transaction(async (tx) => {
      const [u] = await tx
        .update(utilisateurs)
        .set({
          nom_complet: corps.nom_complet ?? cible.nom_complet,
          role_id: corps.role_id ?? cible.role_id,
          poste_cuisine: corps.poste_cuisine === undefined ? cible.poste_cuisine : corps.poste_cuisine,
          poste: corps.poste === undefined ? cible.poste : (corps.poste || null),
          photo_url: corps.photo_url === undefined ? cible.photo_url : (corps.photo_url || null),
          telephone: corps.telephone === undefined ? cible.telephone : corps.telephone,
          // Le changement de rôle système efface l'ancien enum (source = role_id).
          role: corps.role_id ? null : cible.role,
          updated_at: new Date(),
        })
        .where(eq(utilisateurs.id, id))
        .returning();
      await ecrireOutbox(tx, 'utilisateurs', 'UPDATE', id, u as unknown as Record<string, unknown>);
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_EMPLOYE',
        entite: 'utilisateurs',
        entite_id: id,
        meta: { avant: { role: cibleNom }, apres: { role: nouveauNom } },
      });
      return u!;
    });

    // Le rôle porté par ses sessions ouvertes suit immédiatement.
    if (corps.role_id && corps.role_id !== cible.role_id) {
      app.sessions.majRoleUtilisateur(id, {
        role_id: maj.role_id,
        role_nom: nouveauNom ?? '',
        est_proprietaire: nouveauNom === 'PROPRIETAIRE',
        est_superviseur: nouveauNom === 'SUPERVISEUR',
      });
      app.diffuser('permissions', id);
    }
    return { id, role_id: maj.role_id };
  });

  // Réinitialiser le PIN : nouveau code temporaire, sessions coupées
  app.post('/api/admin/equipe/:id/reinit-pin', { preHandler: garde }, async (req) => {
    const { id } = req.params as { id: string };
    const [cible] = await db.select().from(utilisateurs).where(eq(utilisateurs.id, id));
    if (!cible) throw introuvable('Employé');
    const cibleNom = await nomDuRole(db, cible.role_id);
    await exigerDroitCompte(req.session!, cibleNom, null, `Réinitialisation PIN employé ${id}`);

    const code = genererCodeTemporaire();
    const expire = new Date(Date.now() + CODE_VALIDE_JOURS * 24 * 3600 * 1000);
    await db.transaction(async (tx) => {
      const [u] = await tx
        .update(utilisateurs)
        .set({
          doit_definir_pin: true,
          pin_temporaire_hash: await hacher(code),
          pin_temporaire_expire: expire,
          tentatives_pin: 0,
          verrou_jusqua: null,
          updated_at: new Date(),
        })
        .where(eq(utilisateurs.id, id))
        .returning();
      await ecrireOutbox(tx, 'utilisateurs', 'UPDATE', id, u as unknown as Record<string, unknown>);
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'REINIT_PIN',
        entite: 'utilisateurs',
        entite_id: id,
        meta: { cible: cible.nom_complet },
      });
    });
    app.sessions.detruirePourUtilisateur(id); // il devra reposer son PIN
    return { code_temporaire: code, expire_le: expire.toISOString() };
  });

  // Disponibilité RH : présent / malade / congé / permission. Informatif — ne
  // coupe pas la session, ne touche pas au compte (pas d'opération sensible).
  app.post('/api/admin/equipe/:id/disponibilite', { preHandler: garde }, async (req) => {
    const { id } = req.params as { id: string };
    const corps = valider(MajDisponibiliteSchema, req.body);
    const [cible] = await db.select().from(utilisateurs).where(eq(utilisateurs.id, id));
    if (!cible) throw introuvable('Employé');

    await db.transaction(async (tx) => {
      const [u] = await tx
        .update(utilisateurs)
        .set({ disponibilite: corps.disponibilite, updated_at: new Date() })
        .where(eq(utilisateurs.id, id))
        .returning();
      await ecrireOutbox(tx, 'utilisateurs', 'UPDATE', id, u as unknown as Record<string, unknown>);
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_EMPLOYE',
        entite: 'utilisateurs',
        entite_id: id,
        meta: { cible: cible.nom_complet, disponibilite: corps.disponibilite },
      });
    });
    return { id, disponibilite: corps.disponibilite };
  });

  // Désactiver (départ) : immédiat, sessions coupées, jamais de suppression
  app.post('/api/admin/equipe/:id/desactiver', { preHandler: garde }, async (req) => {
    const { id } = req.params as { id: string };
    const [cible] = await db.select().from(utilisateurs).where(eq(utilisateurs.id, id));
    if (!cible) throw introuvable('Employé');
    const cibleNom = await nomDuRole(db, cible.role_id);
    await exigerDroitCompte(req.session!, cibleNom, null, `Désactivation employé ${id}`);

    // Anti-verrouillage : jamais désactiver le dernier propriétaire actif.
    if (cibleNom === 'PROPRIETAIRE') {
      const actifs = await db
        .select({ n: sql<string>`COUNT(*)` })
        .from(utilisateurs)
        .leftJoin(roles, eq(roles.id, utilisateurs.role_id))
        .where(sql`${roles.nom} = 'PROPRIETAIRE' AND ${utilisateurs.actif} = TRUE`);
      if (Number(actifs[0]?.n ?? 0) <= 1) {
        throw new ErreurMetier('Impossible de désactiver le dernier propriétaire', 409);
      }
    }

    await db.transaction(async (tx) => {
      const [u] = await tx
        .update(utilisateurs)
        .set({ actif: false, updated_at: new Date() })
        .where(eq(utilisateurs.id, id))
        .returning();
      await ecrireOutbox(tx, 'utilisateurs', 'UPDATE', id, u as unknown as Record<string, unknown>);
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'DESACTIVATION_EMPLOYE',
        entite: 'utilisateurs',
        entite_id: id,
        meta: { nom_complet: cible.nom_complet },
      });
    });
    app.sessions.detruirePourUtilisateur(id);
    return { ok: true };
  });
}
