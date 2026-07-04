/**
 * Seed de démonstration (voir CLAUDE.md).
 * Réinitialise les données puis insère le restaurant SAMER_ANGRE7E complet.
 */
import argon2 from 'argon2';
import { sql } from 'drizzle-orm';
import { db, fermerDb } from './client.js';
import {
  articles,
  categories,
  comboArticles,
  combos,
  groupesOptions,
  options,
  parametresLocaux,
  prixCanaux,
  promotions,
  restaurant,
  supplements,
  tablesSalle,
  utilisateurs,
  zones,
} from './schema/index.js';

export async function hacherPin(pin: string): Promise<string> {
  return argon2.hash(pin, { type: argon2.argon2id });
}

export async function seed(): Promise<void> {
  // Remise à zéro complète (TRUNCATE n'est pas bloqué par le trigger append-only,
  // qui ne vise que UPDATE/DELETE ligne à ligne — acceptable pour un seed de démo).
  await db.execute(sql`
    TRUNCATE TABLE points_fidelite, clients_fidelite, codes_pointage, pointages,
      notations, sync_etat, sync_outbox, audit_log, paiements, notes_split,
      commande_items, commandes, services_caisse, tables_salle, zones,
      promotions, combo_articles, combos, supplements, options, groupes_options,
      prix_canaux, articles, categories, utilisateurs, parametres_locaux, restaurant
      RESTART IDENTITY CASCADE
  `);
  await db.execute(sql`ALTER SEQUENCE seq_numero_ticket RESTART WITH 1`);

  await db.insert(restaurant).values({
    code: 'SAMER_ANGRE7E',
    nom: 'Chez Samer Angré 7E',
    marque: 'SAMER',
    couleur_hex: '#EF9F27',
  });

  await db.insert(parametresLocaux).values([
    { cle: 'seuil_alerte_ecart_caisse', valeur: 2000 },
    { cle: 'verrouillage_inactivite_secondes', valeur: 60 },
  ]);

  // --- Utilisateurs (PIN de démo — à changer en production) ---
  await db.insert(utilisateurs).values([
    { nom_complet: 'Samer El Khoury', role: 'PROPRIETAIRE', pin_hash: await hacherPin('852741') },
    { nom_complet: 'Awa Koné', role: 'MANAGER', pin_hash: await hacherPin('963852') },
    { nom_complet: 'Mariam Diabaté', role: 'CAISSIER', pin_hash: await hacherPin('2580') },
    { nom_complet: 'Ibrahim Traoré', role: 'CAISSIER', pin_hash: await hacherPin('4826') },
    { nom_complet: 'Fatou Bamba', role: 'SERVEUR', pin_hash: await hacherPin('1357') },
    { nom_complet: 'Moussa Cissé', role: 'SERVEUR', pin_hash: await hacherPin('2468') },
  ]);

  // --- Catalogue ---
  const [catChawarmas, catPizzas, catGrillades, catBoissons] = await db
    .insert(categories)
    .values([
      { nom: 'Chawarmas', ordre: 1 },
      { nom: 'Pizzas', ordre: 2 },
      { nom: 'Grillades', ordre: 3 },
      { nom: 'Boissons', ordre: 4 },
    ])
    .returning();

  const lignesArticles = await db
    .insert(articles)
    .values([
      { categorie_id: catChawarmas!.id, nom: 'Chawarma Poulet', prix_base: 3000, description: 'Poulet mariné, crudités, sauce à l’ail' },
      { categorie_id: catChawarmas!.id, nom: 'Chawarma Viande', prix_base: 3500 },
      { categorie_id: catChawarmas!.id, nom: 'Chawarma Mixte', prix_base: 4000 },
      { categorie_id: catChawarmas!.id, nom: 'Chawarma Spécial Fromage', prix_base: 4500 },
      { categorie_id: catPizzas!.id, nom: 'Pizza Margherita', prix_base: 6500 },
      { categorie_id: catPizzas!.id, nom: 'Pizza Poulet', prix_base: 7500 },
      { categorie_id: catPizzas!.id, nom: 'Pizza Viande Hachée', prix_base: 8000 },
      { categorie_id: catPizzas!.id, nom: 'Pizza 4 Fromages', prix_base: 8500 },
      { categorie_id: catGrillades!.id, nom: 'Poulet Braisé (entier)', prix_base: 9000 },
      { categorie_id: catGrillades!.id, nom: 'Demi Poulet Braisé', prix_base: 5000 },
      { categorie_id: catGrillades!.id, nom: 'Brochettes de Bœuf (x3)', prix_base: 4000 },
      { categorie_id: catBoissons!.id, nom: 'Jus d’Ananas Frais', prix_base: 1500 },
      { categorie_id: catBoissons!.id, nom: 'Jus de Gingembre', prix_base: 1500 },
      { categorie_id: catBoissons!.id, nom: 'Coca-Cola 33cl', prix_base: 1000 },
      { categorie_id: catBoissons!.id, nom: 'Eau Minérale 50cl', prix_base: 500 },
    ])
    .returning();

  const parNom = new Map(lignesArticles.map((a) => [a.nom, a]));
  const chawarmaPoulet = parNom.get('Chawarma Poulet')!;
  const chawarmaViande = parNom.get('Chawarma Viande')!;
  const pizzaMargherita = parNom.get('Pizza Margherita')!;
  const coca = parNom.get('Coca-Cola 33cl')!;

  // Surcharges de prix par canal (§5.2)
  await db.insert(prixCanaux).values([
    { article_id: chawarmaPoulet.id, canal: 'YANGO', prix: 3500 },
    { article_id: chawarmaPoulet.id, canal: 'GLOVO', prix: 3800 },
    { article_id: chawarmaViande.id, canal: 'YANGO', prix: 4000 },
    { article_id: chawarmaViande.id, canal: 'GLOVO', prix: 4300 },
    { article_id: pizzaMargherita.id, canal: 'YANGO', prix: 7000 },
    { article_id: pizzaMargherita.id, canal: 'GLOVO', prix: 7500 },
  ]);

  // Groupe d'options « Sauce » sur le Chawarma Poulet
  const [groupeSauce] = await db
    .insert(groupesOptions)
    .values({ article_id: chawarmaPoulet.id, nom: 'Sauce', choix_min: 0, choix_max: 1 })
    .returning();
  await db.insert(options).values([
    { groupe_id: groupeSauce!.id, nom: 'Sauce à l’ail' },
    { groupe_id: groupeSauce!.id, nom: 'Sauce piquante' },
    { groupe_id: groupeSauce!.id, nom: 'Sauce blanche' },
  ]);

  // Suppléments payants
  await db.insert(supplements).values([
    { article_id: chawarmaPoulet.id, nom: 'Fromage', prix: 500 },
    { article_id: chawarmaPoulet.id, nom: 'Frites', prix: 1000 },
  ]);

  // Combo « Chawarma + Boisson » à prix packagé
  const [combo] = await db
    .insert(combos)
    .values({ nom: 'Combo Chawarma + Boisson', prix: 4000 })
    .returning();
  await db.insert(comboArticles).values([
    { combo_id: combo!.id, article_id: chawarmaPoulet.id, quantite: 1 },
    { combo_id: combo!.id, article_id: coca.id, quantite: 1 },
  ]);

  // Happy hour −20 % sur tout le menu, 17 h à 19 h, tous les jours
  await db.insert(promotions).values({
    nom: 'Happy Hour −20 %',
    type: 'POURCENTAGE',
    valeur: 20,
    heure_debut: '17:00',
    heure_fin: '19:00',
    jours: [1, 2, 3, 4, 5, 6, 7],
  });

  // --- Plan de salle : simple liste de tables (sprint 1) ---
  const [zoneRC, zoneTerrasse, zoneVIP, zoneLivraison] = await db
    .insert(zones)
    .values([
      { nom: 'RC', ordre: 1 },
      { nom: 'Terrasse', ordre: 2 },
      { nom: 'VIP', ordre: 3 },
      { nom: 'Livraison', ordre: 4 },
    ])
    .returning();

  await db.insert(tablesSalle).values([
    ...Array.from({ length: 6 }, (_, i) => ({ zone_id: zoneRC!.id, numero: `T${i + 1}` })),
    ...Array.from({ length: 4 }, (_, i) => ({ zone_id: zoneTerrasse!.id, numero: `TE${i + 1}` })),
    ...Array.from({ length: 2 }, (_, i) => ({ zone_id: zoneVIP!.id, numero: `VIP${i + 1}` })),
    { zone_id: zoneLivraison!.id, numero: 'YANGO', partenaire: 'YANGO' },
    { zone_id: zoneLivraison!.id, numero: 'GLOVO', partenaire: 'GLOVO' },
    { zone_id: zoneLivraison!.id, numero: 'SAMER DELIV', partenaire: 'SAMER_DELIV' },
  ]);
}

const lanceEnScript = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (lanceEnScript) {
  await seed();
  console.log('Seed de démonstration inséré ✔');
  console.log('PIN de démo — Propriétaire: 852741, Manager: 963852, Caissiers: 2580 / 4826');
  await fermerDb();
}
