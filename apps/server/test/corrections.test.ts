/** Tests des corrections post-test terrain (docs/CORRECTIONS.md). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { parametresLocaux } from '../src/db/schema/index.js';
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
