/**
 * Table ouverte PAR ERREUR — aucun produit tapé.
 *
 * Le caissier ouvre une table (il s'est trompé de numéro, le client repart…)
 * et ressort sans rien commander : la table doit rester LIBRE. Une commande
 * sans aucun article n'occupe rien — ni le plan de salle, ni la propriété de
 * table. Sortir de l'écran l'abandonne pour de bon (statut ANNULEE, numéro de
 * ticket conservé : la séquence ne fait jamais de trou).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { TableVue } from '@pos/shared';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { commandes } from '../src/db/schema/index.js';
import { PIN_CAISSIER, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;

async function etatTable(): Promise<TableVue> {
  const rep = await app.inject({ method: 'GET', url: '/api/tables', cookies });
  return (rep.json() as TableVue[]).find((t) => t.id === donnees.table_id)!;
}

async function ouvrirLaTable(): Promise<string> {
  const rep = await app.inject({
    method: 'POST',
    url: '/api/commandes',
    cookies,
    payload: { type: 'SUR_PLACE', table_id: donnees.table_id },
  });
  expect(rep.statusCode).toBe(200);
  return rep.json().id as string;
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

describe('Table ouverte sans aucun produit', () => {
  it('reste LIBRE tant qu’aucun article n’est tapé', async () => {
    await ouvrirLaTable();
    const t = await etatTable();
    expect(t.etat).toBe('LIBRE');
    expect(t.commande_id).toBeNull();
    expect(t.commandes_ouvertes).toHaveLength(0);
    // Personne ne doit être bloqué par une table ouverte par erreur.
    expect(t.ouverte_par).toBeNull();
  });

  it('la rouvrir REPREND la commande vide au lieu d’en créer une seconde', async () => {
    const premiere = await ouvrirLaTable();
    const seconde = await ouvrirLaTable();
    expect(seconde).toBe(premiere);
  });

  it('un article tapé occupe enfin la table', async () => {
    const id = await ouvrirLaTable();
    await app.inject({
      method: 'POST',
      url: `/api/commandes/${id}/items`,
      cookies,
      payload: { article_id: donnees.article_id, quantite: 1, options: [], supplements: [] },
    });
    const t = await etatTable();
    expect(t.etat).toBe('OCCUPEE');
    expect(t.commande_id).toBe(id);
  });

  it('abandonner refuse de toucher une commande qui a des articles', async () => {
    const t = await etatTable();
    const rep = await app.inject({ method: 'POST', url: `/api/commandes/${t.commande_id}/abandonner`, cookies });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().abandonnee).toBe(false);
    expect((await etatTable()).etat).toBe('OCCUPEE');
  });
});

describe('Sortie de l’écran commande sans rien taper', () => {
  it('abandonne la commande vide (ANNULEE, numéro conservé) et libère la table', async () => {
    // On repart d'une table propre : la précédente porte encore un article.
    const rep = await app.inject({ method: 'GET', url: '/api/tables', cookies });
    const table2 = (rep.json() as TableVue[]).find((t) => t.id === donnees.table2_id)!;
    expect(table2.etat).toBe('LIBRE');

    const creation = await app.inject({
      method: 'POST',
      url: '/api/commandes',
      cookies,
      payload: { type: 'SUR_PLACE', table_id: donnees.table2_id },
    });
    const id = creation.json().id as string;

    const abandon = await app.inject({ method: 'POST', url: `/api/commandes/${id}/abandonner`, cookies });
    expect(abandon.statusCode).toBe(200);
    expect(abandon.json().abandonnee).toBe(true);

    const [c] = await db.select().from(commandes).where(eq(commandes.id, id));
    expect(c!.statut).toBe('ANNULEE');
    expect(Number(c!.numero_ticket)).toBeGreaterThan(0); // le numéro reste, pas de trou

    const apres = await app.inject({ method: 'GET', url: '/api/tables', cookies });
    const t2 = (apres.json() as TableVue[]).find((t) => t.id === donnees.table2_id)!;
    expect(t2.etat).toBe('LIBRE');
    expect(t2.statut).toBe('LIBRE'); // statut physique relâché, propriétaire effacé
    expect(t2.ouverte_par).toBeNull();
  });

  it('l’abandon est sans effet une seconde fois (idempotent)', async () => {
    const creation = await app.inject({
      method: 'POST',
      url: '/api/commandes',
      cookies,
      payload: { type: 'SUR_PLACE', table_id: donnees.table2_id },
    });
    const id = creation.json().id as string;
    await app.inject({ method: 'POST', url: `/api/commandes/${id}/abandonner`, cookies });
    const rejeu = await app.inject({ method: 'POST', url: `/api/commandes/${id}/abandonner`, cookies });
    expect(rejeu.statusCode).toBe(200);
    expect(rejeu.json().abandonnee).toBe(false);
  });
});
