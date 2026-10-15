import { afterAll, beforeAll, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { produitsInventaire } from '../src/db/schema/index.js';
import { PIN_CAISSIER, PIN_PROPRIO, resetDonnees, seConnecter } from './aide.js';

let app: FastifyInstance;
let caissier: Record<string, string>;
let proprietaire: Record<string, string>;
let articleId: string;

beforeAll(async () => {
  const donnees = await resetDonnees();
  articleId = donnees.article_id;
  app = await construireApp();
  caissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  proprietaire = await seConnecter(app, donnees.proprio_id, PIN_PROPRIO);
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

it('crée un produit absent et le rend comptable dans un inventaire déjà commencé', async () => {
  const ouverture = await app.inject({ method: 'POST', url: '/api/services/ouvrir', cookies: caissier, payload: { fond_de_caisse: 25000 } });
  expect(ouverture.statusCode).toBe(200);
  expect((await app.inject({ method: 'GET', url: '/api/inventaire', cookies: caissier })).statusCode).toBe(200);

  const payload = { nom: 'Pain burger', categorie: 'PAIN', unite: 'u', prix: 500 };
  const interdit = await app.inject({ method: 'POST', url: '/api/admin/recettes-inventaire/produits', cookies: caissier, payload });
  expect(interdit.statusCode).toBe(403);

  const creation = await app.inject({ method: 'POST', url: '/api/admin/recettes-inventaire/produits', cookies: proprietaire, payload });
  expect(creation.statusCode).toBe(200);
  const id = creation.json().id as string;
  const doublon = await app.inject({ method: 'POST', url: '/api/admin/recettes-inventaire/produits', cookies: proprietaire, payload });
  expect(doublon.statusCode).toBe(409);

  const inventaire = await app.inject({ method: 'GET', url: '/api/inventaire', cookies: caissier });
  expect(inventaire.statusCode).toBe(200);
  expect(inventaire.json().lignes).toEqual(expect.arrayContaining([expect.objectContaining({ produit_id: id, stock_compte: null, a_compter: true })]));
  const comptage = await app.inject({ method: 'PUT', url: `/api/inventaire/lignes/${id}`, cookies: caissier, payload: { stock_compte: 3 } });
  expect(comptage.statusCode).toBe(200);

  const recette = await app.inject({ method: 'PUT', url: `/api/admin/recettes-inventaire/${id}`, cookies: proprietaire, payload: { recettes: [{ article_id: articleId, quantite: 1 }] } });
  expect(recette.statusCode).toBe(200);
  const vue = await app.inject({ method: 'GET', url: '/api/admin/recettes-inventaire', cookies: proprietaire });
  expect(vue.json().produits.find((p: { id: string }) => p.id === id).recettes).toEqual([{ article_id: articleId, quantite: 1 }]);

  // Une descente du siège arrive après le premier affichage de l'inventaire.
  const [descendu] = await db.insert(produitsInventaire).values({
    code: 'POS_PRODUIT_DESCENDU', nom: 'Sauce nouvelle', categorie: 'PLAT', unite: 'u', prix: 300, role: 'COMPTE',
  }).returning();
  const apresDescente = await app.inject({ method: 'GET', url: '/api/inventaire', cookies: caissier });
  expect(apresDescente.statusCode).toBe(200);
  expect(apresDescente.json().lignes).toEqual(expect.arrayContaining([
    expect.objectContaining({ produit_id: descendu!.id, stock_compte: null, a_compter: true }),
  ]));
  const compterDescendu = await app.inject({ method: 'PUT', url: `/api/inventaire/lignes/${descendu!.id}`, cookies: caissier, payload: { stock_compte: 2 } });
  expect(compterDescendu.statusCode).toBe(200);

  const validation = await app.inject({ method: 'POST', url: '/api/inventaire/valider', cookies: caissier });
  expect(validation.statusCode).toBe(200);
  const [arriveTard] = await db.insert(produitsInventaire).values({
    code: 'POS_APRES_VALIDATION', nom: 'Produit du service suivant', categorie: 'PLAT', unite: 'u', prix: 100, role: 'COMPTE',
  }).returning();
  const fige = await app.inject({ method: 'GET', url: '/api/inventaire', cookies: caissier });
  expect(fige.statusCode).toBe(200);
  expect(fige.json().lignes.some((l: { produit_id: string }) => l.produit_id === arriveTard!.id)).toBe(false);
});
