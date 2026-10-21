/**
 * Annulation d'un paiement saisi par erreur (backlog du 2026-10-16, livré le
 * 2026-10-21) : PIN ADMINISTRATEUR + motif, seulement dans le shift encore
 * ouvert, contre-passation (jamais de suppression), audit + outbox dans la même
 * transaction, et plus aucun effet nulle part — tiroir, ticket Z, mobile money,
 * points fidélité.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { CommandeVue } from '@pos/shared';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { auditLog, clientsFidelite, notesSplit, paiements, pointsFidelite, syncEtat, syncOutbox } from '../src/db/schema/index.js';
import { ligneAutorisee } from '../../../supabase/functions/_shared/tables.js';
import {
  PIN_CAISSIER,
  PIN_MANAGER,
  PIN_PROPRIO,
  resetDonnees,
  seConnecter,
  validerInventaire,
  type Donnees,
} from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;
const CLIENT = '0769000077'; // 1 000 points au départ

async function commande(nb: number, telephone?: string): Promise<string> {
  const c = await app.inject({ method: 'POST', url: '/api/commandes', cookies, payload: { type: 'EMPORTER' } });
  const id = c.json().id as string;
  await app.inject({
    method: 'POST',
    url: `/api/commandes/${id}/items`,
    cookies,
    payload: { article_id: donnees.article_id, quantite: nb, options: [], supplements: [] },
  });
  if (telephone) {
    const r = await app.inject({ method: 'POST', url: `/api/commandes/${id}/fidelite`, cookies, payload: { telephone } });
    expect(r.statusCode).toBe(200);
  }
  return id;
}

async function payer(id: string, mode: string, montant: number, montant_recu?: number): Promise<CommandeVue> {
  const r = await app.inject({
    method: 'POST',
    url: `/api/commandes/${id}/paiements`,
    cookies,
    payload: { mode, montant, ...(montant_recu ? { montant_recu } : {}) },
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as CommandeVue;
}

const annuler = (paiementId: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/paiements/${paiementId}/annuler`, cookies, payload });

const annulerAdmin = (paiementId: string, motif = 'Ticket test encaissé par erreur') =>
  annuler(paiementId, { motif, pin_administrateur: PIN_PROPRIO });

async function solde(): Promise<number> {
  const [c] = await db.select().from(clientsFidelite).where(eq(clientsFidelite.telephone, CLIENT));
  const [r] = await db
    .select({ s: sql<string>`COALESCE(SUM(${pointsFidelite.points}),0)` })
    .from(pointsFidelite)
    .where(eq(pointsFidelite.client_id, c!.id));
  return Number(r!.s);
}

let paiementD = '';

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  await app.inject({ method: 'POST', url: '/api/services/ouvrir', cookies, payload: { fond_de_caisse: 25000 } });
  // Descente cloud récente : le solde de points est vérifiable (règle des 24 h).
  await db.insert(syncEtat).values({ flux: 'CATALOGUE', version: 1, synced_at: new Date() });
  const id = crypto.randomUUID();
  await db.insert(clientsFidelite).values({ id, telephone: CLIENT });
  await db.insert(pointsFidelite).values({ client_id: id, points: 1000, source: 'POS' });
});
afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('annulation d’un paiement saisi par erreur', () => {
  it('cas réel : 2 000 espèces + 1 000 Wave + 3 000 OM fictifs, annulés un par un', async () => {
    const id = await commande(2); // 6 000 F
    await payer(id, 'ESPECES', 2000, 5000); // 3 000 rendus
    await payer(id, 'WAVE', 1000);
    const payee = await payer(id, 'ORANGE_MONEY', 3000);
    expect(payee.statut).toBe('PAYEE');
    const wave = payee.paiements.find((p) => p.mode === 'WAVE')!;

    const r = await annulerAdmin(wave.id);
    expect(r.statusCode, r.body).toBe(200);
    const vue = r.json() as CommandeVue;
    // La commande n'est plus soldée : elle redevient payable.
    expect(vue.statut).toBe('OUVERTE');
    expect(vue.paye).toBe(5000);
    expect(vue.reste).toBe(1000);
    expect(vue.paiements.map((p) => p.mode).sort()).toEqual(['ESPECES', 'ORANGE_MONEY']);
    expect(vue.paiements_annules).toEqual([
      expect.objectContaining({ id: wave.id, mode: 'WAVE', montant: 1000, motif: 'Ticket test encaissé par erreur' }),
    ]);

    // Jamais supprimé : l'original est intact, une ligne négative le contre-passe
    // sur le même shift et au nom du même caissier.
    const lignes = await db.select().from(paiements).where(eq(paiements.commande_id, id));
    const original = lignes.find((p) => p.id === wave.id)!;
    expect(original.montant).toBe(1000);
    const contre = lignes.find((p) => p.contrepasse_de === wave.id)!;
    expect(contre).toMatchObject({
      mode: 'WAVE',
      montant: -1000,
      service_id: original.service_id,
      encaisse_par: donnees.caissier_id,
      annule_par: donnees.proprio_id,
      annulation_motif: 'Ticket test encaissé par erreur',
    });

    // Audit, au nom de l'administrateur, avec le lien vers la contre-passation.
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'ANNULATION_PAIEMENT'));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      user_id: donnees.proprio_id,
      entite: 'paiements',
      entite_id: wave.id,
      montant: 1000,
      motif: 'Ticket test encaissé par erreur',
    });
    expect(audits[0]!.meta).toMatchObject({
      commande_id: id,
      mode: 'WAVE',
      contrepassation_id: contre.id,
      demande_par: donnees.caissier_id,
      commande_rouverte: true,
    });

    // Outbox : la contre-passation part comme un INSERT ordinaire, la commande
    // rouverte comme un UPDATE, et l'audit aussi.
    const [sortie] = await db
      .select()
      .from(syncOutbox)
      .where(and(eq(syncOutbox.table_name, 'paiements'), eq(syncOutbox.record_id, contre.id)));
    expect(sortie!.operation).toBe('INSERT');
    expect(sortie!.payload).toMatchObject({ montant: -1000, mode: 'WAVE', contrepasse_de: wave.id });
    const majCommande = await db
      .select()
      .from(syncOutbox)
      .where(and(eq(syncOutbox.table_name, 'commandes'), eq(syncOutbox.record_id, id)));
    expect(majCommande.at(-1)!.payload).toMatchObject({ statut: 'OUVERTE' });
    const auditSortie = await db
      .select()
      .from(syncOutbox)
      .where(and(eq(syncOutbox.table_name, 'audit_log'), sql`${syncOutbox.payload}->>'action' = 'ANNULATION_PAIEMENT'`));
    expect(auditSortie).toHaveLength(1);

    // Côté cloud, sync-push ne garde que les colonnes qu'il connaît : la ligne
    // négative atterrit telle quelle, sans colonne inconnue qui bloquerait l'outbox.
    const cloud = ligneAutorisee('paiements', sortie!.payload as Record<string, unknown>, contre.id, 'resto')!;
    expect(cloud).toMatchObject({ id: contre.id, montant: -1000, mode: 'WAVE', service_id: original.service_id });
    expect(cloud).not.toHaveProperty('contrepasse_de');
    expect(cloud).not.toHaveProperty('annulation_motif');

    // Les deux autres paiements fictifs, puis la commande elle-même : elle est
    // de nouveau annulable par la voie normale (PIN manager).
    for (const p of vue.paiements) expect((await annulerAdmin(p.id)).statusCode).toBe(200);
    const vide = (await app.inject({ method: 'GET', url: `/api/commandes/${id}`, cookies })).json() as CommandeVue;
    expect(vide.paye).toBe(0);
    expect(vide.paiements).toHaveLength(0);
    expect(vide.paiements_annules).toHaveLength(3);
    // Plus aucun paiement valable : la sélection implicite est annulée avec eux.
    expect(vide.notes.every((n) => n.statut === 'ANNULEE')).toBe(true);
    const annulee = await app.inject({
      method: 'POST',
      url: `/api/commandes/${id}/annuler`,
      cookies,
      payload: { motif: 'Ticket test', pin_manager: PIN_MANAGER },
    });
    expect(annulee.statusCode, annulee.body).toBe(200);
    expect(annulee.json().statut).toBe('ANNULEE');
  });

  it('un acompte annulé : la commande se paie ensuite normalement', async () => {
    const id = await commande(1); // 3 000 F
    const vue = await payer(id, 'WAVE', 1000);
    expect((await annulerAdmin(vue.paiements[0]!.id)).statusCode).toBe(200);
    const fin = await payer(id, 'ESPECES', 3000);
    expect(fin.statut).toBe('PAYEE');
    expect(fin.paiements).toHaveLength(1);
  });

  it('refuse un PIN manager : seul un administrateur annule un paiement', async () => {
    const id = await commande(1);
    const vue = await payer(id, 'ESPECES', 3000);
    paiementD = vue.paiements[0]!.id;
    const r = await annuler(paiementD, { motif: 'Erreur de mode', pin_administrateur: PIN_MANAGER });
    expect(r.statusCode).toBe(403);
    expect(r.json().erreur).toContain('seul un administrateur');
    const [echec] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'ECHEC_PIN'), sql`${auditLog.meta}->>'contexte' = 'ANNULATION_PAIEMENT'`));
    expect(echec!.meta).toMatchObject({ type: 'PIN_ADMINISTRATEUR', cause: 'SANS_AUTORITE' });
  });

  it('refuse un mauvais PIN', async () => {
    const r = await annuler(paiementD, { motif: 'Erreur de mode', pin_administrateur: '975310' });
    expect(r.statusCode).toBe(403);
    expect(r.json().erreur).toBe('PIN administrateur incorrect');
  });

  it('refuse un motif vide', async () => {
    const r = await annuler(paiementD, { motif: '  ', pin_administrateur: PIN_PROPRIO });
    expect(r.statusCode).toBe(400);
    // Aucun des refus n'a touché au paiement ni à la commande.
    const lignes = await db.select().from(paiements).where(eq(paiements.contrepasse_de, paiementD));
    expect(lignes).toHaveLength(0);
  });

  it('refuse d’annuler deux fois, ou d’annuler une annulation', async () => {
    const id = await commande(1);
    const vue = await payer(id, 'WAVE', 3000);
    const paiementId = vue.paiements[0]!.id;
    expect((await annulerAdmin(paiementId)).statusCode).toBe(200);
    const deux = await annulerAdmin(paiementId);
    expect(deux.statusCode).toBe(409);
    expect(deux.json().erreur).toContain('déjà annulé');
    const [contre] = await db.select().from(paiements).where(eq(paiements.contrepasse_de, paiementId));
    expect((await annulerAdmin(contre!.id)).statusCode).toBe(409);
    await payer(id, 'WAVE', 3000); // solde le ticket pour la clôture
  });

  it('paiement en POINTS : les points reviennent au client', async () => {
    const id = await commande(1, CLIENT); // 3 000 F = 300 points
    expect(await solde()).toBe(1000);
    const vue = await payer(id, 'POINTS', 3000);
    expect(vue.statut).toBe('PAYEE');
    expect(await solde()).toBe(700);

    const r = await annulerAdmin(vue.paiements[0]!.id, 'Le client voulait garder ses points');
    expect(r.statusCode, r.body).toBe(200);
    expect(await solde()).toBe(1000);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'ANNULATION_PAIEMENT'), eq(auditLog.entite_id, vue.paiements[0]!.id)));
    expect(audit!.meta).toMatchObject({ points_rendus: 300 });

    // Payé ensuite en espèces : la vente crédite normalement ses points.
    expect((await payer(id, 'ESPECES', 3000, 5000)).statut).toBe('PAYEE'); // 2 000 rendus
    expect(await solde()).toBe(1003);
  });

  it('vente qui avait crédité des points : le crédit est repris, puis regagné au nouveau paiement', async () => {
    const id = await commande(2, CLIENT); // 6 000 F → 6 points
    const vue = await payer(id, 'ESPECES', 6000);
    expect(await solde()).toBe(1009);
    expect((await annulerAdmin(vue.paiements[0]!.id, 'Payé en Wave, pas en espèces')).statusCode).toBe(200);
    expect(await solde()).toBe(1003);
    expect((await payer(id, 'WAVE', 6000)).statut).toBe('PAYEE');
    expect(await solde()).toBe(1009);
    // La sélection implicite annulée reste tracée, la nouvelle est soldée.
    const notes = await db.select().from(notesSplit).where(eq(notesSplit.commande_id, id));
    expect(notes.map((n) => n.statut).sort()).toEqual(['ANNULEE', 'PAYEE']);
  });

  it('ticket Z : un paiement annulé ne compte nulle part', async () => {
    await validerInventaire(app, cookies);
    const rep = await app.inject({
      method: 'POST',
      url: '/api/services/cloturer',
      cookies,
      // Espèces valables : 3 000 (acompte) + 3 000 (PIN refusé) + 3 000 (points
      // annulés puis espèces) = 9 000 → théorique 34 000.
      // Wave valables : 3 000 (double annulation refusée) + 6 000 = 9 000.
      payload: { especes_comptees: 34000, modes: { WAVE: 9000 } },
    });
    expect(rep.statusCode, rep.body).toBe(200);
    const z = rep.json();
    expect(z.especes_theorique).toBe(34000);
    expect(z.ecart).toBe(0);
    expect(z.par_mode.ESPECES).toBe(9000);
    expect(z.par_mode.WAVE).toBe(9000);
    expect(z.par_mode.ORANGE_MONEY).toBe(0);
    expect(z.par_mode.POINTS).toBe(0);
    expect(z.paye_points).toEqual({ nb: 0, total: 0 });
    // Seul le rendu du ticket payé en espèces après l'annulation des points reste.
    expect(z.monnaie_rendue).toBe(2000);
    expect(z.nb_rendus).toBe(1);
    expect(z.total_ventes).toBe(18000);
    expect(z.nb_commandes_payees).toBe(5);
    expect(z.nb_commandes_annulees).toBe(1);
  });

  it('refuse une fois le shift clôturé : le ticket Z est figé', async () => {
    const r = await annulerAdmin(paiementD);
    expect(r.statusCode).toBe(409);
    expect(r.json().erreur).toContain('clôturé');
    const lignes = await db.select().from(paiements).where(eq(paiements.contrepasse_de, paiementD));
    expect(lignes).toHaveLength(0);
  });
});
