/**
 * SPRINT 4C — Écran « Rôles & accès » (2.8) + invariants 1.3/1.4.
 * Couvre la DdT : 403 caissier, temps réel (perte de section + 403), rôle
 * personnalisé « Caissier senior », protection du rôle PROPRIETAIRE, verrou de
 * la permission « Rôles & accès ».
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { auditLog, utilisateurs } from '../src/db/schema/index.js';
import {
  PIN_CAISSIER,
  PIN_MANAGER,
  PIN_PROPRIO,
  resetDonnees,
  seConnecter,
  type Donnees,
} from './aide.js';

const PIN_SUPERVISEUR = '731942';

let app: FastifyInstance;
let donnees: Donnees;
let superviseurId: string;
let cookiesProprio: Record<string, string>;
let cookiesSuper: Record<string, string>;
let cookiesManager: Record<string, string>;
let cookiesCaissier: Record<string, string>;
let serviceId: string;

beforeAll(async () => {
  donnees = await resetDonnees();
  const [sup] = await db
    .insert(utilisateurs)
    .values({
      nom_complet: 'Super Viseur',
      role: null,
      role_id: donnees.roles.SUPERVISEUR,
      pin_hash: await argon2.hash(PIN_SUPERVISEUR, { type: argon2.argon2id }),
      telephone: '+2250700000099',
    })
    .returning();
  superviseurId = sup!.id;

  app = await construireApp();
  cookiesProprio = await seConnecter(app, donnees.proprio_id, PIN_PROPRIO);
  cookiesSuper = await seConnecter(app, superviseurId, PIN_SUPERVISEUR);
  cookiesManager = await seConnecter(app, donnees.manager_id, PIN_MANAGER);
  cookiesCaissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  const s = await app.inject({ method: 'POST', url: '/api/services/ouvrir', cookies: cookiesCaissier, payload: { fond_de_caisse: 25000 } });
  serviceId = s.json().id as string;
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('accès à l’écran Rôles & accès (permission protégée)', () => {
  it('un CAISSIER reçoit 403 sur /api/admin/roles', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/admin/roles', cookies: cookiesCaissier });
    expect(rep.statusCode).toBe(403);
  });
  it('un MANAGER reçoit 403 (roles.gerer réservé Superviseur/Propriétaire)', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/admin/roles', cookies: cookiesManager });
    expect(rep.statusCode).toBe(403);
  });
  it('le SUPERVISEUR liste les rôles avec le nombre d’employés', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/admin/roles', cookies: cookiesSuper });
    expect(rep.statusCode).toBe(200);
    const roles = rep.json() as Array<{ nom: string; nb_employes: number; verrouille: boolean }>;
    const caissier = roles.find((r) => r.nom === 'CAISSIER');
    expect(caissier!.nb_employes).toBe(2); // deux caissiers dans les fixtures
    expect(roles.find((r) => r.nom === 'PROPRIETAIRE')!.verrouille).toBe(true);
  });
});

describe('temps réel : retirer Rapport X au MANAGER (DdT 6)', () => {
  it('avant : le manager accède au rapport X', async () => {
    const rep = await app.inject({ method: 'GET', url: `/api/services/${serviceId}/rapport-x`, cookies: cookiesManager });
    expect(rep.statusCode).toBe(200);
  });

  it('le superviseur décoche rapports.x et rapports.z du rôle MANAGER', async () => {
    const roleManager = donnees.roles.MANAGER!;
    const rep = await app.inject({
      method: 'PATCH',
      url: `/api/admin/roles/${roleManager}`,
      cookies: cookiesSuper,
      payload: {
        // Manager sans les rapports X/Z (on garde le reste tel quel, simplifié)
        permissions: ['caisse.encaisser', 'salle.commande', 'reglages.equipe'],
      },
    });
    expect(rep.statusCode).toBe(200);
  });

  it('après (sans reconnexion) : le manager reçoit 403 sur le rapport X', async () => {
    const rep = await app.inject({ method: 'GET', url: `/api/services/${serviceId}/rapport-x`, cookies: cookiesManager });
    expect(rep.statusCode).toBe(403);
  });

  it('la session du manager ne liste plus rapports.x dans ses permissions', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/auth/moi', cookies: cookiesManager });
    expect(rep.json().permissions).not.toContain('rapports.x');
  });

  it('trace MODIF_ROLE avec avant/après', async () => {
    const traces = await db.select().from(auditLog).where(eq(auditLog.action, 'MODIF_ROLE'));
    expect(traces.length).toBeGreaterThanOrEqual(1);
    const meta = traces.at(-1)!.meta as { avant: string[]; apres: string[] };
    expect(meta.avant).toContain('rapports.x');
    expect(meta.apres).not.toContain('rapports.x');
  });
});

describe('rôle personnalisé « Caissier senior » (DdT 7)', () => {
  it('création d’un rôle sans remise → 403 sur la route remise', async () => {
    const creation = await app.inject({
      method: 'POST',
      url: '/api/admin/roles',
      cookies: cookiesSuper,
      payload: { nom: 'Caissier junior', permissions: ['caisse.encaisser', 'salle.commande'] },
    });
    expect(creation.statusCode).toBe(200);
    const roleJunior = creation.json().id as string;

    // Un employé avec ce rôle
    const [junior] = await db
      .insert(utilisateurs)
      .values({ nom_complet: 'Junior Test', role: null, role_id: roleJunior, pin_hash: await argon2.hash('246813', { type: argon2.argon2id }) })
      .returning();
    const cookiesJunior = await seConnecter(app, junior!.id, '246813');
    const c = await app.inject({ method: 'POST', url: '/api/commandes', cookies: cookiesJunior, payload: { type: 'EMPORTER' } });
    const cmdId = c.json().id as string;
    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${cmdId}/remise`,
      cookies: cookiesJunior,
      payload: { montant: 500, motif: 'Test', pin_manager: PIN_MANAGER },
    });
    expect(rep.statusCode).toBe(403); // pas la permission caisse.remise
  });

  it('création d’un « Caissier senior » AVEC remise → la route remise n’est plus bloquée par la permission', async () => {
    const creation = await app.inject({
      method: 'POST',
      url: '/api/admin/roles',
      cookies: cookiesSuper,
      payload: { nom: 'Caissier senior', permissions: ['caisse.encaisser', 'salle.commande', 'caisse.remise'] },
    });
    expect(creation.statusCode).toBe(200);
    const roleSenior = creation.json().id as string;
    const [senior] = await db
      .insert(utilisateurs)
      .values({ nom_complet: 'Senior Test', role: null, role_id: roleSenior, pin_hash: await argon2.hash('369147', { type: argon2.argon2id }) })
      .returning();
    const cookiesSenior = await seConnecter(app, senior!.id, '369147');
    const c = await app.inject({ method: 'POST', url: '/api/commandes', cookies: cookiesSenior, payload: { type: 'EMPORTER' } });
    const cmdId = c.json().id as string;
    // Remise sans motif → 400 (invariant : motif obligatoire), PAS 403 → la permission passe
    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${cmdId}/remise`,
      cookies: cookiesSenior,
      payload: { montant: 500, pin_manager: PIN_MANAGER },
    });
    expect(rep.statusCode).toBe(400);
  });
});

describe('protection du rôle PROPRIETAIRE et permission « Rôles & accès » (DdT 8, 9)', () => {
  it('modifier le rôle PROPRIETAIRE → 403 « Le compte propriétaire est protégé » + audit', async () => {
    const rep = await app.inject({
      method: 'PATCH',
      url: `/api/admin/roles/${donnees.roles.PROPRIETAIRE}`,
      cookies: cookiesSuper,
      payload: { permissions: ['caisse.encaisser'] },
    });
    expect(rep.statusCode).toBe(403);
    expect(rep.json().erreur).toBe('Le compte propriétaire est protégé');
    const traces = await db.select().from(auditLog).where(eq(auditLog.action, 'ACCES_PROTEGE_REFUSE'));
    expect(traces.length).toBeGreaterThanOrEqual(1);
  });

  it('cocher « Rôles & accès » sur un rôle personnalisé → 403 (verrou serveur)', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: '/api/admin/roles',
      cookies: cookiesSuper,
      payload: { nom: 'Faux admin', permissions: ['caisse.encaisser', 'roles.gerer'] },
    });
    expect(rep.statusCode).toBe(403);
  });

  it('même le PROPRIETAIRE ne peut pas modifier le rôle SUPERVISEUR (verrouillé)', async () => {
    const rep = await app.inject({
      method: 'PATCH',
      url: `/api/admin/roles/${donnees.roles.SUPERVISEUR}`,
      cookies: cookiesProprio,
      payload: { permissions: ['caisse.encaisser'] },
    });
    expect(rep.statusCode).toBe(403);
  });
});
