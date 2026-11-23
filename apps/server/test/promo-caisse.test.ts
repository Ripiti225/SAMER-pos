/**
 * PROMO-09 — code promo carte en caisse (brief PROMO § 3 et § 5), hors ligne.
 * Panier de la maquette : Chawarma 3 000 (exclu), Pizza 6 000, Jus 1 500.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { CommandeVue } from '@pos/shared';
import { construireApp } from '../src/app.js';
import { ConsolePrinter } from '../src/printer/ConsolePrinter.js';
import { db, fermerDb } from '../src/db/client.js';
import { articles, categories, clientsFidelite, notesSplit, promoCategoriesExclues, promoCodes, promoLots, promotions, syncOutbox } from '../src/db/schema/index.js';
import { PIN_CAISSIER, PIN_MANAGER, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;
let jusId = '';
const TEL = '+2250708123421';
const JOUR = 24 * 3600 * 1000;
const ids = { libre: randomUUID(), telTot: randomUUID(), telTard: randomUUID(), expire: randomUUID() };

async function preparerCodes() {
  const maintenant = Date.now();
  const lot = (id: string, fin: number) => ({
    id, libelle: 'Autocollants', pourcentage: 20, quantite: 10,
    valide_du: new Date(maintenant - JOUR), valide_au: new Date(maintenant + fin),
  });
  const [lotA, lotB, lotC] = [randomUUID(), randomUUID(), randomUUID()];
  await db.insert(promoLots).values([lot(lotA, 10 * JOUR), lot(lotB, 20 * JOUR), { ...lot(lotC, 0), valide_au: new Date(maintenant - 1000) }]);
  await db.insert(promoCodes).values([
    { id: ids.libre, lot_id: lotA, code: 'PAM-7K3QX', statut: 'DISPONIBLE' },
    { id: ids.telTot, lot_id: lotA, code: 'PAM-H4M2P', statut: 'DISPONIBLE', telephone: TEL, active_le: new Date(), consentement_relance: true },
    { id: ids.telTard, lot_id: lotB, code: 'PAM-9TQ7D', statut: 'DISPONIBLE', telephone: TEL, active_le: new Date(), consentement_relance: true },
    { id: ids.expire, lot_id: lotC, code: 'PAM-2WXK8', statut: 'DISPONIBLE' },
  ]);
  // Chawarma exclu des codes carte, par sa catégorie.
  const [chawarma] = await db.select({ categorie_id: articles.categorie_id }).from(articles).where(eq(articles.id, donnees.article_id));
  await db.insert(promoCategoriesExclues).values({ id: chawarma!.categorie_id, exclue: true });
}

async function commande(lignes: string[]): Promise<string> {
  const c = await app.inject({ method: 'POST', url: '/api/commandes', cookies, payload: { type: 'EMPORTER' } });
  const id = c.json().id as string;
  for (const article_id of lignes) {
    const r = await app.inject({ method: 'POST', url: `/api/commandes/${id}/items`, cookies, payload: { article_id, quantite: 1, options: [], supplements: [] } });
    expect(r.statusCode, r.body).toBe(200);
  }
  return id;
}

const appliquer = (id: string, saisie: string, canal = 'SUR_PLACE') =>
  app.inject({ method: 'POST', url: `/api/commandes/${id}/code-promo`, cookies, payload: { saisie, canal } });

const panier = () => [donnees.article_id, donnees.pizza_id, jusId];
const local = async (id: string) => (await db.select().from(promoCodes).where(eq(promoCodes.id, id)))[0]!;

beforeAll(async () => {
  app = await construireApp();
});
beforeEach(async () => {
  donnees = await resetDonnees();
  const [boissons] = await db.insert(categories).values({ nom: 'Boissons', ordre: 9 }).returning();
  const [jus] = await db.insert(articles).values({ categorie_id: boissons!.id, nom: 'Jus de bissap', prix_base: 1500 }).returning();
  jusId = jus!.id;
  await preparerCodes();
  cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  await app.inject({ method: 'POST', url: '/api/services/ouvrir', cookies, payload: { fond_de_caisse: 25000 } });
});
afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('code promo carte en caisse', () => {
  it('le code de l’autocollant : −20 % ligne par ligne, Chawarma non éligible, code réservé', async () => {
    const id = await commande(panier());
    const r = await appliquer(id, 'pam 7k3qx');
    expect(r.statusCode, r.body).toBe(200);
    const c = r.json().commande as CommandeVue;
    expect(c.sous_total).toBe(10500);
    expect(c.code_promo_montant).toBe(1500);
    expect(c.total).toBe(9000);
    expect(c.code_promo).toMatchObject({ code_masque: 'PAM-•••QX', pourcentage: 20, canal: 'SUR_PLACE' });
    const parNom = Object.fromEntries(c.items.map((i) => [i.nom_snapshot, i]));
    expect(parNom['Chawarma Poulet']).toMatchObject({ remise_code_promo: 0, exclue_code_promo: true });
    expect(parNom['Pizza Test']).toMatchObject({ remise_code_promo: 1200, exclue_code_promo: false });
    expect(parNom['Jus de bissap']).toMatchObject({ remise_code_promo: 300 });
    expect(await local(ids.libre)).toMatchObject({ local_statut: 'RESERVE', local_commande_id: id, local_canal: 'SUR_PLACE' });
  });

  it('cumul avec le happy hour, en cascade : −36 % sur les lignes éligibles', async () => {
    await db.insert(promotions).values({ nom: 'Happy hour', type: 'POURCENTAGE', valeur: 20 });
    const id = await commande(panier());
    const c = (await appliquer(id, 'PAM-7K3QX')).json().commande as CommandeVue;
    expect(c.promo_montant).toBe(2100);
    expect(c.code_promo_montant).toBe(960 + 240); // (6 000 − 1 200) × 20 % + (1 500 − 300) × 20 %
    expect(c.total).toBe(10500 - 2100 - 1200);
  });

  it('par le numéro du client : le code qui expire en premier, jamais en clair', async () => {
    const id = await commande(panier());
    const r = await appliquer(id, '07 08 12 34 21', 'TELEPHONE');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ par_numero: true, autres_codes: 1 });
    expect((r.json().commande as CommandeVue).code_promo).toMatchObject({ code_masque: 'PAM-•••2P', canal: 'TELEPHONE' });
    expect((await local(ids.telTot)).local_statut).toBe('RESERVE');
    expect((await local(ids.telTard)).local_statut).toBeNull();
  });

  it('code gardé sur un numéro : le client fidélité est rattaché, sans ressaisie', async () => {
    const id = await commande(panier());
    const c = (await appliquer(id, '0708123421')).json().commande as CommandeVue;
    const [client] = await db.select().from(clientsFidelite).where(eq(clientsFidelite.id, c.client_fidelite_id!));
    // Le format de la fidélité (tapé au pavé), pas celui des codes promo.
    expect(client?.telephone).toBe('0708123421');

    // Carte de l'autocollant activée avec ce numéro : même client, pas de doublon.
    const autre = await commande(panier());
    const vue = (await appliquer(autre, 'PAM-9TQ7D')).json().commande as CommandeVue;
    expect(vue.client_fidelite_id).toBe(client!.id);
    expect(await db.select().from(clientsFidelite)).toHaveLength(1);
  });

  it('retrouve un client fidélité saisi avec des espaces, et n’écrase pas celui déjà choisi', async () => {
    const [espace] = await db.insert(clientsFidelite).values({ id: randomUUID(), telephone: '07 08 12 34 21' }).returning();
    const id = await commande(panier());
    expect(((await appliquer(id, 'PAM-H4M2P')).json().commande as CommandeVue).client_fidelite_id).toBe(espace!.id);

    const [choisi] = await db.insert(clientsFidelite).values({ id: randomUUID(), telephone: '0101010101' }).returning();
    const autre = await commande(panier());
    await app.inject({ method: 'POST', url: `/api/commandes/${autre}/fidelite`, cookies, payload: { telephone: '0101010101' } });
    expect(((await appliquer(autre, 'PAM-9TQ7D')).json().commande as CommandeVue).client_fidelite_id).toBe(choisi!.id);
  });

  it('autocollant sans numéro : aucun client inventé', async () => {
    const id = await commande(panier());
    expect(((await appliquer(id, 'PAM-7K3QX')).json().commande as CommandeVue).client_fidelite_id).toBeNull();
  });

  it('livraison : le contact du client est rempli par le numéro du code', async () => {
    const c = await app.inject({ method: 'POST', url: '/api/commandes', cookies, payload: { type: 'LIVRAISON', partenaire: 'GLOVO' } });
    const id = c.json().id as string;
    await app.inject({ method: 'POST', url: `/api/commandes/${id}/items`, cookies, payload: { article_id: donnees.pizza_id, quantite: 1, options: [], supplements: [] } });
    const vue = (await appliquer(id, '0708123421', 'TELEPHONE')).json().commande as CommandeVue;
    expect(vue.contact_client).toBe('0708123421');
  });

  it('refuse en clair ce qui ne doit pas passer', async () => {
    const id = await commande(panier());
    const msg = async (saisie: string) => (await appliquer(id, saisie)).json().erreur as string;
    expect(await msg('PAM-2WXK8')).toMatch(/expiré/);
    expect(await msg('ANG-7K3QX')).toMatch(/pas valable dans ce restaurant/);
    expect(await msg('0102030405')).toMatch(/Aucun code promo gardé sur ce numéro/);
    expect(await msg('bonjour')).toMatch(/ni un code promo/);

    const chawarmaSeul = await commande([donnees.article_id]);
    const r = await appliquer(chawarmaSeul, 'PAM-7K3QX');
    expect(r.statusCode).toBe(400);
    expect(r.json().erreur).toMatch(/Aucun article éligible/);
  });

  it('un seul code par commande, et un code ne sert qu’une commande à la fois', async () => {
    const a = await commande(panier());
    expect((await appliquer(a, 'PAM-7K3QX')).statusCode).toBe(200);
    const deuxieme = await appliquer(a, 'PAM-H4M2P');
    expect(deuxieme.statusCode).toBe(409);
    expect(deuxieme.json().erreur).toMatch(/Un seul code par commande/);

    const b = await commande(panier());
    const pris = await appliquer(b, 'PAM-7K3QX');
    expect(pris.statusCode).toBe(409);
    expect(pris.json().erreur).toMatch(/déjà sur une autre commande/);
  });

  it('retirer le code ou annuler la commande le libère (R8), le numéro reste attaché', async () => {
    const a = await commande(panier());
    await appliquer(a, '0708123421');
    const retire = await app.inject({ method: 'DELETE', url: `/api/commandes/${a}/code-promo`, cookies });
    expect((retire.json() as CommandeVue).total).toBe(10500);
    expect((await local(ids.telTot)).local_statut).toBeNull();

    await appliquer(a, '0708123421');
    const manager = await app.inject({
      method: 'POST', url: `/api/commandes/${a}/annuler`, cookies,
      payload: { motif: 'Client parti', pin_manager: PIN_MANAGER },
    });
    expect(manager.statusCode, manager.body).toBe(200);
    expect(await local(ids.telTot)).toMatchObject({ local_statut: null, telephone: TEL });
  });

  it('paiement par articles : une note de Chawarma seul ne prend rien du code', async () => {
    const id = await commande(panier());
    const c = (await appliquer(id, 'PAM-7K3QX')).json().commande as CommandeVue;
    const chawarma = c.items.find((i) => i.nom_snapshot === 'Chawarma Poulet')!;
    const r = await app.inject({
      method: 'POST', url: `/api/commandes/${id}/sous-notes`, cookies,
      payload: { items: [{ commande_item_id: chawarma.id, quantite: 1 }], fidelite_points: 0 },
    });
    expect(r.statusCode, r.body).toBe(200);
    const [note] = await db.select().from(notesSplit).where(eq(notesSplit.commande_id, id));
    expect(note).toMatchObject({ sous_total: 3000, code_promo_montant: 0, montant: 3000 });

    const reste = (await app.inject({ method: 'GET', url: `/api/commandes/${id}`, cookies })).json() as CommandeVue;
    expect(reste.total).toBe(9000);
  });
});

describe('encaissement et remontée au cloud (PROMO-10)', () => {
  const evenements = async (codeId: string) =>
    (await db.select().from(syncOutbox).where(eq(syncOutbox.table_name, 'promo_utilisations')))
      .map((l) => l.payload as Record<string, unknown>)
      .filter((p) => p.code_id === codeId)
      .map((p) => `${p.evenement}:${p.montant}`);

  it('l’encaissement passe le code UTILISE ici, et le dit au cloud avec le montant', async () => {
    const id = await commande(panier());
    const c = (await appliquer(id, 'PAM-7K3QX', 'TELEPHONE')).json().commande as CommandeVue;
    const r = await app.inject({
      method: 'POST', url: `/api/commandes/${id}/paiements`, cookies,
      payload: { mode: 'ESPECES', montant: c.total, montant_recu: c.total },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as CommandeVue).statut).toBe('PAYEE');
    expect(await local(ids.libre)).toMatchObject({ local_statut: 'UTILISE', local_commande_id: id, local_canal: 'TELEPHONE' });
    expect(await evenements(ids.libre)).toEqual(['RESERVE:0', 'UTILISE:1500']);

    const ailleurs = await commande(panier());
    const refus = await appliquer(ailleurs, 'PAM-7K3QX');
    expect(refus.json().erreur).toMatch(/déjà servi/);
  });

  it('une commande annulée remonte la libération du code', async () => {
    const id = await commande(panier());
    await appliquer(id, 'PAM-7K3QX');
    await app.inject({ method: 'POST', url: `/api/commandes/${id}/annuler`, cookies, payload: { motif: 'Client parti', pin_manager: PIN_MANAGER } });
    expect(await evenements(ids.libre)).toEqual(['RESERVE:0', 'LIBERE:0']);
  });

  it('un repas offert ne garde pas de code promo', async () => {
    const id = await commande(panier());
    await appliquer(id, 'PAM-7K3QX');
    await db.execute(sql`UPDATE commandes SET offert = true WHERE id = ${id}`);
    const r = await app.inject({ method: 'POST', url: `/api/commandes/${id}/offrir`, cookies, payload: { motif: 'Client fidèle' } });
    expect(r.statusCode).toBe(409);
    expect(r.json().erreur).toMatch(/Retirez d’abord le code promo/);
  });
});

describe('ticket (PROMO-10)', () => {
  it('affiche le code masqué et la remise, jamais le code en clair', async () => {
    const id = await commande(panier());
    const c = (await appliquer(id, 'PAM-7K3QX')).json().commande as CommandeVue;
    const espion = vi.spyOn(console, 'log').mockImplementation(() => {});
    await new ConsolePrinter().imprimerFacture(c);
    const ticket = espion.mock.calls.map((a) => String(a[0])).join('\n');
    espion.mockRestore();
    expect(ticket).toMatch(/Code promo -20 % PAM-•••QX\s+-1\s?500/);
    expect(ticket).not.toContain('PAM-7K3QX');
  });
});
