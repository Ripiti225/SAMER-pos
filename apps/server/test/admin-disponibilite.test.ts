/**
 * SPRINT 4C — Disponibilité locale (2.3) + invariant DdT 4 : une descente de
 * catalogue ne doit jamais écraser un « épuisé » posé sur place.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { assurerDisponibilite, articleDisponible } from '../src/modules/catalogue/disponibilite.js';
import { PIN_CAISSIER, PIN_PROPRIO, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookiesProprio: Record<string, string>;
let cookiesCaissier: Record<string, string>;

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

describe('accès et bascule', () => {
  it('un caissier n’a pas accès à la disponibilité (403)', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/admin/disponibilite', cookies: cookiesCaissier });
    expect(rep.statusCode).toBe(403);
  });

  it('tous les articles sont disponibles par défaut', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/admin/disponibilite', cookies: cookiesProprio });
    expect(rep.statusCode).toBe(200);
    const arts = rep.json() as Array<{ disponible: boolean }>;
    expect(arts.every((a) => a.disponible)).toBe(true);
  });

  it('marquer un plat épuisé se reflète dans le catalogue', async () => {
    const rep = await app.inject({
      method: 'PATCH',
      url: `/api/admin/disponibilite/${donnees.article_id}`,
      cookies: cookiesProprio,
      payload: { disponible: false },
    });
    expect(rep.statusCode).toBe(200);

    const cat = await app.inject({ method: 'GET', url: '/api/catalogue', cookies: cookiesCaissier });
    const art = (cat.json().articles as Array<{ id: string; disponible: boolean }>).find((a) => a.id === donnees.article_id);
    expect(art!.disponible).toBe(false);
  });
});

describe('invariant DdT 4 : la descente n’écrase pas un « épuisé »', () => {
  it('assurerDisponibilite (étape de descente) ne réactive pas un article épuisé', async () => {
    // L'article a été marqué épuisé au test précédent.
    expect(await articleDisponible(db, donnees.article_id)).toBe(false);
    // Une descente incrémentale garantit une ligne pour chaque article…
    await assurerDisponibilite(db, [donnees.article_id]);
    // …mais NE réactive PAS un épuisé posé sur place.
    expect(await articleDisponible(db, donnees.article_id)).toBe(false);
  });

  it('un article encore sans ligne (nouveau) arrive disponible après la descente', async () => {
    // pizza_id n'a jamais été basculé : la descente lui crée une ligne à TRUE.
    await assurerDisponibilite(db, [donnees.pizza_id]);
    expect(await articleDisponible(db, donnees.pizza_id)).toBe(true);
  });
});
