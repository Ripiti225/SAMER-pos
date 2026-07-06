/**
 * SPRINT 4B/4C — Partie 1 : fondation permissions & rôles.
 * Vérifie la migration (accès EXACTEMENT préservés), la résolution des
 * permissions par rôle, et les invariants de sécurité 1.5 :
 *  - le PROPRIETAIRE possède TOUJOURS toutes les permissions (anti-verrouillage),
 *    même si la table role_permissions est vidée pour son rôle ;
 *  - un guard par permission refuse (403) qui n'a pas le droit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { PERMISSIONS_DEFAUT, ROLES_SYSTEME, TOUTES_PERMISSIONS, type RoleSysteme } from '@pos/shared';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { rolePermissions, roles, utilisateurs } from '../src/db/schema/index.js';
import { invaliderCachePermissions, permissionsDuRole } from '../src/modules/roles/service.js';
import {
  PIN_CAISSIER,
  PIN_PROPRIO,
  PIN_SERVEUR,
  resetDonnees,
  seConnecter,
  type Donnees,
} from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('migration : 6 rôles système avec accès exactement préservés', () => {
  it('les 6 rôles système existent, marqués systeme=true', async () => {
    const lignes = await db.select().from(roles);
    for (const nom of ROLES_SYSTEME) {
      const r = lignes.find((x) => x.nom === nom);
      expect(r, `rôle ${nom}`).toBeTruthy();
      expect(r!.systeme).toBe(true);
      expect(r!.actif).toBe(true);
    }
  });

  it('chaque rôle système porte EXACTEMENT ses permissions par défaut', async () => {
    for (const nom of ROLES_SYSTEME) {
      const roleId = donnees.roles[nom]!;
      const set = await permissionsDuRole(roleId);
      const attendu = new Set(PERMISSIONS_DEFAUT[nom as RoleSysteme]);
      expect([...set].sort(), `permissions ${nom}`).toEqual([...attendu].sort());
    }
  });

  it('chaque employé de démo est raccordé au bon rôle', async () => {
    const [caissier] = await db.select().from(utilisateurs).where(eq(utilisateurs.id, donnees.caissier_id));
    expect(caissier!.role_id).toBe(donnees.roles.CAISSIER);
    const [serveur] = await db.select().from(utilisateurs).where(eq(utilisateurs.id, donnees.serveur_id));
    expect(serveur!.role_id).toBe(donnees.roles.SERVEUR);
  });
});

describe('résolution des permissions par rôle', () => {
  it('le CAISSIER garde la remise mais pas le tableau de bord', async () => {
    const set = await permissionsDuRole(donnees.roles.CAISSIER!);
    expect(set.has('caisse.remise')).toBe(true);
    expect(set.has('rapports.tableau_bord')).toBe(false);
  });

  it('le SERVEUR ne peut pas encaisser', async () => {
    const set = await permissionsDuRole(donnees.roles.SERVEUR!);
    expect(set.has('salle.commande')).toBe(true);
    expect(set.has('caisse.encaisser')).toBe(false);
  });

  it('SUPERVISEUR et PROPRIETAIRE possèdent toutes les permissions', async () => {
    for (const nom of ['SUPERVISEUR', 'PROPRIETAIRE'] as const) {
      const set = await permissionsDuRole(donnees.roles[nom]!);
      expect([...set].sort()).toEqual([...TOUTES_PERMISSIONS].sort());
    }
  });
});

describe('login : permissions effectives renvoyées', () => {
  it('le propriétaire reçoit TOUTES les permissions', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { utilisateur_id: donnees.proprio_id, pin: PIN_PROPRIO },
    });
    expect(rep.statusCode).toBe(200);
    const body = rep.json();
    expect(body.utilisateur.est_proprietaire).toBe(true);
    expect([...body.permissions].sort()).toEqual([...TOUTES_PERMISSIONS].sort());
  });

  it('le caissier ne reçoit pas les permissions manager', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { utilisateur_id: donnees.caissier_id, pin: PIN_CAISSIER },
    });
    const body = rep.json();
    expect(body.permissions).toContain('caisse.encaisser');
    expect(body.permissions).not.toContain('rapports.tableau_bord');
  });
});

describe('invariant 1.5 : guard par permission', () => {
  it('un CAISSIER reçoit 403 sur une route réservée (tableau de bord)', async () => {
    const cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
    const rep = await app.inject({ method: 'GET', url: '/api/rapports/tableau-bord', cookies });
    expect(rep.statusCode).toBe(403);
    expect(rep.json().erreur).not.toMatch(/\d{3}/); // message FR, pas de code technique
  });

  it('un SERVEUR reçoit 403 sur l’encaissement', async () => {
    const cookies = await seConnecter(app, donnees.serveur_id, PIN_SERVEUR);
    const rep = await app.inject({
      method: 'POST',
      url: '/api/services/ouvrir',
      cookies,
      payload: { fond_de_caisse: 25000 },
    });
    expect(rep.statusCode).toBe(403);
  });
});

describe('invariant 1.5 : anti-verrouillage du PROPRIETAIRE', () => {
  it('le propriétaire garde tous ses accès même si role_permissions est vidé', async () => {
    const cookies = await seConnecter(app, donnees.proprio_id, PIN_PROPRIO);
    // On vide DÉLIBÉRÉMENT les permissions du rôle PROPRIETAIRE en base.
    await db.delete(rolePermissions).where(eq(rolePermissions.role_id, donnees.roles.PROPRIETAIRE!));
    invaliderCachePermissions();

    // La résolution brute ne renvoie plus rien…
    const brut = await permissionsDuRole(donnees.roles.PROPRIETAIRE!);
    expect(brut.size).toBe(0);

    // …mais le guard laisse quand même passer le propriétaire (est_proprietaire).
    const rep = await app.inject({ method: 'GET', url: '/api/rapports/tableau-bord?periode=jour', cookies });
    expect(rep.statusCode).toBe(200);

    // On restaure l'état de référence pour ne pas polluer les autres attentes.
    const { etablirRolesSysteme } = await import('../src/modules/roles/service.js');
    await etablirRolesSysteme(db);
  });
});
