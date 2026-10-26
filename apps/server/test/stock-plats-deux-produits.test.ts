/**
 * Un plat à deux produits (2026-10-26) : la bande montre les deux, et le plat
 * est épuisé dès que l'UN des deux l'est — pas de Chawarma frites sans frites.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { StockPlatsVue } from '@pos/shared';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { inventaireConsommations, produitsInventaire } from '../src/db/schema/index.js';
import { PIN_CAISSIER, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let caisse: Record<string, string>;
let pain: string;
let sachet: string;

const stock = async (): Promise<StockPlatsVue> =>
  (await app.inject({ method: 'GET', url: '/api/stock-plats', cookies: caisse })).json();

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  caisse = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  const [p1, fr1, fr3] = await db.insert(produitsInventaire).values([
    { code: 'p1', categorie: 'PAIN', nom: 'Pain chawarma', role: 'COMPTE', ordre: 1 },
    { code: 'fr1', categorie: 'FRIT', nom: 'Portions de frites', role: 'CONSO_FRITES', ratio: '8', ordre: 1 },
    { code: 'fr3', categorie: 'FRIT', nom: 'Sachet de frites', unite: 'sachet', role: 'TOTAL_FRITES', ordre: 3 },
  ]).returning();
  pain = p1!.id;
  sachet = fr3!.id;
  await db.insert(inventaireConsommations).values([
    { produit_id: pain, article_id: donnees.article_id, quantite: '1' },
    { produit_id: fr1!.id, article_id: donnees.article_id, quantite: '1' },
  ]);
  const ouvrir = await app.inject({ method: 'POST', url: '/api/services/ouvrir', cookies: caisse, payload: { fond_de_caisse: 0 } });
  expect(ouvrir.statusCode).toBe(200);
  for (const [produit_id, quantite] of [[pain, 20], [sachet, 1]] as const) {
    const r = await app.inject({ method: 'POST', url: '/api/inventaire/entrees', cookies: caisse, payload: { produit_id, quantite } });
    expect(r.statusCode).toBe(200);
  }
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

it('montre les deux produits, et le plat suit celui qui manque', async () => {
  let plat = (await stock()).plats[donnees.article_id]!;
  expect(plat.texte).toBe('Pain chawarma 20 · ≈ 20');
  expect(plat.autres?.map((a) => a.produit_id)).toEqual([sachet]);
  expect(plat.autres?.[0]?.plats_possibles).toBe(8);
  expect(plat.etat).toBe('OK');

  // 8 chawarmas : le sachet de frites est vide, le pain en a encore 12.
  const c = (await app.inject({ method: 'POST', url: '/api/commandes', cookies: caisse, payload: { type: 'EMPORTER' } })).json();
  const item = await app.inject({
    method: 'POST', url: `/api/commandes/${c.id}/items`, cookies: caisse,
    payload: { article_id: donnees.article_id, quantite: 8, options: [], supplements: [] },
  });
  expect(item.statusCode).toBe(200);
  const p = await app.inject({
    method: 'POST', url: `/api/commandes/${c.id}/paiements`, cookies: caisse,
    payload: { mode: 'ESPECES', montant: item.json().total },
  });
  expect(p.statusCode).toBe(200);

  plat = (await stock()).plats[donnees.article_id]!;
  expect(plat.plats_possibles).toBe(12);
  expect(plat.etat_produit).toBe('OK');
  expect(plat.autres?.[0]?.etat).toBe('EPUISE');
  expect(plat.etat).toBe('EPUISE');
});
