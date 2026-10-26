/**
 * « Tables en cours » (2026-10-26) : les montants et les tables encaissées sont
 * réservés au PROPRIÉTAIRE (la règle de réouverture, elle, ne change pas).
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { fermerDb } from '../src/db/client.js';
import {
  ouvrirServiceEtCommande, PIN_CAISSIER, PIN_MANAGER, PIN_PROPRIO, resetDonnees, seConnecter, validerInventaire, type Donnees,
} from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let commandeId: string;
let total: number;

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  const caissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  const c = await ouvrirServiceEtCommande(app, caissier, donnees);
  commandeId = c.commande_id;
  total = c.total;
  const paiement = await app.inject({
    method: 'POST', url: `/api/commandes/${commandeId}/paiements`, cookies: caissier,
    payload: { mode: 'ESPECES', montant: total },
  });
  expect(paiement.statusCode).toBe(200);
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

it('le caissier compte ses tables encaissées sans voir de montant', async () => {
  const caissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  const vue = (await app.inject({ method: 'GET', url: '/api/rapports/mes-ventes', cookies: caissier })).json();
  expect(vue.nb_payees).toBe(1);
  expect(vue.total_payees).toBeUndefined();
  expect(vue.commandes.every((c: { total: number }) => c.total === 0)).toBe(true);
});

it('les tables encaissées sont réservées au propriétaire, montants compris', async () => {
  const manager = await seConnecter(app, donnees.manager_id, PIN_MANAGER);
  const refus = await app.inject({ method: 'GET', url: '/api/rapports/tables-encaissees', cookies: manager });
  expect(refus.statusCode).toBe(403);

  const proprio = await seConnecter(app, donnees.proprio_id, PIN_PROPRIO);
  const rep = await app.inject({ method: 'GET', url: '/api/rapports/tables-encaissees', cookies: proprio });
  expect(rep.statusCode).toBe(200);
  const [ligne] = rep.json() as Array<{ id: string; total: number; caissier: string }>;
  expect(ligne?.id).toBe(commandeId);
  expect(ligne?.total).toBe(total);
  expect(ligne?.caissier).toBeTruthy();
});

it('à la clôture, les tables du shift quittent la liste du propriétaire', async () => {
  const caissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  await validerInventaire(app, caissier);
  const cloture = await app.inject({
    method: 'POST', url: '/api/services/cloturer', cookies: caissier, payload: { especes_comptees: 0 },
  });
  expect(cloture.statusCode).toBe(200);

  const proprio = await seConnecter(app, donnees.proprio_id, PIN_PROPRIO);
  const rep = await app.inject({ method: 'GET', url: '/api/rapports/tables-encaissees', cookies: proprio });
  expect(rep.json()).toEqual([]);
});
