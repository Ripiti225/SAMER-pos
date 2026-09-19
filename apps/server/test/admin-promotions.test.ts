import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { promotions } from '../src/db/schema/index.js';
import {
  PIN_CAISSIER,
  PIN_PROPRIO,
  ouvrirServiceEtCommande,
  resetDonnees,
  seConnecter,
  type Donnees,
} from './aide.js';

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

describe('suppression des promotions', () => {
  it('explique qu’une promotion active déjà appliquée doit être désactivée', async () => {
    const [promo] = await db
      .insert(promotions)
      .values({
        nom: 'Happy Hour test',
        type: 'POURCENTAGE',
        valeur: 20,
        // Sans plage horaire, elle est active au moment exact du test.
        jours: [1, 2, 3, 4, 5, 6, 7],
        actif: true,
      })
      .returning();

    await ouvrirServiceEtCommande(app, cookiesCaissier, donnees, 1);

    const rep = await app.inject({
      method: 'DELETE',
      url: `/api/admin/promotions/${promo!.id}`,
      cookies: cookiesProprio,
    });

    expect(rep.statusCode, rep.body).toBe(409);
    expect(rep.json().erreur).toBe(
      'Cette promotion a déjà été appliquée à des commandes : elle ne peut pas être supprimée. Désactivez-la, elle ne s’appliquera plus.',
    );
  });
});
