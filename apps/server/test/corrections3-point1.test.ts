/**
 * CORRECTIONS3 point 1 — circuit client ↔ serveur avec repli caisse.
 * Principe testé : la cuisine n'est JAMAIS contactée par un client sans
 * validation (serveur ou caisse).
 */
import type { AddressInfo } from 'node:net';
import { setTimeout as attendre } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import type { KdsVue } from '@pos/shared';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { commandes } from '../src/db/schema/index.js';
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

/** Ouvre une connexion WS authentifiée (cookie serveur) avec heartbeat. */
async function connecterServeurWs(cookie: string): Promise<{ socket: WebSocket; recu: unknown[] }> {
  const socket = new WebSocket(`${baseUrl}/ws`, { headers: { cookie: `pos_session=${cookie}` } });
  const recu: unknown[] = [];
  socket.on('message', (b) => recu.push(JSON.parse(b.toString())));
  await new Promise<void>((res, rej) => {
    socket.once('open', () => res());
    socket.once('error', rej);
  });
  socket.send(JSON.stringify({ type: 'heartbeat' })); // présence
  await attendre(50);
  return { socket, recu };
}

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  cookiesServeur = await seConnecter(app, donnees.serveur_id, PIN_SERVEUR);
  cookiesCaissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  await app.inject({
    method: 'POST',
    url: '/api/services/ouvrir',
    cookies: cookiesCaissier,
    payload: { fond_de_caisse: 25000 },
  });
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('appel client : routage vers le serveur présent', () => {
  it('« Appeler le serveur » notifie le serveur connecté (cible SERVEUR)', async () => {
    const serveur = await connecterServeurWs(cookiesServeur.pos_session!);

    const rep = await app.inject({
      method: 'POST',
      url: `/api/client/${donnees.table_qr}/appel`,
      payload: { type: 'APPEL_SERVEUR' },
    });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().confirmation).toBe('Votre serveur arrive');
    expect(rep.json().cible).toBe('SERVEUR');
    await attendre(80);

    const appels = serveur.recu.filter((e): e is { type: string; cible: string; serveur_id: string } =>
      (e as { type: string }).type === 'appel:nouveau',
    );
    expect(appels).toHaveLength(1);
    expect(appels[0]!.cible).toBe('SERVEUR');
    expect(appels[0]!.serveur_id).toBe(donnees.serveur_id);
    serveur.socket.close();
    await attendre(50);
  });

  it('anti-doublon : re-taper ne crée pas un 2e appel EN_ATTENTE', async () => {
    // (le premier appel APPEL_SERVEUR est encore EN_ATTENTE)
    await attendre(8100); // dépasse le limiteur de débit
    const rep = await app.inject({
      method: 'POST',
      url: `/api/client/${donnees.table_qr}/appel`,
      payload: { type: 'APPEL_SERVEUR' },
    });
    expect(rep.statusCode).toBe(200);
    const enAttente = await app.inject({ method: 'GET', url: '/api/appels/en-attente', cookies: cookiesCaissier });
    const pourTable = (enAttente.json() as { table_id: string; type: string }[]).filter(
      (a) => a.table_id === donnees.table_id && a.type === 'APPEL_SERVEUR',
    );
    expect(pourTable).toHaveLength(1);
  }, 15000);
});

