import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { auditLog, commandes } from '../src/db/schema/index.js';
import {
  ouvrirServiceEtCommande,
  PIN_CAISSIER,
  PIN_CAISSIER2,
  resetDonnees,
  seConnecter,
  validerInventaire,
  type Donnees,
} from './aide.js';

/**
 * Le code court (« EM215 ») n'est unique QUE dans un service. Deux commandes
 * nées dans deux shifts différents peuvent donc porter le même code ; le jour
 * où elles atterrissent dans le même service (relève, puis ouverture du
 * receveur), l'index `uniq_code_commande_service` refusait le rattachement et
 * l'ouverture de service tombait en erreur — la caisse était bloquée.
 */

let app: FastifyInstance;
let donnees: Donnees;
let cookiesA: Record<string, string>;
let premiere: string;
let seconde: string;

async function transfererVersB(): Promise<void> {
  const rep = await app.inject({
    method: 'POST',
    url: '/api/services/transferer',
    cookies: cookiesA,
    payload: { receveur_id: donnees.caissier2_id, pin_receveur: PIN_CAISSIER2 },
  });
  if (rep.statusCode !== 200) throw new Error(`Transfert: ${rep.body}`);
  await validerInventaire(app, cookiesA);
  const cloture = await app.inject({
    method: 'POST',
    url: '/api/services/cloturer',
    cookies: cookiesA,
    payload: { especes_comptees: 25000 },
  });
  if (cloture.statusCode !== 200) throw new Error(`Clôture: ${cloture.body}`);
}

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookiesA = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);

  // Shift 1 de A : une commande, relevée par B.
  premiere = (await ouvrirServiceEtCommande(app, cookiesA, donnees, 1)).commande_id;
  await transfererVersB();

  // Shift 2 de A : une autre commande, à qui le hasard donne LE MÊME code.
  seconde = (await ouvrirServiceEtCommande(app, cookiesA, donnees, 1)).commande_id;
  const [p] = await db.select().from(commandes).where(eq(commandes.id, premiere));
  await db.update(commandes).set({ code_commande: p!.code_commande }).where(eq(commandes.id, seconde));
  await transfererVersB();
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('code court en double lors d’un rattachement à un service', () => {
  it('le receveur ouvre son service malgré deux commandes transférées au même code', async () => {
    const cookiesB = await seConnecter(app, donnees.caissier2_id, PIN_CAISSIER2);
    const ouverture = await app.inject({
      method: 'POST',
      url: '/api/services/ouvrir',
      cookies: cookiesB,
      payload: { fond_de_caisse: 10000 },
    });
    expect(ouverture.statusCode).toBe(200);
    const serviceB = ouverture.json().id as string;

    const lignes = await db.select().from(commandes).where(inArray(commandes.id, [premiere, seconde]));
    expect(lignes.map((c) => c.service_id)).toEqual([serviceB, serviceB]);
    const codes = lignes.map((c) => c.code_commande);
    expect(new Set(codes).size).toBe(2);

    // Le changement de code est tracé : la cuisine a pu imprimer l'ancien.
    const traces = await db.select().from(auditLog).where(eq(auditLog.action, 'CHANGEMENT_CODE_COMMANDE'));
    expect(traces.length).toBe(1);
    const meta = traces[0]!.meta as { ancien: string; nouveau: string };
    expect(meta.ancien).not.toBe(meta.nouveau);
    expect(codes).toContain(meta.nouveau);
  });
});
