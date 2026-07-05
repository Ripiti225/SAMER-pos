/**
 * CORRECTIONS3 point 4 — état de table DÉRIVÉ, SOURCE UNIQUE côté serveur,
 * identique sur la caisse, la tablette serveur et le téléphone client.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { TableClientVue, TableVue } from '@pos/shared';
import { construireApp } from '../src/app.js';
import { fermerDb } from '../src/db/client.js';
import {
  JETON_KDS,
  PIN_CAISSIER,
  PIN_SERVEUR,
  resetDonnees,
  seConnecter,
  type Donnees,
} from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookiesServeur: Record<string, string>;
let cookiesCaissier: Record<string, string>;

const kds = { 'x-jeton-kds': JETON_KDS };

async function etatCaisse(tableId: string): Promise<TableVue> {
  const rep = await app.inject({ method: 'GET', url: '/api/tables', cookies: cookiesCaissier });
  return (rep.json() as TableVue[]).find((t) => t.id === tableId)!;
}
async function etatServeur(tableId: string): Promise<TableVue> {
  const rep = await app.inject({ method: 'GET', url: '/api/tables', cookies: cookiesServeur });
  return (rep.json() as TableVue[]).find((t) => t.id === tableId)!;
}
async function etatClient(qr: string): Promise<TableClientVue['etat']> {
  const rep = await app.inject({ method: 'GET', url: `/api/client/${qr}` });
  return (rep.json() as TableClientVue).etat;
}

/** Vérifie que les 3 surfaces montrent le MÊME état au même instant. */
async function memeEtatPartout(): Promise<string> {
  const [caisse, serveur, client] = await Promise.all([
    etatCaisse(donnees.table_id),
    etatServeur(donnees.table_id),
    etatClient(donnees.table_qr),
  ]);
  expect(serveur.etat).toBe(caisse.etat);
  expect(client).toBe(caisse.etat);
  return caisse.etat;
}

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookiesServeur = await seConnecter(app, donnees.serveur_id, PIN_SERVEUR);
  cookiesCaissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  await app.inject({ method: 'POST', url: '/api/services/ouvrir', cookies: cookiesCaissier, payload: { fond_de_caisse: 25000 } });
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('état dérivé identique sur caisse / serveur / client', () => {
  it('table libre au départ', async () => {
    expect(await memeEtatPartout()).toBe('LIBRE');
  });

  it('proposition client → « commande client à valider » partout', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/client/${donnees.table_qr}/commande`,
      payload: { items: [{ article_id: donnees.article_id, quantite: 1, options: [], supplements: [] }] },
    });
    expect(await memeEtatPartout()).toBe('COMMANDE_CLIENT_A_VALIDER');
  });

  it('validation → « en préparation » partout', async () => {
    const aValider = await app.inject({ method: 'GET', url: '/api/commandes/a-valider', cookies: cookiesServeur });
    const commandeId = (aValider.json() as { id: string }[])[0]!.id;
    await app.inject({ method: 'POST', url: `/api/commandes/${commandeId}/valider`, cookies: cookiesServeur });
    expect(await memeEtatPartout()).toBe('EN_PREPARATION');
  });

  it('KDS prête → « prête » ; badge Prête présent', async () => {
    const kdsVue = await app.inject({ method: 'GET', url: '/api/kds/commandes', headers: kds });
    const carte = (kdsVue.json() as { en_cuisine: { id: string; table_numero: string | null }[] }).en_cuisine.find(
      (c) => c.table_numero === 'T1',
    )!;
    await app.inject({ method: 'POST', url: `/api/kds/commandes/${carte.id}/pret`, headers: kds });
    expect(await memeEtatPartout()).toBe('PRETE');
    expect((await etatCaisse(donnees.table_id)).badges).toContain('PRETE');
  });

  it('appel serveur → badge Appel s’ajoute (priorité visuelle), état principal conservé', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/client/${donnees.table_qr}/appel`,
      payload: { type: 'APPEL_SERVEUR' },
    });
    const caisse = await etatCaisse(donnees.table_id);
    expect(caisse.badges[0]).toBe('APPEL'); // Appel > Facture > Prête
  });

  it('encaissement final → table Libre partout, appels/badges effacés', async () => {
    // Servir puis encaisser
    const detail = await app.inject({ method: 'GET', url: '/api/tables', cookies: cookiesCaissier });
    const table = (detail.json() as TableVue[]).find((t) => t.id === donnees.table_id)!;
    const vue = await app.inject({ method: 'GET', url: `/api/commandes/${table.commande_id}`, cookies: cookiesCaissier });
    const total = vue.json().total as number;

    await app.inject({
      method: 'POST',
      url: `/api/commandes/${table.commande_id}/paiements`,
      cookies: cookiesCaissier,
      payload: { mode: 'ESPECES', montant: total },
    });

    expect(await memeEtatPartout()).toBe('LIBRE');
    const finale = await etatCaisse(donnees.table_id);
    expect(finale.badges).toHaveLength(0);
    expect(finale.ouverte_par).toBeNull();
  });
});
