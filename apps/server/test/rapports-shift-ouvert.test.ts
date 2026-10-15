/**
 * Ventes d'un shift EN COURS (décision du 2026-10-15) : un gérant ne les voit
 * qu'une fois le caissier clôturé — sinon il pourrait lui souffler sa vente
 * avant le comptage à l'aveugle. Le propriétaire, lui, voit tout en direct.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { fermerDb } from '../src/db/client.js';
import {
  ouvrirServiceEtCommande,
  PIN_CAISSIER,
  PIN_MANAGER,
  PIN_PROPRIO,
  resetDonnees,
  seConnecter,
  validerInventaire,
  type Donnees,
} from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let caissier: Record<string, string>;
let gerant: Record<string, string>;
let proprio: Record<string, string>;
let serviceId: string;

const lire = async (url: string, cookies: Record<string, string>) => {
  const r = await app.inject({ method: 'GET', url, cookies });
  return { code: r.statusCode, corps: r.json() };
};

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  caissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  gerant = await seConnecter(app, donnees.manager_id, PIN_MANAGER);
  proprio = await seConnecter(app, donnees.proprio_id, PIN_PROPRIO);
  const c = await ouvrirServiceEtCommande(app, caissier, donnees, 1); // 3 000 F
  serviceId = c.service_id;
  const pay = await app.inject({
    method: 'POST',
    url: `/api/commandes/${c.commande_id}/paiements`,
    cookies: caissier,
    payload: { mode: 'ESPECES', montant: 3000 },
  });
  expect(pay.json().statut).toBe('PAYEE');
});
afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('shift du caissier encore ouvert', () => {
  it('le gérant ne voit ni la vente du jour, ni les modes, ni les heures, ni les plats', async () => {
    const jour = await lire('/api/rapports/jour', gerant);
    expect(jour.code).toBe(200);
    expect(jour.corps.total_ventes).toBe(0);
    expect(jour.corps.nb_commandes).toBe(0);
    expect(jour.corps.par_mode.ESPECES).toBe(0);
    expect(jour.corps.en_direct).toBe(false);
    expect(jour.corps.shifts_en_cours).toBe(1);

    expect((await lire('/api/rapports/par-heure', gerant)).corps).toEqual([]);
    expect((await lire('/api/rapports/top-plats', gerant)).corps).toEqual([]);
  });

  it('le gérant ne peut pas lire le Rapport X d’un shift ouvert', async () => {
    const x = await lire(`/api/services/${serviceId}/rapport-x`, gerant);
    expect(x.code).toBe(403);
    expect(x.corps.erreur).toContain('après sa clôture');
    expect(JSON.stringify(x.corps)).not.toContain('theorique');
  });

  it('le propriétaire voit tout en direct', async () => {
    const jour = await lire('/api/rapports/jour', proprio);
    expect(jour.corps.total_ventes).toBe(3000);
    expect(jour.corps.en_direct).toBe(true);
    const heures = (await lire('/api/rapports/par-heure', proprio)).corps as { total: number }[];
    expect(heures.reduce((s, h) => s + h.total, 0)).toBe(3000);
    expect((await lire(`/api/services/${serviceId}/rapport-x`, proprio)).code).toBe(200);
  });
});

describe('après la clôture du caissier', () => {
  it('les ventes arrivent chez le gérant', async () => {
    await validerInventaire(app, caissier);
    const z = await app.inject({
      method: 'POST',
      url: '/api/services/cloturer',
      cookies: caissier,
      payload: { especes_comptees: 28000 },
    });
    expect(z.statusCode).toBe(200);

    const jour = await lire('/api/rapports/jour', gerant);
    expect(jour.corps.total_ventes).toBe(3000);
    expect(jour.corps.par_mode.ESPECES).toBe(3000);
    expect(jour.corps.shifts_en_cours).toBe(0);
    const heures = (await lire('/api/rapports/par-heure', gerant)).corps as { total: number }[];
    expect(heures.reduce((s, h) => s + h.total, 0)).toBe(3000);
    expect((await lire('/api/rapports/top-plats', gerant)).corps[0].quantite).toBe(1);
    expect((await lire(`/api/services/${serviceId}/rapport-x`, gerant)).code).toBe(200);
  });
});
