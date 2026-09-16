/**
 * Régression confidentialité QR : le QR permanent identifie la table, tandis
 * qu'un jeton de visite distinct borne les commandes et reçus d'un téléphone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { SuiviCommandeClient } from '@pos/shared';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { commandes, parametresLocaux } from '../src/db/schema/index.js';
import { PIN_CAISSIER, PIN_SERVEUR, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookiesCaissier: Record<string, string>;
let cookiesServeur: Record<string, string>;

beforeAll(async () => {
  app = await construireApp();
});

beforeEach(async () => {
  donnees = await resetDonnees();
  cookiesCaissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  cookiesServeur = await seConnecter(app, donnees.serveur_id, PIN_SERVEUR);
  const service = await app.inject({
    method: 'POST',
    url: '/api/services/ouvrir',
    cookies: cookiesCaissier,
    payload: { fond_de_caisse: 25000 },
  });
  expect(service.statusCode, service.body).toBe(200);
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

async function creerVisite(
  qr = donnees.table_qr,
  localisation?: { latitude: number; longitude: number; precision_metres: number },
): Promise<string> {
  const rep = await app.inject({
    method: 'POST',
    url: `/api/client/${qr}/visite`,
    payload: localisation ? { localisation } : {},
  });
  expect(rep.statusCode, rep.body).toBe(200);
  return (rep.json() as { visite_id: string }).visite_id;
}

async function commander(visiteId: string, qr = donnees.table_qr): Promise<string> {
  const rep = await app.inject({
    method: 'POST',
    url: `/api/client/${qr}/commande`,
    headers: { 'x-visite-qr': visiteId },
    payload: {
      items: [{ article_id: donnees.article_id, quantite: 1, options: [], supplements: [] }],
    },
  });
  expect(rep.statusCode, rep.body).toBe(200);
  return (rep.json() as { commande_id: string }).commande_id;
}

async function validerEtEncaisser(commandeId: string): Promise<void> {
  const validation = await app.inject({
    method: 'POST',
    url: `/api/commandes/${commandeId}/valider`,
    cookies: cookiesServeur,
  });
  expect(validation.statusCode, validation.body).toBe(200);
  const total = (validation.json() as { total: number }).total;
  const paiement = await app.inject({
    method: 'POST',
    url: `/api/commandes/${commandeId}/paiements`,
    cookies: cookiesCaissier,
    payload: { mode: 'ESPECES', montant: total },
  });
  expect(paiement.statusCode, paiement.body).toBe(200);
}

describe('visite QR isolée par téléphone', () => {
  it('une nouvelle visite ne voit ni la commande payée ni le reçu de la visite précédente', async () => {
    const visiteA = await creerVisite();
    const commandeA = await commander(visiteA);
    await validerEtEncaisser(commandeA);

    const visiteB = await creerVisite();
    const suiviB = await app.inject({
      method: 'GET',
      url: `/api/client/${donnees.table_qr}/commandes`,
      headers: { 'x-visite-qr': visiteB },
    });
    expect(suiviB.statusCode, suiviB.body).toBe(200);
    expect(suiviB.json()).toEqual([]);

    const recuB = await app.inject({
      method: 'GET',
      url: `/api/client/${donnees.table_qr}/recu/${commandeA}`,
      headers: { 'x-visite-qr': visiteB },
    });
    expect(recuB.statusCode).toBe(404);

    const recuA = await app.inject({
      method: 'GET',
      url: `/api/client/${donnees.table_qr}/recu/${commandeA}`,
      headers: { 'x-visite-qr': visiteA },
    });
    expect(recuA.statusCode, recuA.body).toBe(200);
    expect(recuA.headers['content-type']).toContain('application/pdf');
  });

  it('une commande saisie uniquement par la caisse reste invisible au QR de la table', async () => {
    const [commandeCaisse] = await db.insert(commandes).values({
      type: 'SUR_PLACE',
      table_id: donnees.table_id,
      origine: 'CAISSE',
      statut: 'PAYEE',
      total: 0,
    }).returning({ id: commandes.id });
    const visite = await creerVisite();

    const suivi = await app.inject({
      method: 'GET',
      url: `/api/client/${donnees.table_qr}/commandes`,
      headers: { 'x-visite-qr': visite },
    });
    expect(suivi.statusCode, suivi.body).toBe(200);
    expect(suivi.json() as SuiviCommandeClient[]).toEqual([]);

    const recu = await app.inject({
      method: 'GET',
      url: `/api/client/${donnees.table_qr}/recu/${commandeCaisse!.id}`,
      headers: { 'x-visite-qr': visite },
    });
    expect(recu.statusCode).toBe(404);
  });

  it('la visite courante peut créer une nouvelle commande après avoir payé', async () => {
    const visite = await creerVisite();
    const premiere = await commander(visite);
    await validerEtEncaisser(premiere);

    const suivante = await commander(visite);
    expect(suivante).not.toBe(premiere);
  });
});

describe('rayon géographique du QR', () => {
  beforeEach(async () => {
    await db.insert(parametresLocaux).values([
      { cle: 'client_qr_geolocalisation_activee', valeur: true },
      { cle: 'client_qr_latitude', valeur: 5.3364 },
      { cle: 'client_qr_longitude', valeur: -4.0267 },
      { cle: 'client_qr_rayon_metres', valeur: 50 },
    ]).onConflictDoUpdate({
      target: parametresLocaux.cle,
      set: { valeur: parametresLocaux.valeur },
    });
  });

  it('autorise une position située dans les 50 mètres', async () => {
    const visite = await creerVisite(donnees.table_qr, {
      latitude: 5.3364,
      longitude: -4.0267,
      precision_metres: 10,
    });
    expect(visite).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('refuse aussi la commande si le client s’éloigne après avoir ouvert la visite', async () => {
    const visite = await creerVisite(donnees.table_qr, {
      latitude: 5.3364,
      longitude: -4.0267,
      precision_metres: 10,
    });
    const rep = await app.inject({
      method: 'POST',
      url: `/api/client/${donnees.table_qr}/commande`,
      headers: { 'x-visite-qr': visite },
      payload: {
        items: [{ article_id: donnees.article_id, quantite: 1, options: [], supplements: [] }],
        localisation: {
          latitude: 5.3464,
          longitude: -4.0267,
          precision_metres: 10,
        },
      },
    });
    expect(rep.statusCode).toBe(403);
    expect(rep.json().erreur).toContain('trop loin');
  });

  it('refuse une position située au-delà des 50 mètres', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: `/api/client/${donnees.table_qr}/visite`,
      payload: {
        localisation: {
          latitude: 5.3464,
          longitude: -4.0267,
          precision_metres: 10,
        },
      },
    });
    expect(rep.statusCode).toBe(403);
    expect(rep.json().erreur).toContain('trop loin');
  });

  it('refuse une visite sans position lorsque le contrôle est activé', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: `/api/client/${donnees.table_qr}/visite`,
      payload: {},
    });
    expect(rep.statusCode).toBe(400);
    expect(rep.json().erreur).toContain('position');
  });
});
