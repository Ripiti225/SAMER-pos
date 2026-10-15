/**
 * Supprimer le dernier produit d'une table ferme aussi sa commande. La ligne
 * reste en base pour l'audit et les retours cuisine, mais elle ne doit plus
 * retenir la table sur le plan de salle.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { CommandeVue, TableVue } from '@pos/shared';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { commandeItems, commandes } from '../src/db/schema/index.js';
import { PIN_CAISSIER, PIN_MANAGER, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;

async function creerTableAvecProduit(tableId: string): Promise<CommandeVue> {
  const creation = await app.inject({
    method: 'POST',
    url: '/api/commandes',
    cookies,
    payload: { type: 'SUR_PLACE', table_id: tableId },
  });
  expect(creation.statusCode).toBe(200);
  const id = (creation.json() as CommandeVue).id;
  const ajout = await app.inject({
    method: 'POST',
    url: `/api/commandes/${id}/items`,
    cookies,
    payload: { article_id: donnees.article_id, quantite: 1, options: [], supplements: [] },
  });
  expect(ajout.statusCode).toBe(200);
  return ajout.json() as CommandeVue;
}

async function lireTable(tableId: string): Promise<TableVue> {
  const rep = await app.inject({ method: 'GET', url: '/api/tables', cookies });
  expect(rep.statusCode).toBe(200);
  return (rep.json() as TableVue[]).find((table) => table.id === tableId)!;
}

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  const service = await app.inject({
    method: 'POST',
    url: '/api/services/ouvrir',
    cookies,
    payload: { fond_de_caisse: 25000 },
  });
  expect(service.statusCode).toBe(200);
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('annulation du dernier produit d’une table', () => {
  it('ferme la commande et libère la table avant tout envoi en cuisine', async () => {
    const commande = await creerTableAvecProduit(donnees.table_id);
    expect((await lireTable(donnees.table_id)).etat).toBe('OCCUPEE');

    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande.id}/items/${commande.items[0]!.id}/annuler`,
      cookies,
      payload: { motif: 'Erreur de frappe' },
    });

    expect(rep.statusCode).toBe(200);
    expect(rep.json()).toMatchObject({ statut: 'ANNULEE', total: 0, reste: 0 });
    expect((await lireTable(donnees.table_id)).etat).toBe('LIBRE');

    const [enBase] = await db.select().from(commandes).where(eq(commandes.id, commande.id));
    const [ligne] = await db.select().from(commandeItems).where(eq(commandeItems.id, commande.items[0]!.id));
    expect(enBase!.statut).toBe('ANNULEE');
    expect(ligne!.statut_cuisine).toBe('ANNULE');
  });

  it('libère aussi la table après un envoi, avec le PIN manager requis', async () => {
    const commande = await creerTableAvecProduit(donnees.table2_id);
    const envoi = await app.inject({ method: 'POST', url: `/api/commandes/${commande.id}/envoyer`, cookies });
    expect(envoi.statusCode).toBe(200);

    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande.id}/items/${commande.items[0]!.id}/annuler`,
      cookies,
      payload: { motif: 'Erreur confirmée en cuisine', pin_manager: PIN_MANAGER },
    });

    expect(rep.statusCode).toBe(200);
    expect(rep.json().statut).toBe('ANNULEE');
    expect((await lireTable(donnees.table2_id)).etat).toBe('LIBRE');
  });
});
