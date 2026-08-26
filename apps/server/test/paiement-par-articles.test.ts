import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { fermerDb } from '../src/db/client.js';
import { db } from '../src/db/client.js';
import { calculerStatsService } from '../src/modules/services/rapport.js';
import { construireFactureDisponible } from '../src/modules/commandes/service.js';
import { clientsFidelite, notesSplit, pointsFidelite, syncEtat } from '../src/db/schema/index.js';
import { auditLog } from '../src/db/schema/index.js';
import { and, eq } from 'drizzle-orm';
import { PIN_CAISSIER, PIN_MANAGER, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;
let serviceId: string;

async function ouvrirCommandeTable(quantite: number, tableId?: string) {
  const commande = await app.inject({
    method: 'POST',
    url: '/api/commandes',
    cookies,
    payload: tableId ? { type: 'SUR_PLACE', table_id: tableId } : { type: 'EMPORTER' },
  });
  expect(commande.statusCode).toBe(200);
  const id = commande.json().id as string;
  const ajout = await app.inject({
    method: 'POST',
    url: `/api/commandes/${id}/items`,
    cookies,
    payload: { article_id: donnees.article_id, quantite, options: [], supplements: [] },
  });
  expect(ajout.statusCode).toBe(200);
  return ajout.json();
}

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  const service = await app.inject({
    method: 'POST',
    url: '/api/services/ouvrir',
    cookies,
    payload: { fond_de_caisse: 25_000 },
  });
  expect(service.statusCode).toBe(200);
  serviceId = service.json().id;
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('paiement par articles', () => {
  it('réserve une quantité précise et empêche de la sélectionner deux fois', async () => {
    const commande = await ouvrirCommandeTable(3);
    const item = commande.items[0];

    const creation = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande.id}/sous-notes`,
      cookies,
      payload: { items: [{ commande_item_id: item.id, quantite: 1 }] },
    });
    expect(creation.statusCode).toBe(200);
    const vue = creation.json();
    expect(vue.notes).toHaveLength(1);
    expect(vue.notes[0]).toMatchObject({ numero: 1, statut: 'A_PAYER', sous_total: 3000, montant: 3000 });
    expect(vue.items[0]).toMatchObject({ quantite: 3, quantite_reservee: 1, quantite_payee: 0, quantite_disponible: 2 });

    const depassement = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande.id}/sous-notes`,
      cookies,
      payload: { items: [{ commande_item_id: item.id, quantite: 3 }] },
    });
    expect(depassement.statusCode).toBe(409);
    expect(depassement.json().erreur).toContain('vient d’être sélectionné');
  });

  it('répartit une remise au FCFA près entre toutes les quantités', async () => {
    const commande = await ouvrirCommandeTable(3);
    const remise = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande.id}/remise`,
      cookies,
      payload: { montant: 500, motif: 'Répartition test', pin_manager: PIN_MANAGER },
    });
    expect(remise.statusCode).toBe(200);

    let vue = remise.json();
    for (let numero = 1; numero <= 3; numero += 1) {
      const creation = await app.inject({
        method: 'POST',
        url: `/api/commandes/${commande.id}/sous-notes`,
        cookies,
        payload: { items: [{ commande_item_id: commande.items[0].id, quantite: 1 }] },
      });
      expect(creation.statusCode).toBe(200);
      vue = creation.json();
    }
    const parts = vue.notes.map((note: { remise_montant: number }) => note.remise_montant);
    expect(parts.reduce((total: number, part: number) => total + part, 0)).toBe(500);
    expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
    expect(vue.notes.reduce((total: number, note: { montant: number }) => total + note.montant, 0)).toBe(8500);
  });

  it('annule une sélection sans paiement et libère ses articles', async () => {
    const commande = await ouvrirCommandeTable(1);
    const creation = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande.id}/sous-notes`,
      cookies,
      payload: { items: [{ commande_item_id: commande.items[0].id, quantite: 1 }] },
    });
    const note = creation.json().notes[0];

    const annulation = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande.id}/sous-notes/${note.id}/annuler`,
      cookies,
      payload: {},
    });
    expect(annulation.statusCode).toBe(200);
    expect(annulation.json().notes[0].statut).toBe('ANNULEE');
    expect(annulation.json().items[0].quantite_disponible).toBe(1);
  });

  it('paie une personne en mixte, conserve la table, puis la libère au dernier article', async () => {
    const commande = await ouvrirCommandeTable(3, donnees.table_id);
    const item = commande.items[0];
    const creation = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande.id}/sous-notes`,
      cookies,
      payload: { items: [{ commande_item_id: item.id, quantite: 1 }] },
    });
    const note1 = creation.json().notes[0];

    const premier = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande.id}/paiements`,
      cookies,
      payload: { mode: 'ESPECES', montant: 1000, note_id: note1.id },
    });
    expect(premier.statusCode).toBe(200);
    expect(premier.json().notes[0].statut).toBe('PARTIELLEMENT_PAYEE');
    const tracesPaiement = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'PAIEMENT_SOUS_NOTE'), eq(auditLog.entite_id, note1.id)));
    expect(tracesPaiement).toHaveLength(1);
    expect(tracesPaiement[0]).toMatchObject({ montant: 1000, user_id: donnees.caissier_id });

    const second = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande.id}/paiements`,
      cookies,
      payload: { mode: 'WAVE', montant: 2000, note_id: note1.id },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().statut).not.toBe('PAYEE');
    expect(second.json().items[0]).toMatchObject({ quantite_payee: 1, quantite_disponible: 2 });

    const annulationInterdite = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande.id}/sous-notes/${note1.id}/annuler`,
      cookies,
      payload: {},
    });
    expect(annulationInterdite.statusCode).toBe(409);

    const annulationCommande = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande.id}/annuler`,
      cookies,
      payload: { motif: 'Tentative après acompte', pin_manager: PIN_MANAGER },
    });
    expect(annulationCommande.statusCode).toBe(409);
    expect(annulationCommande.json().erreur).toContain('paiement');

    const creationFinale = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande.id}/sous-notes`,
      cookies,
      payload: { items: [{ commande_item_id: item.id, quantite: 2 }] },
    });
    const note2 = creationFinale.json().notes.find((n: { numero: number }) => n.numero === 2);
    const final = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande.id}/paiements`,
      cookies,
      payload: { mode: 'ORANGE_MONEY', montant: 6000, note_id: note2.id },
    });
    expect(final.statusCode).toBe(200);
    expect(final.json().statut).toBe('PAYEE');
    expect(final.json().reste).toBe(0);

    const tables = await app.inject({ method: 'GET', url: '/api/tables', cookies });
    const table = tables.json().find((t: { id: string }) => t.id === donnees.table_id);
    expect(table.statut).toBe('LIBRE');
  });

  it('sérialise deux caissiers qui sélectionnent le dernier article', async () => {
    const commande = await ouvrirCommandeTable(1);
    const corps = { items: [{ commande_item_id: commande.items[0].id, quantite: 1 }] };
    const [a, b] = await Promise.all([
      app.inject({ method: 'POST', url: `/api/commandes/${commande.id}/sous-notes`, cookies, payload: corps }),
      app.inject({ method: 'POST', url: `/api/commandes/${commande.id}/sous-notes`, cookies, payload: corps }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  });

  it('fige le reçu payé tout en autorisant un nouvel article', async () => {
    let commande = await ouvrirCommandeTable(2);
    const item = commande.items[0];
    const selection = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande.id}/sous-notes`,
      cookies,
      payload: { items: [{ commande_item_id: item.id, quantite: 1 }] },
    });
    const note = selection.json().notes[0];
    await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande.id}/paiements`,
      cookies,
      payload: { mode: 'ESPECES', montant: 3000, note_id: note.id },
    });

    const annulation = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande.id}/items/${item.id}/annuler`,
      cookies,
      payload: { motif: 'Changement demandé' },
    });
    expect(annulation.statusCode).toBe(409);

    const ajout = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande.id}/items`,
      cookies,
      payload: { article_id: donnees.article_id, quantite: 1, options: [], supplements: [] },
    });
    expect(ajout.statusCode).toBe(200);
    commande = ajout.json();
    expect(commande.total).toBe(9000);
    expect(commande.notes[0]).toMatchObject({ montant: 3000, statut: 'PAYEE' });
    expect(commande.reste).toBe(6000);
    const factureSuivante = construireFactureDisponible(commande);
    expect(factureSuivante.total).toBe(6000);
    expect(factureSuivante.items).toHaveLength(2);
    expect(factureSuivante.items.reduce((s, ligne) => s + ligne.quantite, 0)).toBe(2);
  });

  it('compte immédiatement les acomptes par mode mais reconnaît la vente à la sous-note soldée', async () => {
    const avant = await calculerStatsService(db, serviceId);
    const commande = await ouvrirCommandeTable(1);
    const selection = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande.id}/sous-notes`,
      cookies,
      payload: { items: [{ commande_item_id: commande.items[0].id, quantite: 1 }] },
    });
    const note = selection.json().notes[0];
    await app.inject({
      method: 'POST', url: `/api/commandes/${commande.id}/paiements`, cookies,
      payload: { mode: 'WAVE', montant: 1000, note_id: note.id },
    });
    const partiel = await calculerStatsService(db, serviceId);
    expect(partiel.par_mode.WAVE - avant.par_mode.WAVE).toBe(1000);
    expect(partiel.total_ventes).toBe(avant.total_ventes);
    expect(partiel.sous_notes_incompletes).toContainEqual(expect.objectContaining({ montant_recu: 1000, reste: 2000 }));

    await app.inject({
      method: 'POST', url: `/api/commandes/${commande.id}/paiements`, cookies,
      payload: { mode: 'WAVE', montant: 2000, note_id: note.id },
    });
    const solde = await calculerStatsService(db, serviceId);
    expect(solde.total_ventes - avant.total_ventes).toBe(3000);
    expect(solde.sous_notes_incompletes.some((n) => n.numero_ticket === commande.numero_ticket)).toBe(false);
  });

  it('compte un seul ticket principal lorsque deux personnes paient la même commande', async () => {
    const avant = await calculerStatsService(db, serviceId);
    const commande = await ouvrirCommandeTable(2);
    for (let numero = 1; numero <= 2; numero += 1) {
      const selection = await app.inject({
        method: 'POST',
        url: `/api/commandes/${commande.id}/sous-notes`,
        cookies,
        payload: { items: [{ commande_item_id: commande.items[0].id, quantite: 1 }] },
      });
      const note = selection.json().notes.find((candidate: { numero: number }) => candidate.numero === numero);
      const paiement = await app.inject({
        method: 'POST',
        url: `/api/commandes/${commande.id}/paiements`,
        cookies,
        payload: { mode: 'ESPECES', montant: 3000, note_id: note.id },
      });
      expect(paiement.statusCode).toBe(200);
    }
    const apres = await calculerStatsService(db, serviceId);
    expect(apres.total_ventes - avant.total_ventes).toBe(6000);
    expect(apres.nb_commandes_payees - avant.nb_commandes_payees).toBe(1);
    expect(apres.par_type.EMPORTER.nb - avant.par_type.EMPORTER.nb).toBe(1);
  });

  it('termine une sous-note monétaire historique sans en créer de nouvelle', async () => {
    const commande = await ouvrirCommandeTable(1);
    const [note] = await db.insert(notesSplit).values({
      commande_id: commande.id,
      numero: 1,
      libelle: 'Ancienne note',
      type: 'MONTANT_HISTORIQUE',
      statut: 'A_PAYER',
      sous_total: 3000,
      montant: 3000,
    }).returning();
    const paiement = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande.id}/paiements`,
      cookies,
      payload: { mode: 'CARTE', montant: 3000, note_id: note!.id },
    });
    expect(paiement.statusCode).toBe(200);
    expect(paiement.json().statut).toBe('PAYEE');
    expect(paiement.json().notes[0].statut).toBe('PAYEE');
  });

  it('réduit le total principal avec les points de la personne et solde la commande', async () => {
    const clientId = randomUUID();
    await db.insert(clientsFidelite).values({ id: clientId, telephone: '0700000042' });
    await db.insert(pointsFidelite).values({ client_id: clientId, points: 100, source: 'POS' });
    await db.insert(syncEtat).values({ flux: `PAIEMENT_ARTICLES_${randomUUID()}`, version: 1, synced_at: new Date() });

    const commande = await ouvrirCommandeTable(1);
    const selection = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande.id}/sous-notes`,
      cookies,
      payload: {
        items: [{ commande_item_id: commande.items[0].id, quantite: 1 }],
        client_fidelite_id: clientId,
        fidelite_points: 50,
      },
    });
    expect(selection.statusCode).toBe(200);
    expect(selection.json()).toMatchObject({ total: 2500, reste: 2500 });
    const note = selection.json().notes[0];
    expect(note).toMatchObject({ montant: 2500, fidelite_montant: 500 });

    const paiement = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande.id}/paiements`,
      cookies,
      payload: { mode: 'ESPECES', montant: 2500, note_id: note.id },
    });
    expect(paiement.statusCode).toBe(200);
    expect(paiement.json()).toMatchObject({ statut: 'PAYEE', reste: 0 });
  });

  it('restitue les points quand une sélection sans paiement est annulée', async () => {
    const clientId = randomUUID();
    await db.insert(clientsFidelite).values({ id: clientId, telephone: '0700000043' });
    await db.insert(pointsFidelite).values({ client_id: clientId, points: 100, source: 'POS' });
    await db.insert(syncEtat).values({ flux: `ANNULATION_ARTICLES_${randomUUID()}`, version: 1, synced_at: new Date() });

    const commande = await ouvrirCommandeTable(1);
    const selection = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande.id}/sous-notes`,
      cookies,
      payload: {
        items: [{ commande_item_id: commande.items[0].id, quantite: 1 }],
        client_fidelite_id: clientId,
        fidelite_points: 50,
      },
    });
    const note = selection.json().notes[0];
    const annulation = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande.id}/sous-notes/${note.id}/annuler`,
      cookies,
      payload: {},
    });
    expect(annulation.statusCode).toBe(200);
    expect(annulation.json()).toMatchObject({ total: 3000, reste: 3000 });
    expect(annulation.json().items[0].quantite_disponible).toBe(1);

    const lignes = await db.select().from(pointsFidelite).where(eq(pointsFidelite.client_id, clientId));
    expect(lignes.reduce((solde, ligne) => solde + ligne.points, 0)).toBe(100);
    expect(lignes.filter((ligne) => ligne.note_id === note.id).map((ligne) => ligne.points).sort()).toEqual([-50, 50]);
  });
});
