import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { auditLog } from '../src/db/schema/index.js';
import {
  ouvrirServiceEtCommande,
  PIN_CAISSIER,
  PIN_MANAGER,
  resetDonnees,
  seConnecter,
  type Donnees,
} from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;
let commandeId: string;

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  const c = await ouvrirServiceEtCommande(app, cookies, donnees, 2); // 6000 F
  commandeId = c.commande_id;
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('remise : PIN manager + motif obligatoires', () => {
  it('rejette une remise sans motif', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commandeId}/remise`,
      cookies,
      payload: { montant: 1000, pin_manager: PIN_MANAGER },
    });
    expect(rep.statusCode).toBe(400);
    expect(rep.json().erreur).toContain('motif');
  });

  it('rejette une remise avec un PIN non-manager (celui du caissier)', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commandeId}/remise`,
      cookies,
      payload: { montant: 1000, motif: 'Client fidèle', pin_manager: PIN_CAISSIER },
    });
    expect(rep.statusCode).toBe(403);
    expect(rep.json().erreur).toBe('PIN manager incorrect');
  });

  it('applique la remise avec PIN manager + motif, trace dans audit_log', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commandeId}/remise`,
      cookies,
      payload: { montant: 1000, motif: 'Client fidèle', pin_manager: PIN_MANAGER },
    });
    expect(rep.statusCode).toBe(200);
    const vue = rep.json();
    expect(vue.remise_montant).toBe(1000);
    expect(vue.total).toBe(5000);

    const entrees = await db.select().from(auditLog).where(eq(auditLog.action, 'REMISE'));
    expect(entrees.length).toBe(1);
    expect(entrees[0]!.montant).toBe(1000);
    expect(entrees[0]!.motif).toBe('Client fidèle');
    expect(entrees[0]!.user_id).toBe(donnees.manager_id);
  });

  it('refuse une remise supérieure au montant de la commande', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commandeId}/remise`,
      cookies,
      payload: { montant: 99000, motif: 'Erreur volontaire', pin_manager: PIN_MANAGER },
    });
    expect(rep.statusCode).toBe(400);
  });
});
