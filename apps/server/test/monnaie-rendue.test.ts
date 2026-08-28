/**
 * Billet reçu et monnaie rendue.
 *
 * La règle tenue ici : la caisse transmet UNIQUEMENT ce que le caissier a vu
 * (le billet posé). Le rendu de monnaie est calculé par le serveur, figé sur
 * le paiement, et il ne touche ni la vente ni l'écart de caisse — le billet
 * entre dans le tiroir à l'instant où la monnaie en sort.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { fermerDb } from '../src/db/client.js';
import {
  ouvrirServiceEtCommande,
  PIN_CAISSIER,
  PIN_MANAGER,
  resetDonnees,
  seConnecter,
  type Donnees,
} from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;
/** Le rapport « besoin en monnaie » est réservé au porteur de `rapports.z`. */
let cookiesManager: Record<string, string>;
/** Première commande, créée en même temps que l'unique service du caissier. */
let premiereCommande: string;

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  cookiesManager = await seConnecter(app, donnees.manager_id, PIN_MANAGER);
  premiereCommande = (await ouvrirServiceEtCommande(app, cookies, donnees, 2)).commande_id;
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

/**
 * Nouvelle commande à emporter sur le service DÉJÀ ouvert : un caissier n'a
 * qu'un shift à la fois, ouvrir un second service échouerait.
 */
async function commande(quantite: number): Promise<string> {
  const repCommande = await app.inject({
    method: 'POST',
    url: '/api/commandes',
    cookies,
    payload: { type: 'EMPORTER' },
  });
  expect(repCommande.statusCode).toBe(200);
  const id = (repCommande.json() as { id: string }).id;
  const repItem = await app.inject({
    method: 'POST',
    url: `/api/commandes/${id}/items`,
    cookies,
    payload: { article_id: donnees.article_id, quantite, options: [], supplements: [] },
  });
  expect(repItem.statusCode).toBe(200);
  return id;
}

describe('monnaie rendue', () => {
  it('calcule et fige le rendu à partir du billet posé', async () => {
    const id = premiereCommande; // 6 000 F
    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${id}/paiements`,
      cookies,
      payload: { mode: 'ESPECES', montant: 6000, montant_recu: 10000 },
    });
    expect(rep.statusCode).toBe(200);
    const vue = rep.json();
    expect(vue.statut).toBe('PAYEE');
    const paiement = vue.paiements[0];
    expect(paiement.montant_recu).toBe(10000);
    expect(paiement.monnaie_rendue).toBe(4000);
  });

  it('accepte le compte juste : billet égal au montant, rendu nul', async () => {
    const id = await commande(1); // 3 000 F
    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${id}/paiements`,
      cookies,
      payload: { mode: 'ESPECES', montant: 3000, montant_recu: 3000 },
    });
    expect(rep.statusCode).toBe(200);
    const paiement = rep.json().paiements[0];
    expect(paiement.montant_recu).toBe(3000);
    expect(paiement.monnaie_rendue).toBe(0);
  });

  it('refuse un billet inférieur au montant encaissé', async () => {
    const id = await commande(2); // 6 000 F
    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${id}/paiements`,
      cookies,
      payload: { mode: 'ESPECES', montant: 6000, montant_recu: 5000 },
    });
    expect(rep.statusCode).toBe(400);
    expect(rep.json().erreur).toBe('Les espèces reçues sont inférieures au montant encaissé');
  });

  it('ignore le billet hors espèces : Wave ne rend pas la monnaie', async () => {
    const id = await commande(2); // 6 000 F
    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${id}/paiements`,
      cookies,
      payload: { mode: 'WAVE', montant: 6000, montant_recu: 10000 },
    });
    expect(rep.statusCode).toBe(200);
    const paiement = rep.json().paiements[0];
    expect(paiement.montant_recu).toBeNull();
    expect(paiement.monnaie_rendue).toBeNull();
  });

  it('laisse la trace vide quand le caissier ne saisit pas le billet', async () => {
    const id = await commande(1); // 3 000 F
    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${id}/paiements`,
      cookies,
      payload: { mode: 'ESPECES', montant: 3000 },
    });
    expect(rep.statusCode).toBe(200);
    const paiement = rep.json().paiements[0];
    expect(paiement.montant_recu).toBeNull();
    expect(paiement.monnaie_rendue).toBeNull();
  });

  it('remonte le besoin en monnaie de la journée sans toucher à la vente', async () => {
    const rep = await app.inject({
      method: 'GET',
      url: '/api/rapports/besoin-monnaie?jours=7',
      cookies: cookiesManager,
    });
    expect(rep.statusCode).toBe(200);
    const bilan = rep.json();
    expect(bilan.jours).toBe(7);
    // Un seul encaissement a rendu de la monnaie : 4 000 F sur le premier test.
    const totalRendu = bilan.par_jour.reduce((s: number, j: { total: number }) => s + j.total, 0);
    expect(totalRendu).toBe(4000);
    expect(bilan.jours_traces).toBe(1);
    expect(bilan.maximum).toBe(4000);
    // Le fond se prépare en coupures : 4 000 F arrondis au 5 000 supérieur.
    expect(bilan.recommande).toBe(5000);
  });
});
