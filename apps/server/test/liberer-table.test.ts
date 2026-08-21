/**
 * LIBÉRER UNE TABLE depuis le plan de salle (2026-08-18).
 *
 * Il n'existait AUCUN moyen de rendre une table à la salle sans encaisser : ni
 * la table ouverte par erreur (rien de tapé), ni la table qui porte des
 * produits. La route de libération couvre les deux, et le serveur — pas
 * l'écran — décide du régime :
 *   - aucun article  → abandon simple, sans PIN ni motif ;
 *   - un article     → annulation de commande : PIN manager + motif, et les
 *                      plats déjà lancés en cuisine partent en RETOURS.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { CommandeEnCoursVue, TableVue } from '@pos/shared';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { auditLog, commandes } from '../src/db/schema/index.js';
import { PIN_CAISSIER, PIN_MANAGER, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;

async function table(id: string): Promise<TableVue> {
  const rep = await app.inject({ method: 'GET', url: '/api/tables', cookies });
  return (rep.json() as TableVue[]).find((t) => t.id === id)!;
}

/** Ouvre la table, y tape un article et l'envoie en cuisine. */
async function tableAvecPlatLance(tableId: string): Promise<string> {
  const creation = await app.inject({
    method: 'POST',
    url: '/api/commandes',
    cookies,
    payload: { type: 'SUR_PLACE', table_id: tableId },
  });
  const id = creation.json().id as string;
  await app.inject({
    method: 'POST',
    url: `/api/commandes/${id}/items`,
    cookies,
    payload: { article_id: donnees.article_id, quantite: 2, options: [], supplements: [] },
  });
  const envoi = await app.inject({ method: 'POST', url: `/api/commandes/${id}/envoyer`, cookies });
  expect(envoi.statusCode).toBe(200);
  return id;
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

describe('Table sans aucun produit', () => {
  it('se libère sans PIN ni motif, commande ANNULEE et numéro conservé', async () => {
    const creation = await app.inject({
      method: 'POST',
      url: '/api/commandes',
      cookies,
      payload: { type: 'SUR_PLACE', table_id: donnees.table2_id },
    });
    const id = creation.json().id as string;

    const rep = await app.inject({
      method: 'POST',
      url: `/api/caisse/tables/${donnees.table2_id}/liberer`,
      cookies,
      payload: {},
    });
    expect(rep.statusCode).toBe(200);
    expect(rep.json()).toMatchObject({ liberee: true, annulees: 0, abandonnees: 1 });

    const [c] = await db.select().from(commandes).where(eq(commandes.id, id));
    expect(c!.statut).toBe('ANNULEE');
    expect(Number(c!.numero_ticket)).toBeGreaterThan(0); // la séquence ne fait pas de trou

    const t = await table(donnees.table2_id);
    expect(t.etat).toBe('LIBRE');
    expect(t.statut).toBe('LIBRE');
    expect(t.ouverte_par).toBeNull();
  });

  it('libérer une table qui ne porte rien du tout reste sans effet', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: `/api/caisse/tables/${donnees.table2_id}/liberer`,
      cookies,
      payload: {},
    });
    expect(rep.statusCode).toBe(200);
    expect(rep.json()).toMatchObject({ liberee: true, annulees: 0, abandonnees: 0 });
    expect((await table(donnees.table2_id)).etat).toBe('LIBRE');
  });
});

describe('Table qui porte des produits', () => {
  it('refuse de se vider sans PIN manager', async () => {
    await tableAvecPlatLance(donnees.table_id);
    const rep = await app.inject({
      method: 'POST',
      url: `/api/caisse/tables/${donnees.table_id}/liberer`,
      cookies,
      payload: { motif: 'Client parti' },
    });
    expect(rep.statusCode).toBe(403);
    expect((await table(donnees.table_id)).etat).not.toBe('LIBRE');
  });

  it('refuse de se vider sans motif, PIN manager ou pas', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: `/api/caisse/tables/${donnees.table_id}/liberer`,
      cookies,
      payload: { pin_manager: PIN_MANAGER },
    });
    expect(rep.statusCode).toBe(400);
    expect((await table(donnees.table_id)).etat).not.toBe('LIBRE');
  });

  it('se vide au PIN manager + motif : table LIBRE, commande ANNULEE, trace d’audit', async () => {
    const avant = await table(donnees.table_id);
    const commandeId = avant.commande_id!;
    expect(commandeId).toBeTruthy();

    const rep = await app.inject({
      method: 'POST',
      url: `/api/caisse/tables/${donnees.table_id}/liberer`,
      cookies,
      payload: { pin_manager: PIN_MANAGER, motif: 'Client parti sans consommer' },
    });
    expect(rep.statusCode).toBe(200);
    expect(rep.json()).toMatchObject({ liberee: true, annulees: 1, abandonnees: 0 });

    const [c] = await db.select().from(commandes).where(eq(commandes.id, commandeId));
    expect(c!.statut).toBe('ANNULEE');

    const apres = await table(donnees.table_id);
    expect(apres.etat).toBe('LIBRE');
    expect(apres.statut).toBe('LIBRE');

    // La trace nomme le manager qui a autorisé : sans elle, vider une table
    // serait le moyen le plus simple de faire disparaître un plat produit.
    const journal = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entite_id, commandeId));
    const annulation = journal.find((l) => l.action === 'ANNULATION_COMMANDE');
    expect(annulation).toBeTruthy();
    expect(annulation!.motif).toBe('Client parti sans consommer');
    expect(annulation!.user_id).toBe(donnees.manager_id);
  });

  it('les plats déjà lancés apparaissent en RETOURS', async () => {
    const manager = await seConnecter(app, donnees.manager_id, PIN_MANAGER);
    const rep = await app.inject({ method: 'GET', url: '/api/rapports/retours-jour', cookies: manager });
    expect(rep.statusCode).toBe(200);
    const retours = rep.json() as { nb: number; montant: number; detail: { nom: string; motif: string | null }[] };
    expect(retours.nb).toBe(2); // les 2 chawarmas lancés en cuisine
    expect(retours.montant).toBe(6000);
    expect(retours.detail.some((d) => d.nom === 'Chawarma Poulet')).toBe(true);
  });
});

describe('Commandes en cours (toit des commandes à emporter)', () => {
  it('liste les commandes à emporter avec leur nombre d’articles', async () => {
    const creation = await app.inject({
      method: 'POST',
      url: '/api/commandes',
      cookies,
      payload: { type: 'EMPORTER' },
    });
    const id = creation.json().id as string;

    // Sans article : elle est listée à 0 ligne — les écrans l'écartent, comme
    // une table ouverte par erreur.
    let rep = await app.inject({ method: 'GET', url: '/api/commandes/ouvertes', cookies });
    let vide = (rep.json() as CommandeEnCoursVue[]).find((c) => c.id === id)!;
    expect(vide.nb_items).toBe(0);

    await app.inject({
      method: 'POST',
      url: `/api/commandes/${id}/items`,
      cookies,
      payload: { article_id: donnees.article_id, quantite: 1, options: [], supplements: [] },
    });

    rep = await app.inject({ method: 'GET', url: '/api/commandes/ouvertes', cookies });
    const emporter = (rep.json() as CommandeEnCoursVue[]).filter((c) => c.type === 'EMPORTER' && c.nb_items > 0);
    expect(emporter).toHaveLength(1);
    expect(emporter[0]!.id).toBe(id);
    expect(emporter[0]!.total).toBe(3000);
    expect(emporter[0]!.code_commande).toBeTruthy();
    expect(emporter[0]!.table_id).toBeNull();
  });
});
