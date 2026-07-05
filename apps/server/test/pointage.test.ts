/**
 * SPRINT 4 A — Pointage : PIN au POS, géolocalisation, SMS, présences,
 * correction, départ oublié, et attribution cuisine réelle (A4).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { auditLog, commandeItems, pointages } from '../src/db/schema/index.js';
import {
  JETON_KDS,
  PIN_CAISSIER,
  PIN_CUISINE,
  PIN_MANAGER,
  resetDonnees,
  seConnecter,
  type Donnees,
} from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
const TEL_CUISINE = '+2250700000007';

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
});
afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('A1 — PIN au POS (hors ligne, sans session)', () => {
  it('enregistre l’arrivée puis, au 2e passage, le départ', async () => {
    const arr = await app.inject({
      method: 'POST',
      url: '/api/pointage/pin',
      payload: { utilisateur_id: donnees.cuisine_id, pin: PIN_CUISINE },
    });
    expect(arr.statusCode).toBe(200);
    expect(arr.json().action).toBe('ARRIVEE');
    expect(arr.json().message).toContain('Bonjour');

    const dep = await app.inject({
      method: 'POST',
      url: '/api/pointage/pin',
      payload: { utilisateur_id: donnees.cuisine_id, pin: PIN_CUISINE },
    });
    expect(dep.json().action).toBe('DEPART');

    // PIN faux → refus
    const faux = await app.inject({
      method: 'POST',
      url: '/api/pointage/pin',
      payload: { utilisateur_id: donnees.cuisine_id, pin: '9999' },
    });
    expect(faux.statusCode).toBe(401);
  });
});

describe('A2 — Géolocalisation (vérif côté serveur)', () => {
  it('accepte dans le rayon, refuse hors rayon avec la distance', async () => {
    const dedans = await app.inject({
      method: 'POST',
      url: '/api/pointage/geoloc',
      payload: { telephone: TEL_CUISINE, pin: PIN_CUISINE, lat: 5.395, lng: -3.984 },
    });
    expect(dedans.statusCode).toBe(200);
    expect(dedans.json().action).toBe('ARRIVEE');

    const loin = await app.inject({
      method: 'POST',
      url: '/api/pointage/geoloc',
      payload: { telephone: TEL_CUISINE, pin: PIN_CUISINE, lat: 5.5, lng: -3.984 },
    });
    expect(loin.statusCode).toBe(403);
    expect(loin.json().erreur).toMatch(/trop loin.*à \d+ m/);

    // remet à zéro le pointage ouvert pour les tests suivants
    await db.update(pointages).set({ depart: new Date() }).where(and(eq(pointages.user_id, donnees.cuisine_id), isNull(pointages.depart)));
  });
});

describe('A3 — SMS (mode console)', () => {
  it('envoie un code, puis le valide → pointage', async () => {
    const original = console.log;
    let codeSms = '';
    console.log = (...args: unknown[]) => {
      const m = args.join(' ').match(/pointage : (\d{6})/);
      if (m) codeSms = m[1]!;
    };
    try {
      const demande = await app.inject({
        method: 'POST',
        url: '/api/pointage/sms/demander',
        payload: { telephone: TEL_CUISINE },
      });
      expect(demande.statusCode).toBe(200);
      expect(codeSms).toMatch(/^\d{6}$/);
    } finally {
      console.log = original;
    }

    const mauvais = await app.inject({
      method: 'POST',
      url: '/api/pointage/sms/valider',
      payload: { telephone: TEL_CUISINE, code: '000000' },
    });
    // (très improbable que le code aléatoire soit 000000)
    if (codeSms !== '000000') expect(mauvais.statusCode).toBe(401);

    const bon = await app.inject({
      method: 'POST',
      url: '/api/pointage/sms/valider',
      payload: { telephone: TEL_CUISINE, code: codeSms },
    });
    expect(bon.statusCode).toBe(200);
    expect(bon.json().action).toBe('ARRIVEE');
    await db.update(pointages).set({ depart: new Date() }).where(and(eq(pointages.user_id, donnees.cuisine_id), isNull(pointages.depart)));
  });
});

describe('A4 — attribution réelle basée sur les pointages', () => {
  it('un pizzaiolo NON pointé ne se voit pas attribuer la pizza', async () => {
    const cookiesServeur = await seConnecter(app, donnees.serveur_id, '1357');

    // Repart d'un état propre : aucun pointage cuisine ouvert
    await db.update(pointages).set({ depart: new Date() }).where(isNull(pointages.depart));
    // Seul le cuisinier pointe ; le pizzaiolo NON
    await app.inject({ method: 'POST', url: '/api/pointage/pin', payload: { utilisateur_id: donnees.cuisine_id, pin: PIN_CUISINE } });

    const envoi = await app.inject({
      method: 'POST',
      url: '/api/serveur/envoyer',
      cookies: cookiesServeur,
      payload: {
        action_uuid: crypto.randomUUID(),
        table_id: donnees.table_id,
        items: [
          { article_id: donnees.article_id, quantite: 1, options: [], supplements: [] },
          { article_id: donnees.pizza_id, quantite: 1, options: [], supplements: [] },
        ],
      },
    });
    const commandeId = envoi.json().commande_id as string;
    await app.inject({ method: 'POST', url: `/api/kds/commandes/${commandeId}/pret`, headers: { 'x-jeton-kds': JETON_KDS } });

    const items = await db.select().from(commandeItems).where(eq(commandeItems.commande_id, commandeId));
    const chawarma = items.find((i) => i.article_id === donnees.article_id)!;
    const pizza = items.find((i) => i.article_id === donnees.pizza_id)!;
    expect(chawarma.attribue_a).toEqual([donnees.cuisine_id]); // cuisinier pointé
    expect(pizza.attribue_a).toEqual([]); // pizzaiolo non pointé → vide
  });
});

describe('A4 — présences, correction, départ oublié', () => {
  it('les présences sont réservées au manager (caissier → 403)', async () => {
    const cookiesCaissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
    const cookiesManager = await seConnecter(app, donnees.manager_id, PIN_MANAGER);

    const refuse = await app.inject({ method: 'GET', url: '/api/pointage/presences', cookies: cookiesCaissier });
    expect(refuse.statusCode).toBe(403);

    const ok = await app.inject({ method: 'GET', url: '/api/pointage/presences', cookies: cookiesManager });
    expect(ok.statusCode).toBe(200);
    expect(Array.isArray(ok.json())).toBe(true);
  });

  it('la clôture du dernier service ferme les pointages oubliés (depart_oublie)', async () => {
    // État propre : ferme tout pointage encore ouvert (des tests précédents)
    await db.update(pointages).set({ depart: new Date() }).where(isNull(pointages.depart));
    const cookiesCaissier = await seConnecter(app, donnees.caissier2_id, '4826');
    await app.inject({ method: 'POST', url: '/api/services/ouvrir', cookies: cookiesCaissier, payload: { fond_de_caisse: 10000 } });

    // Le cuisinier pointe et « oublie » de repartir
    await app.inject({ method: 'POST', url: '/api/pointage/pin', payload: { utilisateur_id: donnees.cuisine_id, pin: PIN_CUISINE } });

    // Clôture (aucune commande en cours pour ce service)
    const cloture = await app.inject({ method: 'POST', url: '/api/services/cloturer', cookies: cookiesCaissier, payload: { especes_comptees: 10000 } });
    expect(cloture.statusCode).toBe(200);

    const [p] = await db.select().from(pointages).where(eq(pointages.user_id, donnees.cuisine_id)).orderBy(pointages.arrivee);
    const oublie = (await db.select().from(pointages).where(and(eq(pointages.user_id, donnees.cuisine_id), eq(pointages.depart_oublie, true))))[0];
    expect(oublie).toBeDefined();
    expect(oublie!.depart).not.toBeNull();
    void p;

    // Correction manager (PIN + motif) → audit CORRECTION_POINTAGE
    const cookiesManager = await seConnecter(app, donnees.manager_id, PIN_MANAGER);
    const corr = await app.inject({
      method: 'POST',
      url: `/api/pointage/${oublie!.id}/corriger`,
      cookies: cookiesManager,
      payload: { depart: new Date().toISOString(), motif: 'Départ réel à 18h', pin_manager: PIN_MANAGER },
    });
    expect(corr.statusCode).toBe(200);
    const traces = await db.select().from(auditLog).where(eq(auditLog.action, 'CORRECTION_POINTAGE'));
    expect(traces.length).toBeGreaterThanOrEqual(1);
  });
});
