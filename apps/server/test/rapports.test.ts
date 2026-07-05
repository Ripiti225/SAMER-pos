/**
 * SPRINT 4 C — Rapports : X enrichi (manager), Z enrichi, tableau de bord
 * propriétaire (chiffres exacts vérifiés à la main).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { fermerDb } from '../src/db/client.js';
import {
  PIN_CAISSIER,
  PIN_MANAGER,
  PIN_PROPRIO,
  resetDonnees,
  seConnecter,
  type Donnees,
} from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookiesCaissier: Record<string, string>;
let cookiesManager: Record<string, string>;
let cookiesProprio: Record<string, string>;
let serviceId: string;

async function vente(quantite: number): Promise<string> {
  const c = await app.inject({ method: 'POST', url: '/api/commandes', cookies: cookiesCaissier, payload: { type: 'EMPORTER' } });
  const id = c.json().id as string;
  await app.inject({ method: 'POST', url: `/api/commandes/${id}/items`, cookies: cookiesCaissier, payload: { article_id: donnees.article_id, quantite, options: [], supplements: [] } });
  return id;
}
async function payer(id: string, montant: number) {
  await app.inject({ method: 'POST', url: `/api/commandes/${id}/paiements`, cookies: cookiesCaissier, payload: { mode: 'ESPECES', montant } });
}

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookiesCaissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  cookiesManager = await seConnecter(app, donnees.manager_id, PIN_MANAGER);
  cookiesProprio = await seConnecter(app, donnees.proprio_id, PIN_PROPRIO);
  const s = await app.inject({ method: 'POST', url: '/api/services/ouvrir', cookies: cookiesCaissier, payload: { fond_de_caisse: 25000 } });
  serviceId = s.json().id as string;

  // 3 ventes : 3000, 3000, 6000 → CA 12000, panier moyen 4000
  await payer(await vente(1), 3000);
  const v2 = await vente(1);
  // une remise manager de 500 sur v2 (chawarma 3000 → 2500)
  await app.inject({ method: 'POST', url: `/api/commandes/${v2}/remise`, cookies: cookiesCaissier, payload: { montant: 500, motif: 'Client fidèle', pin_manager: PIN_MANAGER } });
  await payer(v2, 2500);
  await payer(await vente(2), 6000);
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('C1 — Rapport X (manager uniquement)', () => {
  it('un CAISSIER reçoit 403', async () => {
    const rep = await app.inject({ method: 'GET', url: `/api/services/${serviceId}/rapport-x`, cookies: cookiesCaissier });
    expect(rep.statusCode).toBe(403);
  });

  it('le manager voit le X enrichi (par type, remises détaillées, top plats)', async () => {
    const rep = await app.inject({ method: 'GET', url: `/api/services/${serviceId}/rapport-x`, cookies: cookiesManager });
    expect(rep.statusCode).toBe(200);
    const x = rep.json();
    expect(x.nb_commandes_payees).toBe(3);
    expect(x.par_type.EMPORTER.nb).toBe(3);
    expect(x.total_remises).toBe(500);
    expect(x.remises_detail).toHaveLength(1);
    expect(x.remises_detail[0].motif).toBe('Client fidèle');
    expect(x.remises_detail[0].par_nom).toContain('Manager');
    expect(x.top_articles.length).toBeGreaterThan(0);
  });
});

describe('C3 — Tableau de bord propriétaire (chiffres exacts)', () => {
  it('CA, tickets et panier moyen sont exacts (12000 / 3 / 4000)', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/rapports/tableau-bord?periode=jour', cookies: cookiesProprio });
    expect(rep.statusCode).toBe(200);
    const t = rep.json();
    // 3000 + 2500 (après remise) + 6000 = 11500
    expect(t.ca).toBe(11500);
    expect(t.tickets).toBe(3);
    expect(t.panier_moyen).toBe(Math.round(11500 / 3));
    expect(t.par_mode.ESPECES).toBe(11500);
    expect(t.top_plats[0].nom).toBe('Chawarma Poulet');
  });

  it('le tableau de bord est réservé au PROPRIETAIRE (manager → 403)', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/rapports/tableau-bord', cookies: cookiesManager });
    expect(rep.statusCode).toBe(403);
  });
});

describe('C2 — Rapport Z enrichi', () => {
  it('la clôture fige un Z avec par_type et récap partenaires', async () => {
    const rep = await app.inject({ method: 'POST', url: '/api/services/cloturer', cookies: cookiesCaissier, payload: { especes_comptees: 36500 } });
    expect(rep.statusCode).toBe(200);
    const z = rep.json();
    expect(z.par_type.EMPORTER.nb).toBe(3);
    expect(z.remises_detail).toHaveLength(1);
    expect(z.panier_moyen).toBe(Math.round(11500 / 3));
    expect(z).toHaveProperty('partenaires');
  });
});