describe('repli caisse : aucun serveur connecté', () => {
  it('l’appel arrive à la CAISSE (cible CAISSE) quand aucun serveur n’est présent', async () => {
    // Aucune connexion WS serveur ouverte ici → pas de présence
    const rep = await app.inject({
      method: 'POST',
      url: `/api/client/${donnees.table2_qr}/appel`,
      payload: { type: 'APPEL_SERVEUR' },
    });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().cible).toBe('CAISSE');
  });

  it('une commande client sans serveur connecté est routée CAISSE et N’EST PAS en cuisine', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: `/api/client/${donnees.table2_qr}/commande`,
      payload: { items: [{ article_id: donnees.article_id, quantite: 1, options: [], supplements: [] }] },
    });
    expect(rep.statusCode).toBe(200);
    const commandeId = rep.json().commande_id as string;

    // La commande existe mais reste une proposition (origine CLIENT_QR, OUVERTE)
    const [c] = await db.select().from(commandes).where(eq(commandes.id, commandeId));
    expect(c!.origine).toBe('CLIENT_QR');
    expect(c!.statut).toBe('OUVERTE');

    // GARANTIE : elle n'apparaît PAS sur le KDS tant qu'elle n'est pas validée
    const kds = await app.inject({ method: 'GET', url: '/api/kds/commandes', headers: { 'x-jeton-kds': JETON_KDS } });
    const surKds = (kds.json() as KdsVue).en_cuisine.some((carte) => carte.id === commandeId);
    expect(surKds).toBe(false);

    // La caisse (repli) la voit dans « à valider »
    const aValider = await app.inject({ method: 'GET', url: '/api/commandes/a-valider', cookies: cookiesCaissier });
    expect((aValider.json() as { id: string }[]).some((x) => x.id === commandeId)).toBe(true);
  });

  it('la validation (caisse) est la SEULE porte vers la cuisine', async () => {
    const proposition = await app.inject({
      method: 'POST',
      url: `/api/client/${donnees.table2_qr}/commande`,
      payload: { items: [{ article_id: donnees.article_id, quantite: 2, options: [], supplements: [] }] },
    });
    const commandeId = proposition.json().commande_id as string;

    const kdsAvant = await app.inject({ method: 'GET', url: '/api/kds/commandes', headers: { 'x-jeton-kds': JETON_KDS } });
    expect((kdsAvant.json() as KdsVue).en_cuisine.some((c) => c.id === commandeId)).toBe(false);

    const valide = await app.inject({ method: 'POST', url: `/api/commandes/${commandeId}/valider`, cookies: cookiesCaissier });
    expect(valide.statusCode).toBe(200);
    expect(valide.json().statut).toBe('ENVOYEE_CUISINE');

    const kdsApres = await app.inject({ method: 'GET', url: '/api/kds/commandes', headers: { 'x-jeton-kds': JETON_KDS } });
    expect((kdsApres.json() as KdsVue).en_cuisine.some((c) => c.id === commandeId)).toBe(true);
  });

  it('le refus passe la commande à Refusée avec un message pour le client', async () => {
    const proposition = await app.inject({
      method: 'POST',
      url: `/api/client/${donnees.table2_qr}/commande`,
      payload: { items: [{ article_id: donnees.article_id, quantite: 1, options: [], supplements: [] }] },
    });
    const commandeId = proposition.json().commande_id as string;

    const refus = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commandeId}/refuser`,
      cookies: cookiesCaissier,
      payload: { motif: 'Article épuisé ce soir' },
    });
    expect(refus.statusCode).toBe(200);

    const suivi = await app.inject({ method: 'GET', url: `/api/client/${donnees.table2_qr}/commandes` });
    const ligne = (suivi.json() as { id: string; etat: string; refus_motif: string }[]).find((x) => x.id === commandeId);
    expect(ligne!.etat).toBe('REFUSEE');
    expect(ligne!.refus_motif).toBe('Article épuisé ce soir');
  });
});

describe('portée du token QR : une table ne voit QUE ses commandes', () => {
  it('le suivi du QR de la table 2 ne contient aucune commande de la table 1', async () => {
    // Une commande client sur la table 1
    const surT1 = await app.inject({
      method: 'POST',
      url: `/api/client/${donnees.table_qr}/commande`,
      payload: { items: [{ article_id: donnees.article_id, quantite: 1, options: [], supplements: [] }] },
    });
    const idT1 = surT1.json().commande_id as string;

    const suiviT2 = await app.inject({ method: 'GET', url: `/api/client/${donnees.table2_qr}/commandes` });
    expect((suiviT2.json() as { id: string }[]).some((x) => x.id === idT1)).toBe(false);

    const suiviT1 = await app.inject({ method: 'GET', url: `/api/client/${donnees.table_qr}/commandes` });
    expect((suiviT1.json() as { id: string }[]).some((x) => x.id === idT1)).toBe(true);
  });

  it('un token QR inconnu renvoie 404', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/client/JETON-BIDON/commandes' });
    expect(rep.statusCode).toBe(404);
  });
});
