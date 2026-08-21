/** Aides de test : données minimales + connexion PIN via l'API. */
import argon2 from 'argon2';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../src/db/client.js';
import { etablirRolesSysteme } from '../src/modules/roles/service.js';
import {
  articles,
  categories,
  mappingPosteCategorie,
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
/** Jeton d'appareil KDS des fixtures (correction 3 — plus de PIN sur le KDS). */
export const JETON_KDS = 'JETON-KDS-TEST';

export interface Donnees {
  proprio_id: string;
  manager_id: string;
  caissier_id: string;
  caissier2_id: string;
  serveur_id: string;
  cuisine_id: string;
  pizzaiolo_id: string;
  article_id: string;
  pizza_id: string;
  supplement_id: string;
  table_id: string;
  table_qr: string;
  table2_id: string;
  table2_qr: string;
  /** Table virtuelle des repas offerts (zone RC). */
  table_kdo_id: string;
  /** Table virtuelle Yango (zone Livraison). */
  table_yango_id: string;
  zone_id: string;
  roles: Record<string, string>;
}

/** Vide la base de test et insère le strict nécessaire (sans promotions). */
export async function resetDonnees(): Promise<Donnees> {
  await db.execute(sql`
    TRUNCATE TABLE appels_table, actions_recues, points_fidelite, clients_fidelite,
      notations, sync_etat, sync_outbox, audit_log, paiements, notes_split, equipe_service,
      depenses, entrees_stock, inventaire_lignes, inventaires_service, produits_inventaire,
      commande_items, commandes, services_caisse, tables_salle, zones,
      promotions, mapping_poste_categorie, combo_articles, combos, supplements,
      options, groupes_options, prix_canaux, articles, categories,
      role_permissions, utilisateurs, roles,
      parametres_locaux, restaurant
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
    { cle: 'kds_jeton_appareil', valeur: 'JETON-KDS-TEST' },
    // Sprint 4 : fidélité
    { cle: 'fidelite_points_par_tranche', valeur: { tranche_fcfa: 1000, points: 1 } },
    { cle: 'fidelite_valeur_point_fcfa', valeur: 10 },
    { cle: 'fidelite_seuil_utilisation', valeur: 50 },
  ]);

  // Rôles système (sprint 4B+4C) puis utilisateurs raccordés
  const roleIdParNom = await etablirRolesSysteme(db);
  const rid = (nom: string) => roleIdParNom.get(nom)!;

  const [proprio, manager, caissier, caissier2, serveur, cuisine, pizzaiolo] = await db
    .insert(utilisateurs)
    .values([
      { nom_complet: 'Proprio Test', role: 'PROPRIETAIRE', role_id: rid('PROPRIETAIRE'), pin_hash: await hacher(PIN_PROPRIO), telephone: '+2250700000001' },
      { nom_complet: 'Manager Test', role: 'MANAGER', role_id: rid('MANAGER'), pin_hash: await hacher(PIN_MANAGER), telephone: '+2250700000002' },
      { nom_complet: 'Caissier Test', role: 'CAISSIER', role_id: rid('CAISSIER'), pin_hash: await hacher(PIN_CAISSIER), telephone: '+2250700000003' },
      { nom_complet: 'Caissier Suivant', role: 'CAISSIER', role_id: rid('CAISSIER'), pin_hash: await hacher(PIN_CAISSIER2), telephone: '+2250700000004' },
      { nom_complet: 'Serveur Test', role: 'SERVEUR', role_id: rid('SERVEUR'), pin_hash: await hacher(PIN_SERVEUR), telephone: '+2250700000005' },
      { nom_complet: 'Cuisine Test', role: 'CUISINE', role_id: rid('CUISINE'), poste_cuisine: 'CUISINIER', pin_hash: await hacher(PIN_CUISINE), telephone: '+2250700000007' },
      { nom_complet: 'Pizzaiolo Test', role: 'CUISINE', role_id: rid('CUISINE'), poste_cuisine: 'PIZZAIOLO', pin_hash: await hacher(PIN_CUISINE), telephone: '+2250700000008' },
    ])
    .returning();

  const [cat, catPizzas] = await db
    .insert(categories)
    .values([
      { nom: 'Chawarmas', ordre: 1 },
      { nom: 'Pizzas', ordre: 2 },
    ])
    .returning();
  const [article, pizza] = await db
    .insert(articles)
    .values([
      { categorie_id: cat!.id, nom: 'Chawarma Poulet', prix_base: 3000 },
      { categorie_id: catPizzas!.id, nom: 'Pizza Test', prix_base: 6000 },
    ])
    .returning();
  const [suppl] = await db
    .insert(supplements)
    .values({ article_id: article!.id, nom: 'Frites', prix: 1000 })
    .returning();

  // Correction 4 : mapping poste ↔ catégorie pour l'attribution automatique
  await db.insert(mappingPosteCategorie).values([
    { poste_cuisine: 'CUISINIER', categorie_id: cat!.id },
    { poste_cuisine: 'PIZZAIOLO', categorie_id: catPizzas!.id },
  ]);

  const [zone] = await db.insert(zones).values({ nom: 'RC', ordre: 1 }).returning();
  // Tables VIRTUELLES : le Kdo vit en RC (le cadeau se consomme sur place),
  // Yango dans la zone Livraison — comme en production.
  const [zoneLivraison] = await db.insert(zones).values({ nom: 'Livraison', ordre: 4 }).returning();
  const [table, table2, tableKdo, tableYango] = await db
    .insert(tablesSalle)
    .values([
      { zone_id: zone!.id, numero: 'T1', qr_token: 'QR-T1-TEST' },
      { zone_id: zone!.id, numero: 'T2', qr_token: 'QR-T2-TEST' },
      { zone_id: zone!.id, numero: 'KDO', partenaire: 'KDO' },
      { zone_id: zoneLivraison!.id, numero: 'YANGO', partenaire: 'YANGO' },
    ])
    .returning();

  return {
    proprio_id: proprio!.id,
    manager_id: manager!.id,
    caissier_id: caissier!.id,
    caissier2_id: caissier2!.id,
    serveur_id: serveur!.id,
    cuisine_id: cuisine!.id,
    pizzaiolo_id: pizzaiolo!.id,
    article_id: article!.id,
    pizza_id: pizza!.id,
    supplement_id: suppl!.id,
    table_id: table!.id,
    table_qr: table!.qr_token!,
    table2_id: table2!.id,
    table2_qr: table2!.qr_token!,
    table_kdo_id: tableKdo!.id,
    table_yango_id: tableYango!.id,
    zone_id: zone!.id,
    roles: Object.fromEntries(roleIdParNom),
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

/**
 * Valide l'inventaire du service en cours — indispensable avant toute clôture
 * depuis DESIGN_V2 § 6.10 (« sans inventaire validé, pas de clôture »).
 *
 * Compte chaque produit restant À SON THÉORIQUE (écart nul), puis valide. Le
 * catalogue de comptage est vidé par `resetDonnees` (TRUNCATE ... CASCADE le
 * fait tomber avec `articles`), donc dans la plupart des tests il n'y a rien à
 * compter et l'appel se réduit à la validation. Les tests qui veulent exercer
 * le calcul seedent leurs propres produits (voir inventaire.test.ts).
 */
export async function validerInventaire(
  app: FastifyInstance,
  cookies: Record<string, string>,
): Promise<void> {
  const etat = await app.inject({ method: 'GET', url: '/api/inventaire', cookies });
  if (etat.statusCode !== 200) throw new Error(`Lecture inventaire: ${etat.body}`);
  const lignes = etat.json().lignes as {
    produit_id: string;
    a_compter: boolean;
    stock_compte: number | null;
    theorique: number;
  }[];

  for (const l of lignes) {
    if (!l.a_compter || l.stock_compte !== null) continue;
    const rep = await app.inject({
      method: 'PUT',
      url: `/api/inventaire/lignes/${l.produit_id}`,
      cookies,
      payload: { stock_compte: l.theorique },
    });
    if (rep.statusCode !== 200) throw new Error(`Comptage inventaire: ${rep.body}`);
  }

  const validation = await app.inject({ method: 'POST', url: '/api/inventaire/valider', cookies });
  if (validation.statusCode !== 200) throw new Error(`Validation inventaire: ${validation.body}`);
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
