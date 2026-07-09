/**
 * SPRINT 4C — Écran « Rôles & accès » (2.8).
 * Guard : permission PROTÉGÉE `roles.gerer` (SUPERVISEUR / PROPRIETAIRE).
 * Invariants 1.3/1.4 appliqués CÔTÉ SERVEUR :
 *  - les rôles PROPRIETAIRE et SUPERVISEUR sont verrouillés (403 + audit) ;
 *  - la permission `roles.gerer` ne peut jamais être posée ailleurs.
 * Chaque changement : audit + outbox + diffusion WebSocket « permissions »
 * (mise à jour temps réel des employés connectés).
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  CreerRoleSchema,
  DupliquerRoleSchema,
  ModifierRoleSchema,
  ROLES_VERROUILLES,
  filtrerPermissionsRole,
} from '@pos/shared';
import { db } from '../../db/client.js';
import { roles } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier, introuvable } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';
import {
  compterEmploiParRole,
  invaliderCachePermissions,
  permissionsDuRole,
  remplacerPermissionsRole,
} from './service.js';

const MSG_PROTEGE = 'Le compte propriétaire est protégé';

/** Trace un refus lié à un rôle verrouillé ou à la permission protégée. */
async function auditRefus(userId: string, roleId: string | null, detail: string): Promise<void> {
  await db.transaction(async (tx) => {
    await journaliser(tx, {
      user_id: userId,
      action: 'ACCES_PROTEGE_REFUSE',
      entite: 'roles',
      entite_id: roleId,
      meta: { detail },
    });
  });
}

