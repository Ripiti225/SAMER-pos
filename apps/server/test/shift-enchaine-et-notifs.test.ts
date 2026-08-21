/**
 * Trois règles de terrain :
 *
 * 1. Un caissier enchaîne deux tranches (16h-00h puis 00h-08h) : il doit
 *    pouvoir se transférer SES PROPRES tables pour clôturer sa première
 *    tranche, et les retrouver en ouvrant la seconde.
 * 2. Une table ouverte par erreur (aucun article) ne bloque pas « J'ai fini ».
 * 3. Une commande servie par la cuisine ou par un serveur disparaît de la
 *    pastille « prête » de la caisse — elle y restait affichée pour toujours.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { TableVue } from '@pos/shared';
import { construireApp } from '../src/app.js';
import { fermerDb } from '../src/db/client.js';
import {
  JETON_KDS,
  PIN_CAISSIER,
  resetDonnees,
  seConnecter,
  validerInventaire,
  type Donnees,
} from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let caissier: Record<string, string>;

const kds = { 'x-jeton-kds': JETON_KDS };

async function ouvrirService(): Promise<void> {
  const rep = await app.inject({
    method: 'POST', url: '/api/services/ouvrir', cookies: caissier, payload: { fond_de_caisse: 25000 },
  });
  expect(rep.statusCode).toBe(200);
}

async function commandeSurTable(tableId: string, avecArticle = true): Promise<string> {
  const c = await app.inject({
    method: 'POST', url: '/api/commandes', cookies: caissier, payload: { type: 'SUR_PLACE', table_id: tableId },
  });
  expect(c.statusCode).toBe(200);
  const id = c.json().id as string;
  if (avecArticle) {
    const item = await app.inject({
      method: 'POST',
      url: `/api/commandes/${id}/items`,
      cookies: caissier,
      payload: { article_id: donnees.article_id, quantite: 1, options: [], supplements: [] },
    });
    expect(item.statusCode).toBe(200);
  }
  return id;
}

async function cloturer(): Promise<ReturnType<FastifyInstance['inject']>> {
  // Une tentative de clôture refusée laisse l'inventaire déjà validé : le
  // revalider lèverait. On ignore ce cas, le verrou n'est pas le sujet ici.
  try { await validerInventaire(app, caissier); } catch { /* déjà validé */ }
  return app.inject({
    method: 'POST',
    url: '/api/services/cloturer',
    cookies: caissier,
    payload: { especes_comptees: 25000, livraisons: {}, modes: {} },
  });
}

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  caissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('Deux tranches d’affilée pour le même caissier', () => {
  it('se transfère ses tables, clôture, puis les retrouve au shift suivant', async () => {
    await ouvrirService();
    const commandeId = await commandeSurTable(donnees.table_id);

    // Sans transfert, la clôture est bloquée par la table en cours.
    const bloquee = await cloturer();
    expect(bloquee.statusCode).toBe(409);
    expect(bloquee.json().erreur).toContain('commande(s) en cours');

    // Se transférer à SOI-MÊME : c'est le geste de fin de tranche.
    const transfert = await app.inject({
      method: 'POST',
      url: '/api/services/transferer',
      cookies: caissier,
      payload: { receveur_id: donnees.caissier_id, pin_receveur: PIN_CAISSIER },
    });
    expect(transfert.statusCode).toBe(200);
    expect(transfert.json().nb_transferees).toBe(1);
    expect(transfert.json().meme_caissier).toBe(true);

    const cloture = await cloturer();
    expect(cloture.statusCode).toBe(200);

    // La table est toujours occupée : rien n'a été encaissé ni perdu.
    const tables = await app.inject({ method: 'GET', url: '/api/tables', cookies: caissier });
    const t = (tables.json() as TableVue[]).find((x) => x.id === donnees.table_id)!;
    expect(t.etat).toBe('OCCUPEE');
    expect(t.commande_id).toBe(commandeId);

    // Deuxième tranche : la commande se rattache au nouveau shift.
    await ouvrirService();
    const mesVentes = await app.inject({ method: 'GET', url: '/api/rapports/mes-ventes', cookies: caissier });
    expect(mesVentes.statusCode).toBe(200);
    const encaisse = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commandeId}/paiements`,
      cookies: caissier,
      payload: { mode: 'ESPECES', montant: 3000 },
    });
    expect(encaisse.statusCode).toBe(200);
  });
});

describe('Table ouverte par erreur et clôture', () => {
  it('« J’ai fini » n’est pas bloqué par une commande sans article', async () => {
    const vide = await commandeSurTable(donnees.table2_id, false);
    const cloture = await cloturer();
    expect(cloture.statusCode).toBe(200);

    // La commande vide a été abandonnée (numéro conservé) et la table libérée.
    const tables = await app.inject({ method: 'GET', url: '/api/tables', cookies: caissier });
    const t2 = (tables.json() as TableVue[]).find((x) => x.id === donnees.table2_id)!;
    expect(t2.etat).toBe('LIBRE');
    expect(t2.statut).toBe('LIBRE');
    expect(vide).toBeTruthy();
  });
});

describe('Pastille « commande prête » de la caisse', () => {
  it('disparaît dès que la cuisine marque la commande servie', async () => {
    await ouvrirService();
    const commandeId = await commandeSurTable(donnees.table_id);
    await app.inject({ method: 'POST', url: `/api/commandes/${commandeId}/envoyer`, cookies: caissier });
    await app.inject({ method: 'POST', url: `/api/kds/commandes/${commandeId}/pret`, headers: kds });

    const avant = await app.inject({ method: 'GET', url: '/api/commandes/pretes', cookies: caissier });
    expect(avant.statusCode).toBe(200);
    expect((avant.json() as { commande_id: string }[]).map((c) => c.commande_id)).toContain(commandeId);

    // Servie par la CUISINE (pas par la caisse) : la caisse ne doit plus la voir.
    const servie = await app.inject({ method: 'POST', url: `/api/kds/commandes/${commandeId}/servir`, headers: kds });
    expect(servie.statusCode).toBe(200);

    const apres = await app.inject({ method: 'GET', url: '/api/commandes/pretes', cookies: caissier });
    expect((apres.json() as { commande_id: string }[]).map((c) => c.commande_id)).not.toContain(commandeId);
  });
});
