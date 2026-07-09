/**
 * SPRINT 4C — Paramètres (2.6) et Journal d'audit (2.7).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { fermerDb } from '../src/db/client.js';
import { PIN_CAISSIER, PIN_MANAGER, PIN_PROPRIO, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookiesProprio: Record<string, string>;
let cookiesManager: Record<string, string>;
let cookiesCaissier: Record<string, string>;

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookiesProprio = await seConnecter(app, donnees.proprio_id, PIN_PROPRIO);
  cookiesManager = await seConnecter(app, donnees.manager_id, PIN_MANAGER);
  cookiesCaissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('paramètres du restaurant (2.6)', () => {
  it('un caissier n’accède pas aux paramètres (403)', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/admin/parametres', cookies: cookiesCaissier });
    expect(rep.statusCode).toBe(403);
  });

  it('liste les paramètres éditables avec libellés et valeurs', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/admin/parametres', cookies: cookiesManager });
    expect(rep.statusCode).toBe(200);
    const params = rep.json() as Array<{ cle: string; libelle: string; valeur: unknown }>;
    const seuil = params.find((p) => p.cle === 'seuil_alerte_ecart_caisse');
    expect(seuil!.libelle).toBeTruthy();
    expect(seuil!.valeur).toBe(2000);
  });

  it('modifie un paramètre (effet immédiat + audit)', async () => {
    const rep = await app.inject({
      method: 'PATCH',
      url: '/api/admin/parametres',
      cookies: cookiesProprio,
      payload: { cle: 'seuil_alerte_ecart_caisse', valeur: 5000 },
    });
    expect(rep.statusCode).toBe(200);
    const relu = await app.inject({ method: 'GET', url: '/api/admin/parametres', cookies: cookiesProprio });
    const seuil = (relu.json() as Array<{ cle: string; valeur: unknown }>).find((p) => p.cle === 'seuil_alerte_ecart_caisse');
    expect(seuil!.valeur).toBe(5000);
  });

  it('refuse une clé hors liste blanche', async () => {
    const rep = await app.inject({
      method: 'PATCH',
      url: '/api/admin/parametres',
      cookies: cookiesProprio,
      payload: { cle: 'clef_bidon', valeur: 1 },
    });
    expect(rep.statusCode).toBe(400);
  });
});

describe('journal d’audit (2.7)', () => {
  it('le journal remonte l’action MODIF_PARAMETRE avec l’auteur', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/admin/audit?action=MODIF_PARAMETRE', cookies: cookiesProprio });
    expect(rep.statusCode).toBe(200);
    const lignes = rep.json() as Array<{ action: string; user_nom: string }>;
    expect(lignes.length).toBeGreaterThanOrEqual(1);
    expect(lignes[0]!.action).toBe('MODIF_PARAMETRE');
    expect(lignes[0]!.user_nom).toBe('Proprio Test');
  });

  it('un caissier n’accède pas au journal (403)', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/admin/audit', cookies: cookiesCaissier });
    expect(rep.statusCode).toBe(403);
  });
});
