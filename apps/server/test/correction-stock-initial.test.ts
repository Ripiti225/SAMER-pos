/**
 * Correction du stock initial : deux vrais shifts à la suite sur un produit
 * compté. Le premier caissier clôture, le second reprend son chiffre.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import {
  auditLog,
  correctionsStockInitial,
  produitsInventaire,
  servicesCaisse,
  syncOutbox,
} from '../src/db/schema/index.js';
import { PIN_CAISSIER, PIN_CAISSIER2, PIN_MANAGER, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let sortant: Record<string, string>;
let entrant: Record<string, string>;
let produit: string;

const appel = (method: 'GET' | 'POST' | 'PUT', url: string, cookies: Record<string, string>, payload?: object) =>
  app.inject({ method, url, cookies, ...(payload ? { payload } : {}) });

const corriger = (stock_initial: number, extra: object = {}, cookies = entrant) =>
  appel('POST', `/api/inventaire/lignes/${produit}/corriger-initial`, cookies, {
    stock_initial,
    explication: 'Recompté à la prise de poste',
    ...extra,
  });

const validerCorrection = (id: string, payload: object, cookies = entrant) =>
  appel('POST', `/api/inventaire/corrections/${id}/valider`, cookies, payload);

/** Ouvre un shift, reçoit `recu` unités, compte `compte`, valide l'inventaire. */
async function shiftValide(cookies: Record<string, string>, compte: number, recu = 0): Promise<void> {
  const ouvert = await appel('POST', '/api/services/ouvrir', cookies, { fond_de_caisse: 0 });
  if (ouvert.statusCode !== 200) throw new Error(`Ouverture: ${ouvert.body}`);
  await appel('GET', '/api/inventaire', cookies);
  if (recu > 0) await appel('POST', '/api/inventaire/entrees', cookies, { produit_id: produit, quantite: recu });
  await appel('PUT', `/api/inventaire/lignes/${produit}`, cookies, { stock_compte: compte });
  const valide = await appel('POST', '/api/inventaire/valider', cookies);
  if (valide.statusCode !== 200) throw new Error(`Validation: ${valide.body}`);
}

async function cloturer(cookies: Record<string, string>): Promise<void> {
  const rep = await appel('POST', '/api/services/cloturer', cookies, { especes_comptees: 0 });
  if (rep.statusCode !== 200) throw new Error(`Clôture: ${rep.body}`);
}

async function ouvrir(cookies: Record<string, string>): Promise<void> {
  const rep = await appel('POST', '/api/services/ouvrir', cookies, { fond_de_caisse: 0 });
  if (rep.statusCode !== 200) throw new Error(`Ouverture: ${rep.body}`);
  await appel('GET', '/api/inventaire', cookies);
}

/** Le sortant laisse `compte` (attendu : `recu`), le suivant prend le relais. */
async function relever(compte: number, recu = compte): Promise<void> {
  await shiftValide(sortant, compte, recu);
  await cloturer(sortant);
  await ouvrir(entrant);
}

const vieillirShift = (caissierId: string, minutes: number) =>
  db
    .update(servicesCaisse)
    .set({ ouvert_le: new Date(Date.now() - minutes * 60 * 1000) })
    .where(eq(servicesCaisse.caissier_id, caissierId));

