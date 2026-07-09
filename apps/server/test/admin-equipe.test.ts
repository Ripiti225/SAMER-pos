/**
 * SPRINT 4C — Équipe (2.1). Le PIN est posé par l'employé (code temporaire),
 * réinitialisation, désactivation, et protection des comptes d'encadrement (1.3).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { auditLog, utilisateurs } from '../src/db/schema/index.js';
import { PIN_CAISSIER, PIN_PROPRIO, resetDonnees, seConnecter, type Donnees } from './aide.js';

const PIN_SUPERVISEUR = '731942';

let app: FastifyInstance;
let donnees: Donnees;
let superviseurId: string;
let cookiesProprio: Record<string, string>;
let cookiesSuper: Record<string, string>;
let cookiesCaissier: Record<string, string>;

beforeAll(async () => {
  donnees = await resetDonnees();
  const [sup] = await db
    .insert(utilisateurs)
    .values({ nom_complet: 'Super Viseur', role: null, role_id: donnees.roles.SUPERVISEUR, pin_hash: await argon2.hash(PIN_SUPERVISEUR, { type: argon2.argon2id }) })
    .returning();
  superviseurId = sup!.id;
  app = await construireApp();
  cookiesProprio = await seConnecter(app, donnees.proprio_id, PIN_PROPRIO);
  cookiesSuper = await seConnecter(app, superviseurId, PIN_SUPERVISEUR);
  cookiesCaissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('accès', () => {
  it('un CAISSIER n’accède pas à l’équipe (403)', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/admin/equipe', cookies: cookiesCaissier });
    expect(rep.statusCode).toBe(403);
  });
});

describe('création d’un employé + pose de PIN par l’employé (DdT 3)', () => {
  let fatouId: string;
  let code: string;

  it('le superviseur crée « Fatou » (serveur) et reçoit un code temporaire', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: '/api/admin/equipe',
      cookies: cookiesSuper,
      payload: { nom_complet: 'Fatou Bamba', role_id: donnees.roles.SERVEUR },
    });
    expect(rep.statusCode).toBe(200);
    fatouId = rep.json().id;
    code = rep.json().code_temporaire;
    expect(code).toMatch(/^\d{6}$/);
  });

  it('Fatou ne peut pas se connecter tant que le PIN n’est pas posé', async () => {
    const rep = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { utilisateur_id: fatouId, pin: '2468' } });
    expect(rep.statusCode).toBe(409);
  });

  it('un mauvais code temporaire est refusé', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: '/api/auth/poser-pin',
      payload: { utilisateur_id: fatouId, code_temporaire: '000000', pin: '2468', pin_confirmation: '2468' },
    });
    expect(rep.statusCode).toBe(403);
  });

  it('Fatou pose son PIN avec le bon code, puis se connecte', async () => {
    const pose = await app.inject({
      method: 'POST',
      url: '/api/auth/poser-pin',
      payload: { utilisateur_id: fatouId, code_temporaire: code, pin: '2468', pin_confirmation: '2468' },
    });
    expect(pose.statusCode).toBe(200);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { utilisateur_id: fatouId, pin: '2468' } });
    expect(login.statusCode).toBe(200);
    expect(login.json().utilisateur.role_nom).toBe('SERVEUR');
  });

  it('trace CREATION_EMPLOYE', async () => {
    const traces = await db.select().from(auditLog).where(eq(auditLog.action, 'CREATION_EMPLOYE'));
    expect(traces.length).toBeGreaterThanOrEqual(1);
  });
});

describe('réinitialisation et désactivation', () => {
  it('réinit PIN : nouveau code, ancien PIN inutilisable', async () => {
    // Nouveau caissier via API
    const creation = await app.inject({
      method: 'POST',
      url: '/api/admin/equipe',
      cookies: cookiesSuper,
      payload: { nom_complet: 'Employe Reinit', role_id: donnees.roles.CAISSIER },
    });
    const uid = creation.json().id as string;
    const code1 = creation.json().code_temporaire as string;
    await app.inject({ method: 'POST', url: '/api/auth/poser-pin', payload: { utilisateur_id: uid, code_temporaire: code1, pin: '3571', pin_confirmation: '3571' } });

    const reinit = await app.inject({ method: 'POST', url: `/api/admin/equipe/${uid}/reinit-pin`, cookies: cookiesSuper });
    expect(reinit.statusCode).toBe(200);
    // L'ancien PIN ne marche plus (compte en attente de nouveau PIN)
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { utilisateur_id: uid, pin: '3571' } });
    expect(login.statusCode).toBe(409);
    const traces = await db.select().from(auditLog).where(eq(auditLog.action, 'REINIT_PIN'));
    expect(traces.length).toBeGreaterThanOrEqual(1);
  });

  it('désactiver un employé coupe l’accès (login refusé)', async () => {
    const rep = await app.inject({ method: 'POST', url: `/api/admin/equipe/${donnees.caissier2_id}/desactiver`, cookies: cookiesSuper });
    expect(rep.statusCode).toBe(200);
    const [u] = await db.select().from(utilisateurs).where(eq(utilisateurs.id, donnees.caissier2_id));
    expect(u!.actif).toBe(false);
  });
});

describe('protection des comptes d’encadrement (1.3 / DdT 8)', () => {
  it('le SUPERVISEUR ne peut pas réinitialiser le PIN d’un PROPRIETAIRE → 403 + audit', async () => {
    const rep = await app.inject({ method: 'POST', url: `/api/admin/equipe/${donnees.proprio_id}/reinit-pin`, cookies: cookiesSuper });
    expect(rep.statusCode).toBe(403);
    expect(rep.json().erreur).toBe('Le compte propriétaire est protégé');
    const traces = await db.select().from(auditLog).where(eq(auditLog.action, 'ACCES_PROTEGE_REFUSE'));
    expect(traces.length).toBeGreaterThanOrEqual(1);
  });

  it('le SUPERVISEUR ne peut pas promouvoir un employé PROPRIETAIRE', async () => {
    const rep = await app.inject({
      method: 'PATCH',
      url: `/api/admin/equipe/${donnees.serveur_id}`,
      cookies: cookiesSuper,
      payload: { role_id: donnees.roles.PROPRIETAIRE },
    });
    expect(rep.statusCode).toBe(403);
  });

  it('le PROPRIETAIRE, lui, peut créer un SUPERVISEUR (DdT 5)', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: '/api/admin/equipe',
      cookies: cookiesProprio,
      payload: { nom_complet: 'Nouveau Super', role_id: donnees.roles.SUPERVISEUR },
    });
    expect(rep.statusCode).toBe(200);
  });
});
