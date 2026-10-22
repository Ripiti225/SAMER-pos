/**
 * Stock en cuisine sous la photo des plats (2026-10-22).
 *
 * Parcours complet sur l'API : le stock suit les réceptions, les ventes ET les
 * envois en cuisine ; la caisse et la tablette vendent toujours un plat épuisé ;
 * la page client le grise et le serveur le lui refuse ; les corrections des
 * Réglages et le seuil du site s'appliquent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { CatalogueVue, StockPlatsVue } from '@pos/shared';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { inventaireConsommations, produitsInventaire } from '../src/db/schema/index.js';
import {
  creerVisiteQr,
  PIN_CAISSIER,
  PIN_MANAGER,
  PIN_SERVEUR,
  resetDonnees,
  seConnecter,
  validerInventaire,
  type Donnees,
} from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let caisse: Record<string, string>;
let manager: Record<string, string>;
let serveur: Record<string, string>;
let pain: string;
let totalFromage: string;

const stock = async (): Promise<StockPlatsVue> => {
  const rep = await app.inject({ method: 'GET', url: '/api/stock-plats', cookies: caisse });
  expect(rep.statusCode).toBe(200);
  return rep.json();
};

const recevoir = async (produit_id: string, quantite: number) => {
  const rep = await app.inject({ method: 'POST', url: '/api/inventaire/entrees', cookies: caisse, payload: { produit_id, quantite } });
  expect(rep.statusCode).toBe(200);
};

/** Commande caisse à emporter, encaissée en espèces. */
const vendreEtEncaisser = async (articleId: string, quantite: number, prix: number) => {
  const c = (await app.inject({ method: 'POST', url: '/api/commandes', cookies: caisse, payload: { type: 'EMPORTER' } })).json();
  const item = await app.inject({
    method: 'POST',
    url: `/api/commandes/${c.id}/items`,
    cookies: caisse,
    payload: { article_id: articleId, quantite, options: [], supplements: [] },
  });
  expect(item.statusCode).toBe(200);
  const p = await app.inject({ method: 'POST', url: `/api/commandes/${c.id}/paiements`, cookies: caisse, payload: { mode: 'ESPECES', montant: prix * quantite } });
  expect(p.statusCode).toBe(200);
};