beforeAll(async () => {
  app = await construireApp();
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

beforeEach(async () => {
  donnees = await resetDonnees();
  sortant = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  entrant = await seConnecter(app, donnees.caissier2_id, PIN_CAISSIER2);
  const [p] = await db
    .insert(produitsInventaire)
    .values({ code: 'p1', categorie: 'PAIN', nom: 'Pain chawarma', prix: 8000, role: 'COMPTE', ordre: 1 })
    .returning();
  produit = p!.id;
});

describe('correction du stock initial', () => {
  it('corrige tout de suite et ouvre un litige à valider, tracé et publié', async () => {
    await relever(14);
    const rep = await corriger(12);
    expect(rep.statusCode).toBe(200);
    expect(rep.json().correction.statut).toBe('A_VALIDER');
    expect(rep.json().ligne.stock_initial).toBe(12);

    const audit = await db.select().from(auditLog).where(eq(auditLog.action, 'CORRECTION_STOCK_INITIAL'));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.motif).toBe('Recompté à la prise de poste');
    const outbox = await db.select().from(syncOutbox).where(eq(syncOutbox.table_name, 'corrections_stock_initial'));
    expect(outbox).toHaveLength(1);
  });

  it('refuse après une heure, même après une reconnexion', async () => {
    await relever(14);
    await vieillirShift(donnees.caissier2_id, 61);
    const reconnecte = await seConnecter(app, donnees.caissier2_id, PIN_CAISSIER2);
    const rep = await corriger(12, {}, reconnecte);
    expect(rep.statusCode).toBe(409);
    expect(rep.json().erreur).toContain('heure');
  });

  it('exige une explication', async () => {
    await relever(14);
    const rep = await corriger(12, { explication: '   ' });
    expect(rep.statusCode).toBe(400);
    expect((await db.select().from(correctionsStockInitial))).toHaveLength(0);
  });

  it('refuse un chiffre inchangé, puis tout chiffre une fois l’inventaire validé', async () => {
    await relever(14);
    expect((await corriger(14)).statusCode).toBe(400);
    await appel('PUT', `/api/inventaire/lignes/${produit}`, entrant, { stock_compte: 14 });
    await appel('POST', '/api/inventaire/valider', entrant);
    expect((await corriger(12)).statusCode).toBe(409);
  });

  it('impute au sortant avec son code, et refuse le code d’un autre', async () => {
    await relever(14);
    const faux = await corriger(12, { pin_sortant: PIN_CAISSIER2 });
    expect(faux.statusCode).toBe(403);
    expect((await db.select().from(correctionsStockInitial))).toHaveLength(0);

    const rep = await corriger(12, { pin_sortant: PIN_CAISSIER });
    expect(rep.json().correction).toMatchObject({ statut: 'RECONNUE_SORTANT', valide_par: donnees.caissier_id });
  });

  it('un surplus annulé n’ouvre aucun litige', async () => {
    await relever(12, 10);
    const rep = await corriger(10);
    expect(rep.json().correction).toMatchObject({ statut: 'SANS_LITIGE' });
    expect(Number(rep.json().correction.ecart_sortant_avant)).toBe(2);
    expect(Number(rep.json().correction.ecart_sortant_apres)).toBe(0);
  });

  it('un surplus qui cache un vrai manque ouvre un litige de la bonne quantité', async () => {
    await relever(12, 10);
    const rep = await corriger(9);
    expect(rep.json().correction.statut).toBe('A_VALIDER');
    expect(Number(rep.json().correction.ecart_sortant_apres)).toBe(-1);
  });

  it('un chiffre remonté annule le manquant du sortant sans litige', async () => {
    await relever(8, 10);
    const rep = await corriger(10);
    expect(rep.json().correction.statut).toBe('SANS_LITIGE');
  });

  it('le manager valide après la première heure, une seule fois', async () => {
    await relever(14);
    const id = (await corriger(12)).json().correction.id as string;
    await vieillirShift(donnees.caissier2_id, 120);

    const rep = await validerCorrection(id, { pin_manager: PIN_MANAGER });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().correction).toMatchObject({ statut: 'VALIDEE_MANAGER', valide_par: donnees.manager_id });
    expect((await db.select().from(auditLog).where(eq(auditLog.action, 'VALIDATION_CORRECTION_STOCK')))).toHaveLength(1);
    expect((await validerCorrection(id, { pin_manager: PIN_MANAGER })).statusCode).toBe(409);
  });

  it('le sortant peut aussi reconnaître le litige plus tard', async () => {
    await relever(14);
    const id = (await corriger(12)).json().correction.id as string;
    const rep = await validerCorrection(id, { pin_sortant: PIN_CAISSIER });
    expect(rep.json().correction.statut).toBe('RECONNUE_SORTANT');
  });

  it('exige exactement un code pour valider', async () => {
    await relever(14);
    const id = (await corriger(12)).json().correction.id as string;
    expect((await validerCorrection(id, {})).statusCode).toBe(400);
    expect((await validerCorrection(id, { pin_manager: PIN_MANAGER, pin_sortant: PIN_CAISSIER })).statusCode).toBe(400);
  });

  it('refuse le manager auteur de la correction', async () => {
    await relever(14);
    const manager = await seConnecter(app, donnees.manager_id, PIN_MANAGER);
    const rep = await corriger(12, { pin_manager: PIN_MANAGER }, manager);
    expect(rep.statusCode).toBe(403);

    const id = (await corriger(12, {}, manager)).json().correction.id as string;
    expect((await validerCorrection(id, { pin_manager: PIN_MANAGER }, manager)).statusCode).toBe(403);
  });

  it('refuse le manager qui tient lui-même la caisse', async () => {
    const manager = await seConnecter(app, donnees.manager_id, PIN_MANAGER);
    await shiftValide(sortant, 14, 14);
    await cloturer(sortant);
    await ouvrir(manager);
    const rep = await corriger(12, { pin_manager: PIN_MANAGER }, manager);
    expect(rep.statusCode).toBe(403);
  });

  it('même caissier sur les deux shifts : imputé d’office, sans code', async () => {
    await shiftValide(sortant, 14, 14);
    await cloturer(sortant);
    await ouvrir(sortant);
    const rep = await corriger(12, {}, sortant);
    expect(rep.json().correction.statut).toBe('RECONNUE_SORTANT');
  });

  it('une deuxième correction remplace la première et repart du chiffre d’origine', async () => {
    await relever(14);
    await corriger(12);
    const rep = await corriger(14);
    expect(rep.json().correction.statut).toBe('SANS_LITIGE');
    expect(Number(rep.json().correction.stock_reporte)).toBe(14);
    expect(Number(rep.json().correction.stock_avant)).toBe(12);
    const toutes = await db.select().from(correctionsStockInitial);
    expect(toutes.map((c) => c.statut).sort()).toEqual(['REMPLACEE', 'SANS_LITIGE']);
    expect(await db.select().from(syncOutbox).where(eq(syncOutbox.table_name, 'corrections_stock_initial'))).toHaveLength(3);
  });

  it('sans inventaire précédent : tracé, sans litige ni sortant', async () => {
    await ouvrir(entrant);
    const rep = await corriger(5);
    expect(rep.json().correction).toMatchObject({ statut: 'SANS_LITIGE', caissier_sortant_id: null });
  });

  it('shift débloqué entre les deux : aucune validation sur place', async () => {
    await shiftValide(sortant, 14, 14);
    await cloturer(sortant);
    await ouvrir(sortant);
    await appel('POST', '/api/inventaire/debloquer', sortant, { pin_manager: PIN_MANAGER, motif: 'Panne' });
    await cloturer(sortant);
    await ouvrir(entrant);

    expect((await corriger(12, { pin_manager: PIN_MANAGER })).statusCode).toBe(409);
    const rep = await corriger(12);
    expect(rep.json().correction).toMatchObject({ statut: 'A_VALIDER', shift_intermediaire_debloque: true });
    const refus = await validerCorrection(rep.json().correction.id, { pin_manager: PIN_MANAGER });
    expect(refus.statusCode).toBe(409);
  });

  it('la clôture passe avec un litige en attente, et le fige au ticket Z', async () => {
    await relever(14);
    await corriger(12);
    await appel('PUT', `/api/inventaire/lignes/${produit}`, entrant, { stock_compte: 12 });
    await appel('POST', '/api/inventaire/valider', entrant);
    const rep = await appel('POST', '/api/services/cloturer', entrant, { especes_comptees: 0 });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().corrections_stock_initial).toEqual([
      { produit: 'Pain chawarma', avant: 14, apres: 12, statut: 'A_VALIDER', sortant: 'Caissier Test' },
    ]);
  });

  it('une validation est refusée une fois le shift clôturé', async () => {
    await relever(14);
    const id = (await corriger(12)).json().correction.id as string;
    await appel('PUT', `/api/inventaire/lignes/${produit}`, entrant, { stock_compte: 12 });
    await appel('POST', '/api/inventaire/valider', entrant);
    await cloturer(entrant);
    await ouvrir(sortant);
    expect((await validerCorrection(id, { pin_manager: PIN_MANAGER }, sortant)).statusCode).toBe(409);
  });

  it('le ticket Z du sortant ne bouge pas', async () => {
    await relever(14);
    const [avant] = await db.select().from(servicesCaisse).where(eq(servicesCaisse.caissier_id, donnees.caissier_id));
    await corriger(12);
    const [apres] = await db.select().from(servicesCaisse).where(eq(servicesCaisse.caissier_id, donnees.caissier_id));
    expect(apres!.rapport_z).toEqual(avant!.rapport_z);
  });

  it('le contexte rappelle le chiffre repris, le sortant et la fin du délai', async () => {
    await relever(14);
    const rep = await appel('GET', `/api/inventaire/lignes/${produit}/correction`, entrant);
    expect(rep.statusCode).toBe(200);
    expect(rep.json()).toMatchObject({
      stock_reporte: 14,
      sortant_nom: 'Caissier Test',
      meme_caissier: false,
      intermediaire: false,
      sorties_payees: 0,
      sorties_en_cours: 0,
    });
  });

  it('l’inventaire expose la correction et la fin du délai', async () => {
    await relever(14);
    await corriger(12);
    const vue = (await appel('GET', '/api/inventaire', entrant)).json();
    expect(vue.correction_stock.corrections).toHaveLength(1);
    expect(vue.correction_stock.corrections[0]).toMatchObject({ stock_reporte: 14, stock_apres: 12, sortant_nom: 'Caissier Test' });
    expect(new Date(vue.correction_stock.fin).getTime()).toBeGreaterThan(Date.now());
  });
});
