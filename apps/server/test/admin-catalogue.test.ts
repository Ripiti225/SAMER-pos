/**
 * SPRINT 4C — Catalogue (2.4) & barème fidélité (2.5).
 * L'édition passe par le cloud ; hors ligne (non enrôlé), elle est refusée avec
 * un message clair, la vente continuant. Invariant DdT 4 : une commande déjà
 * passée garde l'ancien prix (snapshot) quoi qu'il arrive au catalogue.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { articles } from '../src/db/schema/index.js';
import {
  PIN_CAISSIER,
  PIN_MANAGER,
  PIN_PROPRIO,
  ouvrirServiceEtCommande,
  resetDonnees,
  seConnecter,
  type Donnees,
} from './aide.js';

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

describe('accès (catalogue réservé, manager en lecture seule par défaut)', () => {
  it('un CAISSIER ne peut pas éditer le catalogue (403)', async () => {
    const rep = await app.inject({ method: 'POST', url: '/api/admin/catalogue', cookies: cookiesCaissier, payload: { entite: 'article', valeurs: { id: donnees.article_id, prix_base: 9000 } } });
    expect(rep.statusCode).toBe(403);
  });
  it('un MANAGER n’a pas la permission catalogue (403)', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/admin/catalogue', cookies: cookiesManager });
    expect(rep.statusCode).toBe(403);
  });
  it('le PROPRIETAIRE lit le catalogue pour l’édition', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/admin/catalogue', cookies: cookiesProprio });
    expect(rep.statusCode).toBe(200);
    expect(Array.isArray(rep.json().articles)).toBe(true);
  });
});

describe('édition hors ligne (site non enrôlé)', () => {
  it('modifier un prix sans cloud → 503 message clair', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: '/api/admin/catalogue',
      cookies: cookiesProprio,
      payload: { entite: 'article', valeurs: { id: donnees.article_id, prix_base: 9000 } },
    });
    expect(rep.statusCode).toBe(503);
    expect(rep.json().erreur).toContain('Modification du menu impossible sans internet');
  });

  it('le barème fidélité suit le même circuit (503 hors ligne)', async () => {
    const rep = await app.inject({
      method: 'PUT',
      url: '/api/admin/fidelite/bareme',
      cookies: cookiesProprio,
      payload: { valeur_point_fcfa: 15 },
    });
    expect(rep.statusCode).toBe(503);
  });
});

describe('invariant DdT 4 : les commandes passées gardent leur prix (snapshot)', () => {
  it('changer le prix de l’article n’altère pas une commande déjà passée', async () => {
    const c = await ouvrirServiceEtCommande(app, cookiesCaissier, donnees, 1); // 1 × 3000
    // Une descente de catalogue change le prix de base en local…
    await db.update(articles).set({ prix_base: 9999 }).where(eq(articles.id, donnees.article_id));
    // …mais la commande garde son snapshot.
    const vue = await app.inject({ method: 'GET', url: `/api/commandes/${c.commande_id}`, cookies: cookiesCaissier });
    const item = vue.json().items[0];
    expect(item.prix_unitaire).toBe(3000);
    expect(vue.json().total).toBe(3000);
  });
});
