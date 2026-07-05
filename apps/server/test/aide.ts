/** Aides de test : données minimales + connexion PIN via l'API. */
import argon2 from 'argon2';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../src/db/client.js';
import {
  articles,
  categories,
  parametresLocaux,
  restaurant,
  supplements,
  tablesSalle,
  utilisateurs,
  zones,
} from '../src/db/schema/index.js';

const cacheHash = new Map<string, string>();
async function hacher(pin: string): Promise<string> {
  let h = cacheHash.get(pin);
  if (!h) {
    h = await argon2.hash(pin, { type: argon2.argon2id });
    cacheHash.set(pin, h);
  }
  return h;
}

export const PIN_PROPRIO = '852741';
export const PIN_MANAGER = '963852';
export const PIN_CAISSIER = '2580';
export const PIN_CAISSIER2 = '4826';
export const PIN_SERVEUR = '1357';
export const PIN_CUISINE = '7913';

export interface Donnees {
  proprio_id: string;
  manager_id: string;
  caissier_id: string;
  caissier2_id: string;
  serveur_id: string;
  cuisine_id: string;
  article_id: string;
  supplement_id: string;
  table_id: string;
}

/** Vide la base de test et insère le strict nécessaire (sans promotions). */
export async function resetDonnees(): Promise<Donnees> {
  await db.execute(sql`
    TRUNCATE TABLE actions_recues, points_fidelite, clients_fidelite, codes_pointage, pointages,
      notations, sync_etat, sync_outbox, audit_log, paiements, notes_split,
      commande_items, commandes, services_caisse, tables_salle, zones,
      promotions, combo_articles, combos, supplements, options, groupes_options,
      prix_canaux, articles, categories, utilisateurs, parametres_locaux, restaurant
      RESTART IDENTITY CASCADE
  `);
  await db.execute(sql`ALTER SEQUENCE seq_numero_ticket RESTART WITH 1`);

  await db.insert(restaurant).values({
    code: 'TEST',
    nom: 'Restaurant de test',
    marque: 'SAMER',
    couleur_hex: '#EF9F27',
  });
  await db.insert(parametresLocaux).values([
    { cle: 'seuil_alerte_ecart_caisse', valeur: 2000 },
    { cle: 'verrouillage_inactivite_secondes', valeur: 60 },
  ]);

  const [proprio, manager, caissier, caissier2, serveur, cuisine] = await db
    .insert(utilisateurs)
    .values([
      { nom_complet: 'Proprio Test', role: 'PROPRIETAIRE', pin_hash: await hacher(PIN_PROPRIO) },
      { nom_complet: 'Manager Test', role: 'MANAGER', pin_hash: await hacher(PIN_MANAGER) },
      { nom_complet: 'Caissier Test', role: 'CAISSIER', pin_hash: await hacher(PIN_CAISSIER) },
      { nom_complet: 'Caissier Suivant', role: 'CAISSIER', pin_hash: await hacher(PIN_CAISSIER2) },
      { nom_complet: 'Serveur Test', role: 'SERVEUR', pin_hash: await hacher(PIN_SERVEUR) },
      { nom_complet: 'Cuisine Test', role: 'CUISINE', poste_cuisine: 'CUISINIER', pin_hash: await hacher(PIN_CUISINE) },
    ])
    .returning();

  const [cat] = await db.insert(categories).values({ nom: 'Chawarmas', ordre: 1 }).returning();
  const [article] = await db
    .insert(articles)
    .values({ categorie_id: cat!.id, nom: 'Chawarma Poulet', prix_base: 3000 })
    .returning();
  const [suppl] = await db
    .insert(supplements)
    .values({ article_id: article!.id, nom: 'Frites', prix: 1000 })
    .returning();

  const [zone] = await db.insert(zones).values({ nom: 'RC', ordre: 1 }).returning();
  const [table] = await db.insert(tablesSalle).values({ zone_id: zone!.id, numero: 'T1' }).returning();

  return {
    proprio_id: proprio!.id,
    manager_id: manager!.id,
    caissier_id: caissier!.id,
    caissier2_id: caissier2!.id,
    serveur_id: serveur!.id,
    cuisine_id: cuisine!.id,
    article_id: article!.id,
    supplement_id: suppl!.id,
    table_id: table!.id,
  };
}

/** Connexion via l'API ; retourne le cookie de session à réinjecter. */
export async function seConnecter(
  app: FastifyInstance,
  utilisateurId: string,
  pin: string,
): Promise<Record<string, string>> {
  const rep = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { utilisateur_id: utilisateurId, pin },
  });
  if (rep.statusCode !== 200) {
    throw new Error(`Connexion de test échouée (${rep.statusCode}): ${rep.body}`);
  }
  const cookie = rep.cookies.find((c) => c.name === 'pos_session');
  if (!cookie) throw new Error('Cookie de session absent');
  return { pos_session: cookie.value };
}

/** Ouvre un service et crée une commande à emporter avec 1 article. */
export async function ouvrirServiceEtCommande(
  app: FastifyInstance,
  cookies: Record<string, string>,
  donnees: Donnees,
  quantite = 2,
): Promise<{ commande_id: string; total: number; service_id: string }> {
  const repService = await app.inject({
    method: 'POST',
    url: '/api/services/ouvrir',
    cookies,
    payload: { fond_de_caisse: 25000 },
  });
  if (repService.statusCode !== 200) throw new Error(`Ouverture service: ${repService.body}`);
  const service = repService.json() as { id: string };

  const repCommande = await app.inject({
    method: 'POST',
    url: '/api/commandes',
    cookies,
    payload: { type: 'EMPORTER' },
  });
  if (repCommande.statusCode !== 200) throw new Error(`Création commande: ${repCommande.body}`);
  const commande = repCommande.json() as { id: string };

  const repItem = await app.inject({
    method: 'POST',
    url: `/api/commandes/${commande.id}/items`,
    cookies,
    payload: { article_id: donnees.article_id, quantite, options: [], supplements: [] },
  });
  if (repItem.statusCode !== 200) throw new Error(`Ajout item: ${repItem.body}`);
  const vue = repItem.json() as { id: string; total: number };

  return { commande_id: commande.id, total: vue.total, service_id: service.id };
}
