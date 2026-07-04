import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { auditLog, utilisateurs } from '../src/db/schema/index.js';
import { PIN_CAISSIER, resetDonnees, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('verrouillage PIN (§14.1)', () => {
  it('refuse un mauvais PIN avec un message en français', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { utilisateur_id: donnees.caissier_id, pin: '9999' },
    });
    expect(rep.statusCode).toBe(401);
    expect(rep.json().erreur).toBe('PIN incorrect');
  });

  it('verrouille 30 s après 5 échecs, même avec le bon PIN, et audite chaque échec', async () => {
    for (let i = 0; i < 4; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { utilisateur_id: donnees.caissier_id, pin: '9999' },
      });
    }
    // 5e échec (1 + 4) → verrou
    const [u] = await db.select().from(utilisateurs).where(eq(utilisateurs.id, donnees.caissier_id));
    expect(u!.tentatives_pin).toBe(5);
    expect(u!.verrou_jusqua).not.toBeNull();
    expect(u!.verrou_jusqua!.getTime()).toBeGreaterThan(Date.now());
    expect(u!.verrou_jusqua!.getTime()).toBeLessThanOrEqual(Date.now() + 31_000);

    // Le bon PIN est refusé tant que le verrou court
    const rep = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { utilisateur_id: donnees.caissier_id, pin: PIN_CAISSIER },
    });
    expect(rep.statusCode).toBe(423);
    expect(rep.json().erreur).toMatch(/bloqué \d+ seconde/);

    const echecs = await db.select().from(auditLog).where(eq(auditLog.action, 'ECHEC_PIN'));
    expect(echecs.length).toBe(5);
  });

  it('reconnecte après expiration du verrou et remet le compteur à zéro', async () => {
    // On fait expirer le verrou artificiellement
    await db
      .update(utilisateurs)
      .set({ verrou_jusqua: new Date(Date.now() - 1000) })
      .where(eq(utilisateurs.id, donnees.caissier_id));

    const rep = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { utilisateur_id: donnees.caissier_id, pin: PIN_CAISSIER },
    });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().utilisateur.role).toBe('CAISSIER');

    const [u] = await db.select().from(utilisateurs).where(eq(utilisateurs.id, donnees.caissier_id));
    expect(u!.tentatives_pin).toBe(0);
    expect(u!.verrou_jusqua).toBeNull();
  });

  it('passe au palier 60 s après 10 échecs', async () => {
    await db
      .update(utilisateurs)
      .set({ tentatives_pin: 9, verrou_jusqua: null })
      .where(eq(utilisateurs.id, donnees.caissier_id));

    const rep = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { utilisateur_id: donnees.caissier_id, pin: '9999' },
    });
    expect(rep.statusCode).toBe(423);
    expect(rep.json().erreur).toBe('Ce PIN est bloqué 60 secondes');
  });
});
