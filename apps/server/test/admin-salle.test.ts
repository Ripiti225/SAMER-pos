/**
 * SPRINT 4C — Salle & QR (2.2). Créer une zone + des tables, régénérer un QR,
 * imprimer le PDF, refuser la désactivation d'une table occupée.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { tablesSalle } from '../src/db/schema/index.js';
import { PIN_CAISSIER, PIN_PROPRIO, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookiesProprio: Record<string, string>;
let cookiesCaissier: Record<string, string>;
let zoneEtageId: string;

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookiesProprio = await seConnecter(app, donnees.proprio_id, PIN_PROPRIO);
  cookiesCaissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('accès', () => {
  it('un caissier ne gère pas la salle (403)', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/admin/salle', cookies: cookiesCaissier });
    expect(rep.statusCode).toBe(403);
  });
});

describe('zones & tables (DdT 3)', () => {
  it('crée une zone « Étage »', async () => {
    const rep = await app.inject({ method: 'POST', url: '/api/admin/zones', cookies: cookiesProprio, payload: { nom: 'Étage', ordre: 5 } });
    expect(rep.statusCode).toBe(200);
    zoneEtageId = rep.json().id;
  });

  it('crée 3 tables dans la zone, chacune avec son QR', async () => {
    for (const numero of ['E1', 'E2', 'E3']) {
      const rep = await app.inject({ method: 'POST', url: '/api/admin/tables', cookies: cookiesProprio, payload: { zone_id: zoneEtageId, numero } });
      expect(rep.statusCode).toBe(200);
      expect(rep.json().qr_token).toMatch(/^QR-/);
    }
    const plan = await app.inject({ method: 'GET', url: '/api/admin/salle', cookies: cookiesProprio });
    const zone = (plan.json() as Array<{ id: string; tables: unknown[] }>).find((z) => z.id === zoneEtageId);
    expect(zone!.tables.length).toBe(3);
  });

  it('refuse un numéro de table en doublon dans la même zone', async () => {
    const rep = await app.inject({ method: 'POST', url: '/api/admin/tables', cookies: cookiesProprio, payload: { zone_id: zoneEtageId, numero: 'E1' } });
    expect(rep.statusCode).toBe(409);
  });

  it('régénère le QR d’une table (l’ancien jeton change)', async () => {
    const [t] = await db.select().from(tablesSalle).where(eq(tablesSalle.numero, 'E2'));
    const ancien = t!.qr_token;
    const rep = await app.inject({ method: 'POST', url: `/api/admin/tables/${t!.id}/regenerer-qr`, cookies: cookiesProprio });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().qr_token).not.toBe(ancien);
    const [apres] = await db.select().from(tablesSalle).where(eq(tablesSalle.id, t!.id));
    expect(apres!.qr_token).not.toBe(ancien);
  });

  it('imprime le PDF des QR (application/pdf non vide)', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/admin/tables/qr.pdf', cookies: cookiesProprio });
    expect(rep.statusCode).toBe(200);
    expect(rep.headers['content-type']).toContain('application/pdf');
    expect(rep.rawPayload.length).toBeGreaterThan(1000);
    expect(rep.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('désactivation d’une table', () => {
  it('refuse de désactiver une table avec une commande en cours', async () => {
    // Ouvre un service + une commande sur la table du fixture
    await app.inject({ method: 'POST', url: '/api/services/ouvrir', cookies: cookiesCaissier, payload: { fond_de_caisse: 25000 } });
    await app.inject({ method: 'POST', url: '/api/commandes', cookies: cookiesCaissier, payload: { type: 'SUR_PLACE', table_id: donnees.table_id } });
    const rep = await app.inject({ method: 'PATCH', url: `/api/admin/tables/${donnees.table_id}`, cookies: cookiesProprio, payload: { actif: false } });
    expect(rep.statusCode).toBe(409);
  });

  it('désactive une table libre', async () => {
    const [t] = await db.select().from(tablesSalle).where(eq(tablesSalle.numero, 'E3'));
    const rep = await app.inject({ method: 'PATCH', url: `/api/admin/tables/${t!.id}`, cookies: cookiesProprio, payload: { actif: false } });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().actif).toBe(false);
  });
});
