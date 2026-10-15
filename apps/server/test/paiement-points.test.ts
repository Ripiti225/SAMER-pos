/**
 * Paiement avec les points fidélité (mode POINTS, décision du 2026-10-15) :
 * tout en points ou rien — jamais mélangé avec un autre mode —, débite les points, ne
 * rapporte pas de points, et apparaît à part au ticket Z — dans la vente,
 * jamais dans le tiroir.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { auditLog, clientsFidelite, pointsFidelite, syncEtat } from '../src/db/schema/index.js';
import { PIN_CAISSIER, resetDonnees, seConnecter, validerInventaire, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;
const RICHE = '0769000001'; // 1 000 points = 10 000 F
const PAUVRE = '0769000002'; // 60 points = 600 F

async function commande(nb = 1): Promise<string> {
  const c = await app.inject({ method: 'POST', url: '/api/commandes', cookies, payload: { type: 'EMPORTER' } });
  const id = c.json().id as string;
  await app.inject({
    method: 'POST',
    url: `/api/commandes/${id}/items`,
    cookies,
    payload: { article_id: donnees.article_id, quantite: nb, options: [], supplements: [] },
  });
  return id;
}

async function rattacher(id: string, telephone: string): Promise<void> {
  const r = await app.inject({ method: 'POST', url: `/api/commandes/${id}/fidelite`, cookies, payload: { telephone } });
  expect(r.statusCode).toBe(200);
}

async function solde(telephone: string): Promise<number> {
  const [c] = await db.select().from(clientsFidelite).where(eq(clientsFidelite.telephone, telephone));
  const [r] = await db
    .select({ s: sql<string>`COALESCE(SUM(${pointsFidelite.points}),0)` })
    .from(pointsFidelite)
    .where(eq(pointsFidelite.client_id, c!.id));
  return Number(r!.s);
}

const payer = (id: string, mode: string, montant: number) =>
  app.inject({ method: 'POST', url: `/api/commandes/${id}/paiements`, cookies, payload: { mode, montant } });

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  await app.inject({ method: 'POST', url: '/api/services/ouvrir', cookies, payload: { fond_de_caisse: 25000 } });
  // Descente cloud récente : le solde est vérifiable (règle des 24 h).
  await db.insert(syncEtat).values({ flux: 'CATALOGUE', version: 1, synced_at: new Date() });
  for (const [telephone, points] of [[RICHE, 1000], [PAUVRE, 60]] as const) {
    const id = crypto.randomUUID();
    await db.insert(clientsFidelite).values({ id, telephone });
    await db.insert(pointsFidelite).values({ client_id: id, points, source: 'POS' });
  }
});
afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('paiement avec les points', () => {
  it('montre le solde, les points gagnés et le solde après paiement', async () => {
    const id = await commande(2); // 6 000 F
    await rattacher(id, RICHE);
    const r = await app.inject({ method: 'GET', url: `/api/commandes/${id}/client`, cookies });
    expect(r.statusCode).toBe(200);
    const info = r.json();
    expect(info.client.telephone).toBe(RICHE);
    expect(info.solde).toBe(1000);
    expect(info.points_gagnes).toBe(6); // 1 pt / 1 000 F
    expect(info.solde_apres).toBe(1006);
    expect(info.paiement_points).toMatchObject({ possible: true, points_necessaires: 600, solde_apres: 400 });
    // Le ticket reste ouvert pour le test suivant.
    const pay = await payer(id, 'POINTS', 6000);
    expect(pay.statusCode).toBe(200);
    expect(pay.json().statut).toBe('PAYEE');
  });

  it('débite les points, ne crédite rien et trace l’audit', async () => {
    expect(await solde(RICHE)).toBe(400); // 1 000 − 600, aucun gain sur un achat en points
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'PAIEMENT_POINTS'));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.montant).toBe(6000);
  });

  it('refuse une partie seulement en points', async () => {
    const id = await commande(1); // 3 000 F
    await rattacher(id, RICHE);
    const r = await payer(id, 'POINTS', 1000);
    expect(r.statusCode).toBe(400);
    expect(r.json().erreur).toContain('tout le montant');
    await payer(id, 'ESPECES', 3000);
  });

  it('refuse si le solde ne couvre pas le reste', async () => {
    const id = await commande(1); // 3 000 F = 300 pts, il en a 60
    await rattacher(id, PAUVRE);
    const info = (await app.inject({ method: 'GET', url: `/api/commandes/${id}/client`, cookies })).json();
    expect(info.paiement_points.possible).toBe(false);
    const r = await payer(id, 'POINTS', 3000);
    expect(r.statusCode).toBe(409);
    expect(r.json().erreur).toContain('Solde insuffisant');
    await payer(id, 'ESPECES', 3000); // solde le ticket pour la clôture
  });

  it('refuse sans client rattaché', async () => {
    const id = await commande(1);
    const r = await payer(id, 'POINTS', 3000);
    expect(r.statusCode).toBe(409);
    expect(r.json().erreur).toContain('numéro du client');
    await payer(id, 'ESPECES', 3000);
  });

  it('refuse les points dès qu’un autre mode a commencé : jamais d’espèces + points', async () => {
    const id = await commande(1); // 3 000 F
    await rattacher(id, RICHE);
    expect((await payer(id, 'ESPECES', 1000)).statusCode).toBe(200);
    const info = (await app.inject({ method: 'GET', url: `/api/commandes/${id}/client`, cookies })).json();
    expect(info.paiement_points.possible).toBe(false);
    const r = await payer(id, 'POINTS', 2000);
    expect(r.statusCode).toBe(409);
    expect(r.json().erreur).toContain('déjà commencé');
    expect((await payer(id, 'WAVE', 2000)).json().statut).toBe('PAYEE');
    // Aucun point débité : 400 + 3 (ticket soldé en espèces plus haut) + 3 (celui-ci)
    expect(await solde(RICHE)).toBe(406);
  });

  it('ticket Z : « payé en points » compte dans la vente, pas dans le tiroir', async () => {
    await validerInventaire(app, cookies);
    // Espèces : 3 000 × 3 + 1 000 = 10 000 → théorique 35 000 ; Wave 2 000.
    const rep = await app.inject({
      method: 'POST',
      url: '/api/services/cloturer',
      cookies,
      // Une caisse qui déclarerait aussi POINTS ne doit pas le compter deux fois.
      payload: { especes_comptees: 35000, modes: { WAVE: 2000, POINTS: 6000 } },
    });
    expect(rep.statusCode).toBe(200);
    const z = rep.json();
    expect(z.especes_theorique).toBe(35000);
    expect(z.ecart).toBe(0);
    expect(z.paye_points).toEqual({ nb: 1, total: 6000 });
    expect(z.par_mode.POINTS).toBe(6000);
    expect(z.modes_declares).not.toHaveProperty('POINTS');
    expect(z.total_ventes).toBe(18000);
    expect(z.vente_totale).toBe(18000); // 10 000 espèces + 2 000 Wave + 6 000 points
    expect(z.diff).toBe(0);
  });
});
