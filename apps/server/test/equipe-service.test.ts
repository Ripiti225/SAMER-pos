/**
 * Allègement — « Équipe du jour » : à l'ouverture de service, on enregistre les
 * présents et leur poste du jour (info + remontée outbox). Le poste peut être
 * ajusté (ex : Willy barman → comptoiriste aujourd'hui).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { equipeService, syncOutbox } from '../src/db/schema/index.js';
import { PIN_CAISSIER, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('équipe du jour à l’ouverture de service', () => {
  it('propose les employés actifs avec un poste par défaut', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/services/equipe-proposee', cookies });
    expect(rep.statusCode).toBe(200);
    const props = rep.json() as { utilisateur_id: string; poste_defaut: string }[];
    expect(props.length).toBeGreaterThan(0);
    const cuisinier = props.find((p) => p.utilisateur_id === donnees.cuisine_id);
    expect(cuisinier!.poste_defaut).toBe('CUISINIER');
  });

  it('enregistre l’équipe et son poste du jour, avec remontée outbox', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: '/api/services/ouvrir',
      cookies,
      payload: {
        fond_de_caisse: 25000,
        equipe: [
          { utilisateur_id: donnees.serveur_id, poste_jour: 'COMPTOIRISTE' }, // ajusté
          { utilisateur_id: donnees.cuisine_id, poste_jour: 'CUISINIER' },
        ],
      },
    });
    expect(rep.statusCode).toBe(200);
    const serviceId = rep.json().id as string;

    const membres = await db.select().from(equipeService).where(eq(equipeService.service_id, serviceId));
    expect(membres.length).toBe(2);
    expect(membres.find((m) => m.utilisateur_id === donnees.serveur_id)!.poste_jour).toBe('COMPTOIRISTE');

    const outbox = await db.select().from(syncOutbox).where(eq(syncOutbox.table_name, 'equipe_service'));
    expect(outbox.length).toBe(2);
  });

  it('accepte une ouverture sans équipe (rétrocompatible)', async () => {
    const c2 = await seConnecter(app, donnees.caissier2_id, '4826');
    const rep = await app.inject({ method: 'POST', url: '/api/services/ouvrir', cookies: c2, payload: { fond_de_caisse: 10000 } });
    expect(rep.statusCode).toBe(200);
  });

  it('refuse un poste hors liste (validation avant tout)', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: '/api/services/ouvrir',
      cookies,
      payload: { fond_de_caisse: 5000, equipe: [{ utilisateur_id: donnees.serveur_id, poste_jour: 'PATRON' }] },
    });
    expect(rep.statusCode).toBe(400);
  });
});