const commanderQr = async (articleId: string) => {
  const visite = await creerVisiteQr(app, donnees.table2_qr);
  return app.inject({
    method: 'POST',
    url: `/api/client/${donnees.table2_qr}/commande`,
    headers: visite,
    payload: { items: [{ article_id: articleId, quantite: 1, options: [], supplements: [] }] },
  });
};

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  caisse = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  manager = await seConnecter(app, donnees.manager_id, PIN_MANAGER);
  serveur = await seConnecter(app, donnees.serveur_id, PIN_SERVEUR);

  // La Pizza Test consomme 160 g de fromage (pizza moyenne) ; le Chawarma un pain.
  const [p1, f4, f10] = await db
    .insert(produitsInventaire)
    .values([
      { code: 'p1', categorie: 'PAIN', nom: 'Pain chawarma', prix: 100, role: 'COMPTE', ordre: 1 },
      { code: 'f4', categorie: 'FROM', nom: 'Pizza moyenne (160g)', unite: 'g', role: 'CONSO_FROMAGE', ratio: '160', ordre: 3 },
      { code: 'f10', categorie: 'FROM', nom: 'Total Fromage', prix: 5, unite: 'g', role: 'TOTAL_FROMAGE', ordre: 9 },
    ])
    .returning();
  pain = p1!.id;
  totalFromage = f10!.id;
  await db.insert(inventaireConsommations).values([
    { produit_id: pain, article_id: donnees.article_id, quantite: '1' },
    { produit_id: f4!.id, article_id: donnees.pizza_id, quantite: '1' },
  ]);
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('stock en cuisine sous la photo des plats', () => {
  it('sans shift ni inventaire : rien d’affiché, rien de bloqué', async () => {
    const vue = await stock();
    expect(vue.source).toBe('AUCUNE');
    expect(vue.plats).toEqual({});
    const qr = await commanderQr(donnees.pizza_id);
    expect(qr.statusCode).toBe(200);
  });

  it('shift ouvert : un produit jamais compté ni reçu ne s’affiche pas (pas de faux « épuisé »)', async () => {
    const ouvrir = await app.inject({ method: 'POST', url: '/api/services/ouvrir', cookies: caisse, payload: { fond_de_caisse: 25000 } });
    expect(ouvrir.statusCode).toBe(200);
    const vue = await stock();
    expect(vue.source).toBe('SERVICE');
    expect(vue.seuil).toBe(5);
    expect(vue.plats[donnees.pizza_id]).toBeUndefined();
    // La lecture n'ouvre pas l'inventaire du service (aucune écriture).
    const etat = await app.inject({ method: 'GET', url: '/api/inventaire/etat', cookies: caisse });
    expect(etat.json().commence).toBe(false);
  });

  it('suit la réception puis la vente : « Fromage 1 kg · ≈ 6 », puis orange à 5', async () => {
    await recevoir(totalFromage, 1000);
    await recevoir(pain, 40);
    let vue = await stock();
    expect(vue.plats[donnees.pizza_id]).toMatchObject({
      raison: 'FROMAGE',
      stock: 1000,
      plats_possibles: 6,
      etat: 'OK',
      texte: 'Fromage 1 kg · ≈ 6',
    });
    expect(vue.plats[donnees.article_id]).toMatchObject({ raison: 'INGREDIENT', plats_possibles: 40, texte: 'Pain chawarma 40 · ≈ 40' });

    await vendreEtEncaisser(donnees.pizza_id, 1, 6000);
    vue = await stock();
    expect(vue.plats[donnees.pizza_id]).toMatchObject({ stock: 840, plats_possibles: 5, etat: 'BIENTOT', texte: 'Fromage 840 g · ≈ 5' });
  });

  it('un envoi en cuisine pas encore payé compte déjà : la tablette épuise la pizza', async () => {
    const envoi = await app.inject({
      method: 'POST',
      url: '/api/serveur/envoyer',
      cookies: serveur,
      payload: {
        action_uuid: crypto.randomUUID(),
        table_id: donnees.table_id,
        items: [{ article_id: donnees.pizza_id, quantite: 5, options: [], supplements: [] }],
      },
    });
    expect(envoi.statusCode).toBe(200);
    const vue = await stock();
    expect(vue.plats[donnees.pizza_id]).toMatchObject({ stock: 40, plats_possibles: 0, etat: 'EPUISE' });
  });

  it('page client : le plat épuisé est grisé, sans jamais une quantité', async () => {
    const rep = await app.inject({ method: 'GET', url: `/api/client/${donnees.table2_qr}/catalogue` });
    const catalogue = rep.json() as CatalogueVue;
    expect(catalogue.articles.find((a) => a.id === donnees.pizza_id)?.disponible).toBe(false);
    expect(catalogue.articles.find((a) => a.id === donnees.article_id)?.disponible).toBe(true);
    expect(rep.body).not.toContain('Fromage');
    expect(rep.body).not.toContain('plats_possibles');
  });

  it('page client : l’API refuse la commande d’un plat épuisé, accepte les autres', async () => {
    const refus = await commanderQr(donnees.pizza_id);
    expect(refus.statusCode).toBe(409);
    expect(refus.json().erreur).toContain('épuisé');
    const ok = await commanderQr(donnees.article_id);
    expect(ok.statusCode).toBe(200);
  });

  it('la caisse et la tablette peuvent toujours vendre un plat épuisé', async () => {
    const c = (await app.inject({ method: 'POST', url: '/api/commandes', cookies: caisse, payload: { type: 'EMPORTER' } })).json();
    const item = await app.inject({
      method: 'POST',
      url: `/api/commandes/${c.id}/items`,
      cookies: caisse,
      payload: { article_id: donnees.pizza_id, quantite: 1, options: [], supplements: [] },
    });
    expect(item.statusCode).toBe(200);
    const tablette = await app.inject({
      method: 'POST',
      url: '/api/serveur/envoyer',
      cookies: serveur,
      payload: {
        action_uuid: crypto.randomUUID(),
        table_id: donnees.table_id,
        items: [{ article_id: donnees.pizza_id, quantite: 1, options: [], supplements: [] }],
      },
    });
    expect(tablette.statusCode).toBe(200);
  });

  it('Réglages : correction manuelle plat par plat (rien / un produit / automatique)', async () => {
    const interdit = await app.inject({ method: 'PUT', url: `/api/admin/stock-plats/${donnees.pizza_id}`, cookies: caisse, payload: { mode: 'AUCUN' } });
    expect(interdit.statusCode).toBe(403);

    const liste = await app.inject({ method: 'GET', url: '/api/admin/stock-plats', cookies: manager });
    expect(liste.statusCode).toBe(200);
    const pizza = liste.json().articles.find((a: { article_id: string }) => a.article_id === donnees.pizza_id);
    expect(pizza).toMatchObject({ mode: 'AUTO', automatique: { produit_id: totalFromage, raison: 'FROMAGE' } });

    const rien = await app.inject({ method: 'PUT', url: `/api/admin/stock-plats/${donnees.pizza_id}`, cookies: manager, payload: { mode: 'AUCUN' } });
    expect(rien.statusCode).toBe(200);
    expect((await stock()).plats[donnees.pizza_id]).toBeUndefined();
    // Plus rien d'affiché, plus rien de refusé au QR.
    expect((await commanderQr(donnees.pizza_id)).statusCode).toBe(200);

    const precis = await app.inject({
      method: 'PUT',
      url: `/api/admin/stock-plats/${donnees.pizza_id}`,
      cookies: manager,
      payload: { mode: 'PRODUIT', produit_id: pain },
    });
    expect(precis.statusCode).toBe(200);
    // La recette de la pizza ne consomme pas de pain : stock seul, sans « ≈ ».
    expect((await stock()).plats[donnees.pizza_id]).toMatchObject({ raison: 'MANUEL', produit_id: pain, plats_possibles: null, texte: 'Pain chawarma 40' });

    const auto = await app.inject({ method: 'PUT', url: `/api/admin/stock-plats/${donnees.pizza_id}`, cookies: manager, payload: { mode: 'AUTO' } });
    expect(auto.statusCode).toBe(200);
    expect((await stock()).plats[donnees.pizza_id]).toMatchObject({ raison: 'FROMAGE', etat: 'EPUISE' });

    const invalide = await app.inject({ method: 'PUT', url: `/api/admin/stock-plats/${donnees.pizza_id}`, cookies: manager, payload: { mode: 'PRODUIT' } });
    expect(invalide.statusCode).toBe(400);
  });

  it('le seuil orange se règle par site dans les Paramètres', async () => {
    const rep = await app.inject({
      method: 'PATCH',
      url: '/api/admin/parametres',
      cookies: manager,
      payload: { cle: 'stock_plats_seuil_bientot_epuise', valeur: 50 },
    });
    expect(rep.statusCode).toBe(200);
    const vue = await stock();
    expect(vue.seuil).toBe(50);
    // 40 pains = 40 chawarmas possibles : orange avec un seuil à 50.
    expect(vue.plats[donnees.article_id]?.etat).toBe('BIENTOT');
  });

  it('entre deux shifts : le dernier inventaire validé, celui que le shift suivant reprendra', async () => {
    // Les commandes ouvertes de ce fichier n'importent plus : on les annule
    // pour pouvoir clôturer (« rien d'impayé » n'est pas l'objet ici).
    await db.execute(sql`UPDATE commandes SET statut = 'ANNULEE' WHERE statut <> 'PAYEE'`);
    await validerInventaire(app, caisse);
    const cloture = await app.inject({ method: 'POST', url: '/api/services/cloturer', cookies: caisse, payload: { especes_comptees: 31000 } });
    expect(cloture.statusCode).toBe(200);

    const vue = await stock();
    expect(vue.source).toBe('DERNIER_INVENTAIRE');
    // Compté au théorique : 1000 − 160 (seule la pizza encaissée sort) = 840 g.
    expect(vue.plats[donnees.pizza_id]).toMatchObject({ stock: 840, plats_possibles: 5 });
  });
});
