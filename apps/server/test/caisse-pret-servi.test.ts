/**
 * La CAISSE marque « Prêt » et « Servi » (2026-10-15) : comme le cuisinier,
 * le caissier peut dire qu'une commande est prête — le serveur est sonné de
 * la même façon — et la marquer servie, même sans passer par « Prêt ».
 */
import type { AddressInfo } from 'node:net';
import { setTimeout as attendre } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import type { CommandeVue } from '@pos/shared';
import { construireApp } from '../src/app.js';
import { fermerDb } from '../src/db/client.js';
import { PIN_CAISSIER, PIN_SERVEUR, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let serveur: Record<string, string>;
let caissier: Record<string, string>;
let baseUrl: string;

async function ecouteurServeur(): Promise<{ socket: WebSocket; recu: Record<string, unknown>[] }> {
  const socket = new WebSocket(`${baseUrl}/ws`, { headers: { cookie: `pos_session=${serveur.pos_session}` } });
  const recu: Record<string, unknown>[] = [];
  socket.on('message', (b) => recu.push(JSON.parse(b.toString())));
  await new Promise<void>((res, rej) => {
    socket.once('open', () => res());
    socket.once('error', rej);
  });
  socket.send(JSON.stringify({ type: 'heartbeat' })); // présent : c'est lui qu'on sonne
  await attendre(50);
  return { socket, recu };
}

async function enCuisine(tableId: string): Promise<string> {
  const rep = await app.inject({
    method: 'POST',
    url: '/api/serveur/envoyer',
    cookies: serveur,
    payload: {
      action_uuid: crypto.randomUUID(),
      table_id: tableId,
      items: [{ article_id: donnees.article_id, quantite: 1, options: [], supplements: [] }],
    },
  });
  return rep.json().commande_id as string;
}

const caisse = (id: string, action: 'pret' | 'servir', cookies = caissier) =>
  app.inject({ method: 'POST', url: `/api/caisse/commandes/${id}/${action}`, cookies, payload: {} });

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  serveur = await seConnecter(app, donnees.serveur_id, PIN_SERVEUR);
  caissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  await app.inject({ method: 'POST', url: '/api/services/ouvrir', cookies: caissier, payload: { fond_de_caisse: 25000 } });
});
afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('le caissier marque Prêt puis Servi', () => {
  it('« Prêt » à la caisse sonne le serveur, comme depuis la cuisine', async () => {
    const { socket, recu } = await ecouteurServeur();
    const id = await enCuisine(donnees.table_id);

    const pret = await caisse(id, 'pret');
    expect(pret.statusCode).toBe(200);
    const vue = pret.json() as CommandeVue;
    expect(vue.statut).toBe('PRETE');
    expect(vue.items.every((i) => i.statut_cuisine === 'PRET')).toBe(true);

    await attendre(100);
    const sonnerie = recu.find((m) => m.type === 'commande:prete' && m.commande_id === id);
    expect(sonnerie).toMatchObject({ cible: 'SERVEUR', serveur_id: donnees.serveur_id });
    socket.close();

    const servie = await caisse(id, 'servir');
    expect(servie.json().statut).toBe('SERVIE');
  });

  it('« Servi » directement depuis « en cuisine », sans passer par « Prêt »', async () => {
    const id = await enCuisine(donnees.table2_id);
    const servie = await caisse(id, 'servir');
    expect(servie.statusCode).toBe(200);
    const vue = servie.json() as CommandeVue;
    expect(vue.statut).toBe('SERVIE');
    // La carte quitte l'écran cuisine : plus aucun article « en préparation ».
    expect(vue.items.every((i) => i.statut_cuisine === 'PRET')).toBe(true);
  });

  it('refuse « Prêt » sur une commande qui n’est plus en cuisine', async () => {
    const id = await enCuisine(donnees.table_id);
    await caisse(id, 'servir');
    const r = await caisse(id, 'pret');
    expect(r.statusCode).toBe(409);
    expect(r.json().erreur).toContain('pas en cuisine');
  });

  it('un serveur ne passe pas par ces routes de caisse', async () => {
    const id = await enCuisine(donnees.table2_id);
    expect((await caisse(id, 'pret', serveur)).statusCode).toBe(403);
  });
});
