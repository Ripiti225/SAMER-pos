/**
 * État dérivé d'une table avec une commande CAISSE encore OUVERTE (prise mais
 * pas envoyée en cuisine) : la table doit apparaître OCCUPEE, jamais LIBRE —
 * sinon une table avec une commande en cours (visible dans Mes ventes) semble
 * libre au personnel.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { TableVue } from '@pos/shared';
import { construireApp } from '../src/app.js';
import { fermerDb } from '../src/db/client.js';
import { PIN_CAISSIER, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;

async function etatTable(): Promise<TableVue> {
  const rep = await app.inject({ method: 'GET', url: '/api/tables', cookies });
  return (rep.json() as TableVue[]).find((t) => t.id === donnees.table_id)!;
}

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  await app.inject({ method: 'POST', url: '/api/services/ouvrir', cookies, payload: { fond_de_caisse: 25000 } });
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('Table avec commande caisse OUVERTE', () => {
  it('table vide au départ → LIBRE', async () => {
    expect((await etatTable()).etat).toBe('LIBRE');
  });

  it('commande sur place prise (OUVERTE, pas encore en cuisine) → OCCUPEE', async () => {
    const c = await app.inject({
      method: 'POST',
      url: '/api/commandes',
      cookies,
      payload: { type: 'SUR_PLACE', table_id: donnees.table_id },
    });
    const id = c.json().id as string;
    await app.inject({
      method: 'POST',
      url: `/api/commandes/${id}/items`,
      cookies,
      payload: { article_id: donnees.article_id, quantite: 1, options: [], supplements: [] },
    });
    const t = await etatTable();
    expect(t.etat).toBe('OCCUPEE');
    expect(t.commande_id).toBe(id); // la table pointe bien sur la commande en cours
  });

  it('envoi en cuisine → EN_PREPARATION', async () => {
    const t = await etatTable();
    await app.inject({ method: 'POST', url: `/api/commandes/${t.commande_id}/envoyer`, cookies });
    expect((await etatTable()).etat).toBe('EN_PREPARATION');
  });

  it('encaissement → LIBRE', async () => {
    const t = await etatTable();
    const vue = await app.inject({ method: 'GET', url: `/api/commandes/${t.commande_id}`, cookies });
    const total = vue.json().total as number;
    await app.inject({
      method: 'POST',
      url: `/api/commandes/${t.commande_id}/paiements`,
      cookies,
      payload: { mode: 'ESPECES', montant: total },
    });
    expect((await etatTable()).etat).toBe('LIBRE');
  });
});
