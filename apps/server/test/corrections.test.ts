/** Tests des corrections post-test terrain (docs/CORRECTIONS.md). */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setTimeout as attendre } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { parametresLocaux } from '../src/db/schema/index.js';
import { PIN_CAISSIER, PIN_SERVEUR, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;
let cookiesServeur: Record<string, string>;

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  cookiesServeur = await seConnecter(app, donnees.serveur_id, PIN_SERVEUR);
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('correction 1 — délai de verrouillage caisse configurable (10 min par défaut)', () => {
  it('renvoie 600 s par défaut quand le paramètre est absent', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/auth/moi', cookies });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().verrouillage_inactivite_secondes).toBe(600);
  });

  it('lit la valeur définie par le manager dans parametres_locaux', async () => {
    await db
      .insert(parametresLocaux)
      .values({ cle: 'verrou_inactivite_caisse_secondes', valeur: 900 })
      .onConflictDoUpdate({ target: parametresLocaux.cle, set: { valeur: 900 } });

    const rep = await app.inject({ method: 'GET', url: '/api/auth/moi', cookies });
    expect(rep.json().verrouillage_inactivite_secondes).toBe(900);
  });

  it('le déverrouillage par PIN ne touche ni à la session ni au service', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/services/ouvrir',
      cookies,
      payload: { fond_de_caisse: 10000 },
    });

    const rep = await app.inject({
      method: 'POST',
      url: '/api/auth/deverrouiller',
      cookies,
      payload: { pin: PIN_CAISSIER },
    });
    expect(rep.statusCode).toBe(200);

    // La session est toujours valable et le service toujours OUVERT
    const moi = await app.inject({ method: 'GET', url: '/api/auth/moi', cookies });
    expect(moi.statusCode).toBe(200);
    expect(moi.json().service_ouvert).not.toBeNull();
  });
});

describe('correction 2 — la demande d’addition alerte la caisse (WebSocket)', () => {
  it('émet « table:addition_demandee » une seule fois, jamais au rejeu idempotent', async () => {
    // Commande en cours sur la table T1 (prise tablette)
    const envoi = await app.inject({
      method: 'POST',
      url: '/api/serveur/envoyer',
      cookies: cookiesServeur,
      payload: {
        action_uuid: randomUUID(),
        table_id: donnees.table_id,
        items: [{ article_id: donnees.article_id, quantite: 1, options: [], supplements: [] }],
      },
    });
    expect(envoi.statusCode).toBe(200);

    // Écoute WebSocket réelle (comme la caisse)
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const evenements: { type: string; id: string | null }[] = [];
    socket.on('message', (brut) => {
      evenements.push(JSON.parse(brut.toString()) as { type: string; id: string | null });
    });
    await new Promise<void>((resoudre, rejeter) => {
      socket.once('open', () => resoudre());
      socket.once('error', rejeter);
    });

    const actionUuid = randomUUID();
    const rep = await app.inject({
      method: 'POST',
      url: '/api/serveur/addition',
      cookies: cookiesServeur,
      payload: { action_uuid: actionUuid, table_id: donnees.table_id },
    });
    expect(rep.statusCode).toBe(200);
    await attendre(150);

    const additions = evenements.filter((e) => e.type === 'table:addition_demandee');
    expect(additions).toHaveLength(1);
    expect(additions[0]!.id).toBe(donnees.table_id);

    // Rejeu (coupure WiFi) : aucune nouvelle alerte — le son ne sonne qu'une fois
    const rejeu = await app.inject({
      method: 'POST',
      url: '/api/serveur/addition',
      cookies: cookiesServeur,
      payload: { action_uuid: actionUuid, table_id: donnees.table_id },
    });
    expect(rejeu.json().deja_traitee).toBe(true);
    await attendre(150);
    expect(evenements.filter((e) => e.type === 'table:addition_demandee')).toHaveLength(1);

    socket.close();
  });
});
