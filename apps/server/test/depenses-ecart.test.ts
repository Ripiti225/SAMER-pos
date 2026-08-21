/**
 * Écart de caisse (« manquant ») et dépenses en espèces.
 *
 * L'argent du tiroir est fongible : une dépense payée en espèces sort du tiroir
 * (peu importe qu'elle vienne du fond ou de la recette). Le théorique espèces
 * doit donc la déduire — sinon une dépense légitime apparaît comme un manquant.
 *
 *   espèces_théoriques = fond + espèces encaissées − dépenses
 *   écart              = espèces_comptées − espèces_théoriques
 *
 * Depuis DESIGN_V2 § 6.8, le montant des dépenses n'est plus envoyé par la
 * caisse : c'est la SOMME du registre, calculée par le serveur. Les tests
 * enregistrent donc de vraies lignes de dépense.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { fermerDb } from '../src/db/client.js';
import {
  ouvrirServiceEtCommande,
  PIN_CAISSIER,
  resetDonnees,
  seConnecter,
  validerInventaire,
  type Donnees,
} from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;

/** Enregistre une sortie de caisse au registre (§ 6.8). */
async function depenser(montant: number, libelle = 'Marché du matin') {
  const r = await app.inject({
    method: 'POST',
    url: '/api/depenses',
    cookies,
    payload: { categorie: 'MARCHE', libelle, montant },
  });
  expect(r.statusCode).toBe(200);
}

async function payer(commandeId: string, montant: number) {
  const r = await app.inject({
    method: 'POST',
    url: `/api/commandes/${commandeId}/paiements`,
    cookies,
    payload: { mode: 'ESPECES', montant },
  });
  expect(r.statusCode).toBe(200);
}

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('Écart de caisse avec dépenses en espèces', () => {
  it('une dépense en espèces ne crée PAS de manquant (théorique la déduit)', async () => {
    // fond 25000, encaissé 6000 espèces, dépensé 2000 en espèces depuis le tiroir.
    // Tiroir attendu = 25000 + 6000 − 2000 = 29000. Compté 29000 → écart 0.
    const c = await ouvrirServiceEtCommande(app, cookies, donnees, 2); // 6000 F
    await payer(c.commande_id, 6000);
    await depenser(2000);
    await validerInventaire(app, cookies);
    const rep = await app.inject({
      method: 'POST',
      url: '/api/services/cloturer',
      cookies,
      payload: { especes_comptees: 29000, livraisons: {}, modes: {} },
    });
    expect(rep.statusCode).toBe(200);
    const z = rep.json();
    expect(z.especes_theorique).toBe(29000);
    expect(z.ecart).toBe(0);
    expect(z.depenses).toBe(2000);
  });

  it('un vrai manquant reste détecté, en plus de la dépense', async () => {
    // Mêmes chiffres, mais il manque réellement 500 dans le tiroir : compté 28500.
    const c = await ouvrirServiceEtCommande(app, cookies, donnees, 2); // 6000 F
    await payer(c.commande_id, 6000);
    await depenser(2000);
    await validerInventaire(app, cookies);
    const rep = await app.inject({
      method: 'POST',
      url: '/api/services/cloturer',
      cookies,
      payload: { especes_comptees: 28500, livraisons: {}, modes: {} },
    });
    expect(rep.statusCode).toBe(200);
    const z = rep.json();
    expect(z.especes_theorique).toBe(29000);
    expect(z.ecart).toBe(-500); // vrai manquant, la dépense n'en fait pas partie
  });
});
