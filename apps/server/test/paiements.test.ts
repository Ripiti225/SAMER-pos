import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { fermerDb } from '../src/db/client.js';
import {
  ouvrirServiceEtCommande,
  PIN_CAISSIER,
  resetDonnees,
  seConnecter,
  type Donnees,
} from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;
let commandeId: string;

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  const c = await ouvrirServiceEtCommande(app, cookies, donnees, 2); // 2 × 3000 = 6000 F
  commandeId = c.commande_id;
  expect(c.total).toBe(6000);
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('paiement mixte : PAYEE uniquement si SUM(paiements) == total', () => {
  it('un paiement partiel laisse la commande ouverte avec le bon reste', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commandeId}/paiements`,
      cookies,
      payload: { mode: 'ESPECES', montant: 5000 },
    });
    expect(rep.statusCode).toBe(200);
    const vue = rep.json();
    expect(vue.statut).not.toBe('PAYEE');
    expect(vue.paye).toBe(5000);
    expect(vue.reste).toBe(1000);
  });

  it('refuse un paiement qui dépasse le reste à payer', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commandeId}/paiements`,
      cookies,
      payload: { mode: 'WAVE', montant: 2000 },
    });
    expect(rep.statusCode).toBe(400);
    expect(rep.json().erreur).toBe('Le montant dépasse le reste à payer');
  });

  it('passe à PAYEE exactement quand la somme atteint le total (mixte espèces + Wave)', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commandeId}/paiements`,
      cookies,
      payload: { mode: 'WAVE', montant: 1000 },
    });
    expect(rep.statusCode).toBe(200);
    const vue = rep.json();
    expect(vue.statut).toBe('PAYEE');
    expect(vue.reste).toBe(0);
    expect(vue.paiements).toHaveLength(2);
  });

  it('refuse tout paiement supplémentaire sur une commande encaissée', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commandeId}/paiements`,
      cookies,
      payload: { mode: 'ESPECES', montant: 100 },
    });
    expect(rep.statusCode).toBe(409);
    expect(rep.json().erreur).toBe('Cette commande est déjà encaissée');
  });

  it('refuse la création d’un ancien split monétaire', async () => {
    const c2 = await app.inject({ method: 'POST', url: '/api/commandes', cookies, payload: { type: 'EMPORTER' } });
    const id2 = c2.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/api/commandes/${id2}/items`,
      cookies,
      payload: { article_id: donnees.article_id, quantite: 2, options: [], supplements: [] },
    });

    const ancienSplit = await app.inject({
      method: 'POST',
      url: `/api/commandes/${id2}/split`,
      cookies,
      payload: { notes: [{ libelle: 'Client A', montant: 3000 }, { libelle: 'Client B', montant: 3000 }] },
    });
    expect(ancienSplit.statusCode).toBe(410);
    expect(ancienSplit.json().erreur).toContain('Payer par articles');
  });
});
