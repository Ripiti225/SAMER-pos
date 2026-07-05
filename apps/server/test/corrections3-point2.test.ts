/**
 * CORRECTIONS3 point 2 — sonnerie serveur quand sa commande est prête,
 * bouton « Servie », repli caisse si le serveur est déconnecté.
 */
import type { AddressInfo } from 'node:net';
import { setTimeout as attendre } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
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
let baseUrl: string;

const kds = { 'x-jeton-kds': JETON_KDS };

async function ecouteur(cookie?: string): Promise<{ socket: WebSocket; recu: Record<string, unknown>[] }> {
  const options = cookie ? { headers: { cookie: `pos_session=${cookie}` } } : undefined;
  const socket = new WebSocket(`${baseUrl}/ws`, options);
  const recu: Record<string, unknown>[] = [];
  socket.on('message', (b) => recu.push(JSON.parse(b.toString())));
  await new Promise<void>((res, rej) => {
    socket.once('open', () => res());
    socket.once('error', rej);
  });
  if (cookie) {
    socket.send(JSON.stringify({ type: 'heartbeat' }));
    await attendre(50);
  }
  return { socket, recu };
}

/** Commande de table prise par le serveur, envoyée en cuisine. */
async function commandeServeurEnCuisine(tableId: string): Promise<string> {
  const rep = await app.inject({
    method: 'POST',
    url: '/api/serveur/envoyer',
    cookies: cookiesServeur,
    payload: {
      action_uuid: crypto.randomUUID(),
      table_id: tableId,
      items: [{ article_id: donnees.article_id, quantite: 1, options: [], supplements: [] }],
    },
  });
  return rep.json().commande_id as string;
}

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  cookiesServeur = await seConnecter(app, donnees.serveur_id, PIN_SERVEUR);
  cookiesCaissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  await app.inject({ method: 'POST', url: '/api/services/ouvrir', cookies: cookiesCaissier, payload: { fond_de_caisse: 25000 } });
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('KDS Prête → notification du serveur rattaché', () => {
  it('sonne le serveur propriétaire connecté (cible SERVEUR) puis « Servie » passe à SERVIE', async () => {
    const serveur = await ecouteur(cookiesServeur.pos_session!); // présent (heartbeat)
    const commandeId = await commandeServeurEnCuisine(donnees.table_id);

    const pret = await app.inject({ method: 'POST', url: `/api/kds/commandes/${commandeId}/pret`, headers: kds });
    expect(pret.statusCode).toBe(200);
    await attendre(100);

    const pretes = serveur.recu.filter((e) => e.type === 'commande:prete');
    expect(pretes).toHaveLength(1);
    expect(pretes[0]!.cible).toBe('SERVEUR');
    expect(pretes[0]!.serveur_id).toBe(donnees.serveur_id);
    expect(pretes[0]!.table_numero).toBe('T1');

    // « Servie » (bouton tablette) → SERVIE
    const servir = await app.inject({ method: 'POST', url: `/api/commandes/${commandeId}/servir`, cookies: cookiesServeur });
    expect(servir.statusCode).toBe(200);
    expect(servir.json().statut).toBe('SERVIE');

    serveur.socket.close();
    await attendre(50);
  });

  it('repli caisse : serveur déconnecté → la notification prête cible la CAISSE', async () => {
    // Aucun socket serveur ouvert → serveur non présent
    const observateur = await ecouteur(); // écoute passive (broadcast)
    const commandeId = await commandeServeurEnCuisine(donnees.table2_id);

    await app.inject({ method: 'POST', url: `/api/kds/commandes/${commandeId}/pret`, headers: kds });
    await attendre(100);

    const pretes = observateur.recu.filter((e) => e.type === 'commande:prete');
    expect(pretes).toHaveLength(1);
    expect(pretes[0]!.cible).toBe('CAISSE');
    observateur.socket.close();
    await attendre(50);
  });

  it('« Servie » est refusé si la commande n’est pas prête', async () => {
    const commandeId = await commandeServeurEnCuisine(donnees.table_id);
    const rep = await app.inject({ method: 'POST', url: `/api/commandes/${commandeId}/servir`, cookies: cookiesServeur });
    expect(rep.statusCode).toBe(409);
  });
});