export function routesRoles(app: FastifyInstance): void {
  const garde = app.exigePermission('roles.gerer');

  // Liste des rôles + nombre d'employés (2.8)
  app.get('/api/admin/roles', { preHandler: garde }, async () => {
    const lignes = await db.select().from(roles).orderBy(roles.systeme, roles.nom);
    const compte = await compterEmploiParRole(db, lignes.map((r) => r.id));
    const resultat = [];
    for (const r of lignes) {
      const perms = await permissionsDuRole(r.id);
      resultat.push({
        id: r.id,
        nom: r.nom,
        systeme: r.systeme,
        actif: r.actif,
        verrouille: ROLES_VERROUILLES.includes(r.nom),
        permissions: [...perms].sort(),
        nb_employes: compte.get(r.id) ?? 0,
      });
    }
    return resultat;
  });

  // Créer un rôle personnalisé
  app.post('/api/admin/roles', { preHandler: garde }, async (req) => {
    const corps = valider(CreerRoleSchema, req.body);
    const { permissions, protegeeDemandee } = filtrerPermissionsRole(corps.permissions);
    if (protegeeDemandee) {
      await auditRefus(req.session!.utilisateur_id, null, `roles.gerer refusé à la création de « ${corps.nom} »`);
      throw new ErreurMetier('La permission « Rôles & accès » ne peut pas être attribuée à ce rôle', 403);
    }
    const [existant] = await db.select().from(roles).where(eq(roles.nom, corps.nom));
    if (existant) throw new ErreurMetier('Un rôle porte déjà ce nom', 409);

    const cree = await db.transaction(async (tx) => {
      const [r] = await tx.insert(roles).values({ nom: corps.nom, systeme: false, actif: true }).returning();
      await ecrireOutbox(tx, 'roles', 'INSERT', r!.id, r as unknown as Record<string, unknown>);
      await remplacerPermissionsRole(tx, r!.id, permissions);
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'CREATION_ROLE',
        entite: 'roles',
        entite_id: r!.id,
        meta: { nom: r!.nom, permissions },
      });
      return r!;
    });
    invaliderCachePermissions();
    app.diffuser('permissions', cree.id);
    return { id: cree.id, nom: cree.nom, actif: true, permissions };
  });

  // Modifier un rôle (permissions + nom éventuel)
  app.patch('/api/admin/roles/:id', { preHandler: garde }, async (req) => {
    const { id } = req.params as { id: string };
    const corps = valider(ModifierRoleSchema, req.body);
    const [role] = await db.select().from(roles).where(eq(roles.id, id));
    if (!role) throw introuvable('Rôle');

    if (ROLES_VERROUILLES.includes(role.nom)) {
      await auditRefus(req.session!.utilisateur_id, id, `Tentative de modification du rôle verrouillé ${role.nom}`);
      throw new ErreurMetier(MSG_PROTEGE, 403);
    }
    const { permissions, protegeeDemandee } = filtrerPermissionsRole(corps.permissions);
    if (protegeeDemandee) {
      await auditRefus(req.session!.utilisateur_id, id, `roles.gerer refusé sur ${role.nom}`);
      throw new ErreurMetier('La permission « Rôles & accès » ne peut pas être attribuée à ce rôle', 403);
    }

    const avant = [...(await permissionsDuRole(id))].sort();
    await db.transaction(async (tx) => {
      if (corps.nom && corps.nom !== role.nom) {
        const [homonyme] = await tx.select().from(roles).where(eq(roles.nom, corps.nom));
        if (homonyme) throw new ErreurMetier('Un rôle porte déjà ce nom', 409);
        const [maj] = await tx.update(roles).set({ nom: corps.nom, updated_at: new Date() }).where(eq(roles.id, id)).returning();
        await ecrireOutbox(tx, 'roles', 'UPDATE', id, maj as unknown as Record<string, unknown>);
      }
      await remplacerPermissionsRole(tx, id, permissions);
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_ROLE',
        entite: 'roles',
        entite_id: id,
        meta: { nom: corps.nom ?? role.nom, avant, apres: [...permissions].sort() },
      });
    });
    invaliderCachePermissions();
    app.diffuser('permissions', id);
    return { id, permissions: [...permissions].sort() };
  });

  // Dupliquer un rôle existant
  app.post('/api/admin/roles/:id/dupliquer', { preHandler: garde }, async (req) => {
    const { id } = req.params as { id: string };
    const corps = valider(DupliquerRoleSchema, req.body);
    const [source] = await db.select().from(roles).where(eq(roles.id, id));
    if (!source) throw introuvable('Rôle');
    const [homonyme] = await db.select().from(roles).where(eq(roles.nom, corps.nom));
    if (homonyme) throw new ErreurMetier('Un rôle porte déjà ce nom', 409);

    // La copie ne conserve jamais la permission protégée (1.4).
    const { permissions } = filtrerPermissionsRole([...(await permissionsDuRole(id))]);
    const cree = await db.transaction(async (tx) => {
      const [r] = await tx.insert(roles).values({ nom: corps.nom, systeme: false, actif: true }).returning();
      await ecrireOutbox(tx, 'roles', 'INSERT', r!.id, r as unknown as Record<string, unknown>);
      await remplacerPermissionsRole(tx, r!.id, permissions);
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'CREATION_ROLE',
        entite: 'roles',
        entite_id: r!.id,
        meta: { nom: r!.nom, duplique_de: source.nom, permissions },
      });
      return r!;
    });
    invaliderCachePermissions();
    app.diffuser('permissions', cree.id);
    return { id: cree.id, nom: cree.nom, permissions };
  });

  // Désactiver un rôle (jamais de suppression ; réaffecter d'abord)
  app.post('/api/admin/roles/:id/desactiver', { preHandler: garde }, async (req) => {
    const { id } = req.params as { id: string };
    const [role] = await db.select().from(roles).where(eq(roles.id, id));
    if (!role) throw introuvable('Rôle');
    if (ROLES_VERROUILLES.includes(role.nom)) {
      await auditRefus(req.session!.utilisateur_id, id, `Tentative de désactivation du rôle verrouillé ${role.nom}`);
      throw new ErreurMetier(MSG_PROTEGE, 403);
    }
    const compte = await compterEmploiParRole(db, [id]);
    if ((compte.get(id) ?? 0) > 0) {
      throw new ErreurMetier('Ce rôle est encore attribué à des employés — réaffectez-les d’abord', 409);
    }
    await db.transaction(async (tx) => {
      const [maj] = await tx.update(roles).set({ actif: false, updated_at: new Date() }).where(eq(roles.id, id)).returning();
      await ecrireOutbox(tx, 'roles', 'UPDATE', id, maj as unknown as Record<string, unknown>);
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'DESACTIVATION_ROLE',
        entite: 'roles',
        entite_id: id,
        meta: { nom: role.nom },
      });
    });
    invaliderCachePermissions();
    app.diffuser('permissions', id);
    return { ok: true };
  });
}
