import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { fermerDb } from '../src/db/client.js';
import { ouvrirServiceEtCommande, PIN_CAISSIER, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('point à valider (shift clôturé non remis)', () => {
  it('un shift clôturé pose un cloture_en_attente jusqu’à l’accusé de fin', async () => {
    const c = await ouvrirServiceEtCommande(app, cookies, donnees, 1); // 3000 F
    await app.inject({ method: 'POST', url: `/api/commandes/${c.commande_id}/paiements`, cookies, payload: { mode: 'ESPECES', montant: 3000 } });
    const f = await app.inject({ method: 'POST', url: '/api/services/cloturer', cookies, payload: { especes_comptees: 28000, depenses: 0, livraisons: {}, modes: {} } });
    expect(f.statusCode).toBe(200);

    // Reconnexion : /moi renvoie le point à valider (ticket), pas de service ouvert.
    const moi = await app.inject({ method: 'GET', url: '/api/auth/moi', cookies });
    expect(moi.statusCode).toBe(200);
    const info = moi.json();
    expect(info.service_ouvert).toBeNull();
    expect(info.cloture_en_attente).toBeTruthy();
    expect(info.cloture_en_attente.total_ventes).toBe(3000);

    // Accusé de fin → le point à valider disparaît.
    const r = await app.inject({ method: 'POST', url: '/api/services/remettre-cloture', cookies });
    expect(r.statusCode).toBe(200);
    const moi2 = await app.inject({ method: 'GET', url: '/api/auth/moi', cookies });
    expect(moi2.json().cloture_en_attente).toBeNull();
  });
});
