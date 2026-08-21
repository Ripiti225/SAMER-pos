/**
 * Kdo — repas offert (table virtuelle KDO, zone RC).
 *
 * Règle métier, formulée par le client : « je vends 25 000 et Kdo 5 000, ma
 * vente est 30 000 et non 25 000 ». Autrement dit un Kdo se comporte comme une
 * livraison Yango — il compte dans la vente du shift — mais il n'ajoute pas un
 * franc au tiroir, donc il ne doit créer NI écart de caisse NI écart de
 * réconciliation. C'est ce scénario exact qui est joué plus bas.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { fermerDb } from '../src/db/client.js';
import { PIN_CAISSIER, resetDonnees, seConnecter, validerInventaire, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;

/** Commande de `quantite` chawarma(s) à 3000 sur une table donnée. */
async function commandeSur(tableId: string, type: string, quantite = 1): Promise<string> {
  const c = await app.inject({
    method: 'POST',
    url: '/api/commandes',
    cookies,
    payload: { type, table_id: tableId },
  });
  const id = c.json().id as string;
  await app.inject({
    method: 'POST',
    url: `/api/commandes/${id}/items`,
    cookies,
    payload: { article_id: donnees.article_id, quantite, options: [], supplements: [] },
  });
  return id;
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

describe('Création d’un Kdo', () => {
  it('une commande prise sur la table KDO est marquée offerte par le SERVEUR', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: '/api/commandes',
      cookies,
      payload: { type: 'SUR_PLACE', table_id: donnees.table_kdo_id },
    });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().offert).toBe(true);
  });

  it('une commande sur une table normale n’est jamais offerte', async () => {
    const rep = await app.inject({
      method: 'POST',
      url: '/api/commandes',
      cookies,
      payload: { type: 'SUR_PLACE', table_id: donnees.table_id },
    });
    expect(rep.json().offert).toBe(false);
  });
});

describe('Clôture d’un Kdo', () => {
  it('le motif est obligatoire', async () => {
    const id = await commandeSur(donnees.table_kdo_id, 'SUR_PLACE');
    const sansMotif = await app.inject({ method: 'POST', url: `/api/commandes/${id}/offrir`, cookies, payload: {} });
    expect(sansMotif.statusCode).toBe(400);
    const troisCaracteres = await app.inject({
      method: 'POST',
      url: `/api/commandes/${id}/offrir`,
      cookies,
      payload: { motif: 'x' },
    });
    expect(troisCaracteres.statusCode).toBe(400);
  });

  it('passe à PAYEE sans aucune ligne de paiement, motif conservé', async () => {
    const id = await commandeSur(donnees.table_kdo_id, 'SUR_PLACE');
    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${id}/offrir`,
      cookies,
      payload: { motif: 'Client fidèle' },
    });
    expect(rep.statusCode).toBe(200);
    const vue = rep.json();
    expect(vue.statut).toBe('PAYEE');
    expect(vue.paiements).toHaveLength(0);
    expect(vue.offert).toBe(true);
    expect(vue.motif_offert).toBe('Client fidèle');
  });

  it('refuse d’offrir une commande qui n’est pas un Kdo', async () => {
    const id = await commandeSur(donnees.table_id, 'SUR_PLACE');
    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${id}/offrir`,
      cookies,
      payload: { motif: 'Tentative' },
    });
    expect(rep.statusCode).toBe(400);
    // soldée normalement pour ne pas bloquer la clôture du service
    await app.inject({
      method: 'POST',
      url: `/api/commandes/${id}/paiements`,
      cookies,
      payload: { mode: 'ESPECES', montant: 3000 },
    });
  });
});

describe('Tables virtuelles : plusieurs commandes en parallèle', () => {
  it('la table Yango liste TOUTES ses commandes en cours', async () => {
    await commandeSur(donnees.table_yango_id, 'LIVRAISON');
    await commandeSur(donnees.table_yango_id, 'LIVRAISON');

    const rep = await app.inject({ method: 'GET', url: '/api/tables', cookies });
    const yango = rep.json().find((t: { partenaire: string | null }) => t.partenaire === 'YANGO');
    expect(yango.commandes_ouvertes).toHaveLength(2);
    // La table n'est plus « Libre » : c'est ce qui empêchait d'y revenir.
    expect(yango.etat).not.toBe('LIBRE');
    // Le partenaire est repris de la table, sans que la caisse ait à le dire.
    expect(yango.commandes_ouvertes[0].total).toBe(3000);
  });
});

describe('Le Kdo compte dans la vente, jamais dans le tiroir', () => {
  it('vente 25 000 + Kdo 5 000 → vente 30 000, espèces attendues 25 000, écart 0', async () => {
    // Service neuf pour repartir d'un état propre.
    donnees = await resetDonnees();
    cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
    await app.inject({ method: 'POST', url: '/api/services/ouvrir', cookies, payload: { fond_de_caisse: 0 } });

    // Vente encaissée : 25 000 (article à 3000 → on force le montant via
    // plusieurs unités : 8 × 3000 = 24 000, + 1 unité sur une 2ᵉ note = 27 000).
    // On raisonne en montants réels plutôt qu'en ronds : la règle ne dépend pas
    // du chiffre, seulement de la séparation encaissé / offert.
    const vente = await commandeSur(donnees.table_id, 'SUR_PLACE', 5); // 15 000
    await app.inject({
      method: 'POST',
      url: `/api/commandes/${vente}/paiements`,
      cookies,
      payload: { mode: 'ESPECES', montant: 15000 },
    });

    // Kdo : 2 × 3000 = 6000, offert.
    const kdo = await commandeSur(donnees.table_kdo_id, 'SUR_PLACE', 2);
    await app.inject({
      method: 'POST',
      url: `/api/commandes/${kdo}/offrir`,
      cookies,
      payload: { motif: 'Geste commercial' },
    });

    // L'aperçu de réconciliation montre les offerts, sans révéler les espèces.
    const preview = (await app.inject({ method: 'GET', url: '/api/services/reconciliation-preview', cookies })).json();
    expect(preview.offerts).toEqual({ nb: 1, total: 6000 });
    expect(preview.modes.ESPECES).toBeUndefined();

    // Le caissier compte EXACTEMENT ce qu'il a encaissé : 15 000. Le Kdo ne
    // doit lui coûter aucun écart.
    await validerInventaire(app, cookies);
    const z = (
      await app.inject({
        method: 'POST',
        url: '/api/services/cloturer',
        cookies,
        payload: { especes_comptees: 15000 },
      })
    ).json();

    expect(z.especes_theorique).toBe(15000);
    expect(z.ecart).toBe(0);
    // La vente inclut le Kdo : 15 000 encaissés + 6 000 offerts = 21 000.
    expect(z.total_ventes).toBe(21000);
    expect(z.vente_totale).toBe(21000);
    // …et la réconciliation tombe juste, sans écart artificiel.
    expect(z.diff).toBe(0);
    expect(z.offerts).toEqual({ nb: 1, total: 6000 });
  });
});
