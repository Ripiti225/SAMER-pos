/**
 * SPRINT 4 B — Fidélité : crédit au paiement, utilisation en remise, règle
 * des 24 h hors ligne, sync vers le cloud.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { CommandeVue } from '@pos/shared';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { auditLog, clientsFidelite, pointsFidelite, syncEtat, syncOutbox } from '../src/db/schema/index.js';
import { PIN_CAISSIER, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;
const TEL = '0701020304';

async function nouvelleCommande(montantItemx1 = 1): Promise<string> {
  const c = await app.inject({ method: 'POST', url: '/api/commandes', cookies, payload: { type: 'EMPORTER' } });
  const id = c.json().id as string;
  for (let i = 0; i < montantItemx1; i++) {
    await app.inject({
      method: 'POST',
      url: `/api/commandes/${id}/items`,
      cookies,
      payload: { article_id: donnees.article_id, quantite: 1, options: [], supplements: [] },
    });
  }
  return id;
}

async function clientId(): Promise<string> {
  const [c] = await db.select().from(clientsFidelite).where(eq(clientsFidelite.telephone, TEL));
  return c!.id;
}
async function definirDescente(ilYaMs: number): Promise<void> {
  await db.delete(syncEtat);
  await db.insert(syncEtat).values({ flux: 'CATALOGUE', version: 1, synced_at: new Date(Date.now() - ilYaMs) });
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

describe('crédit de points au paiement', () => {
  it('rattache un client par téléphone et crédite les points (barème 1 pt / 1000 F)', async () => {
    const id = await nouvelleCommande(1); // 3000 F

    const rattach = await app.inject({ method: 'POST', url: `/api/commandes/${id}/fidelite`, cookies, payload: { telephone: TEL } });
    expect(rattach.statusCode).toBe(200);

    const pay = await app.inject({ method: 'POST', url: `/api/commandes/${id}/paiements`, cookies, payload: { mode: 'ESPECES', montant: 3000 } });
    expect(pay.statusCode).toBe(200);
    expect(pay.json().statut).toBe('PAYEE');

    const cid = await clientId();
    const [r] = await db.select({ s: sql<string>`COALESCE(SUM(${pointsFidelite.points}),0)` }).from(pointsFidelite).where(eq(pointsFidelite.client_id, cid));
    expect(Number(r!.s)).toBe(3); // 3000 / 1000

    // Visible au paiement suivant
    const solde = await app.inject({ method: 'GET', url: `/api/fidelite/${TEL}`, cookies });
    expect(solde.json().existe).toBe(true);
    expect(solde.json().solde).toBe(3);

    // Le client et les points remontent au cloud
    const outClients = await db.select().from(syncOutbox).where(eq(syncOutbox.table_name, 'clients_fidelite'));
    const outPoints = await db.select().from(syncOutbox).where(eq(syncOutbox.table_name, 'points_fidelite'));
    expect(outClients.length).toBeGreaterThanOrEqual(1);
    expect(outPoints.length).toBeGreaterThanOrEqual(1);
  });
});

describe('utilisation de points en remise', () => {
  it('décrémente le solde et réduit le total (droit du client, sans PIN manager)', async () => {
    await definirDescente(60_000); // descente récente (< 24 h)
    const cid = await clientId();
    // On crédite un solde suffisant pour dépasser le seuil (50)
    await db.insert(pointsFidelite).values({ client_id: cid, points: 100, source: 'POS' });

    const id = await nouvelleCommande(1); // 3000 F
    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${id}/fidelite`,
      cookies,
      payload: { telephone: TEL, utiliser_points: 50 },
    });
    expect(rep.statusCode).toBe(200);
    const vue = rep.json().commande as CommandeVue;
    expect(vue.fidelite_montant).toBe(500); // 50 points × 10 F
    expect(vue.total).toBe(2500); // 3000 − 500

    // Solde décrémenté (3 crédités + 100 ajoutés − 50 utilisés = 53)
    expect(rep.json().solde).toBe(53);

    // Ligne négative + audit
    const [neg] = await db.select().from(pointsFidelite).where(eq(pointsFidelite.commande_id, id));
    expect(neg!.points).toBe(-50);
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'UTILISATION_POINTS'));
    expect(audits.length).toBe(1);

    // Encaissement du reste → crédit sur 2500
    const pay = await app.inject({ method: 'POST', url: `/api/commandes/${id}/paiements`, cookies, payload: { mode: 'ESPECES', montant: 2500 } });
    expect(pay.json().statut).toBe('PAYEE');
  });
});

describe('règle des 24 h hors ligne', () => {
  it('refuse l’utilisation si la dernière descente date de plus de 24 h', async () => {
    await definirDescente(25 * 3600 * 1000); // descente vieille de 25 h
    const id = await nouvelleCommande(1);
    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${id}/fidelite`,
      cookies,
      payload: { telephone: TEL, utiliser_points: 50 },
    });
    expect(rep.statusCode).toBe(409);
    expect(rep.json().erreur).toContain('Solde non vérifiable');
  });
});
