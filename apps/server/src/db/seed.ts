/**
 * Seed de démonstration (voir CLAUDE.md).
 * Réinitialise les données puis insère le restaurant SAMER_ANGRE7E complet.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import { sql } from 'drizzle-orm';
import { db, fermerDb } from './client.js';
import {
  articles,
  categories,
  comboArticles,
  combos,
  groupesOptions,
  mappingPosteCategorie,
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

import { etablirRolesSysteme } from '../modules/roles/service.js';

export async function hacherPin(pin: string): Promise<string> {
  return argon2.hash(pin, { type: argon2.argon2id });
}

export async function seed(): Promise<void> {
  // Remise à zéro complète (TRUNCATE n'est pas bloqué par le trigger append-only,
  // qui ne vise que UPDATE/DELETE ligne à ligne — acceptable pour un seed de démo).
  await db.execute(sql`
    TRUNCATE TABLE appels_table, actions_recues, points_fidelite, clients_fidelite,
      notations, sync_etat, sync_outbox, audit_log, paiements, notes_split, equipe_service,
      commande_items, commandes, services_caisse, tables_salle, zones,
      promotions, mapping_poste_categorie, combo_articles, combos, supplements,
      options, groupes_options, prix_canaux, articles, categories,
      role_permissions, utilisateurs, roles,
      parametres_locaux, restaurant
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
    // Correction 1 (retour terrain) : 10 min — un verrou trop court bloque le travail
    { cle: 'verrou_inactivite_caisse_secondes', valeur: 600 },
    // Sprint 2 : les serveurs bougent, verrouillage plus long sur tablette
    { cle: 'verrouillage_inactivite_serveur_secondes', valeur: 120 },
    // Sprint 2 : seuils du chronomètre KDS (minutes)
    { cle: 'kds_seuil_orange_minutes', valeur: 10 },
    { cle: 'kds_seuil_rouge_minutes', valeur: 20 },
    // Correction 3 : le KDS s'identifie par un jeton d'appareil, pas par PIN.
    // À changer à l'installation de chaque site.
    { cle: 'kds_jeton_appareil', valeur: 'SAMER-ANGRE7E-KDS-1' },
    // Sprint 4 B : barème fidélité (descendu du siège en production)
    { cle: 'fidelite_points_par_tranche', valeur: { tranche_fcfa: 1000, points: 1 } },
    { cle: 'fidelite_valeur_point_fcfa', valeur: 10 },
    { cle: 'fidelite_seuil_utilisation', valeur: 50 },
    // Sprint 4 C : QR de table — adresse web du client (pour l'URL encodée).
    // En dev : http://localhost:5173 ; en prod : https://client.restaurant.com
    { cle: 'url_base_client', valeur: 'http://localhost:5173' },
  ]);

  // --- Rôles système (sprint 4B+4C) puis utilisateurs raccordés ---
  const roleIdParNom = await etablirRolesSysteme(db);
  const rid = (nom: string) => roleIdParNom.get(nom)!;

  // --- Utilisateurs (PIN de démo — à changer en production) ---
  await db.insert(utilisateurs).values([
    { nom_complet: 'Samer El Khoury', role: 'PROPRIETAIRE', role_id: rid('PROPRIETAIRE'), pin_hash: await hacherPin('852741'), telephone: '+2250700000001' },
    { nom_complet: 'Awa Koné', role: 'MANAGER', role_id: rid('MANAGER'), pin_hash: await hacherPin('963852'), telephone: '+2250700000002' },
    { nom_complet: 'Mariam Diabaté', role: 'CAISSIER', role_id: rid('CAISSIER'), pin_hash: await hacherPin('2580'), telephone: '+2250700000003' },
    { nom_complet: 'Ibrahim Traoré', role: 'CAISSIER', role_id: rid('CAISSIER'), pin_hash: await hacherPin('4826'), telephone: '+2250700000004' },
    { nom_complet: 'Fatou Bamba', role: 'SERVEUR', role_id: rid('SERVEUR'), pin_hash: await hacherPin('1357'), telephone: '+2250700000005' },
    { nom_complet: 'Moussa Cissé', role: 'SERVEUR', role_id: rid('SERVEUR'), pin_hash: await hacherPin('2468'), telephone: '+2250700000006' },
    { nom_complet: 'Kouadio Yao', role: 'CUISINE', role_id: rid('CUISINE'), poste_cuisine: 'CUISINIER', pin_hash: await hacherPin('7913'), telephone: '+2250700000007' },
    { nom_complet: 'Luigi Kouassi', role: 'CUISINE', role_id: rid('CUISINE'), poste_cuisine: 'PIZZAIOLO', pin_hash: await hacherPin('8024'), telephone: '+2250700000008' },
    { nom_complet: 'Aminata Touré', role: 'CUISINE', role_id: rid('CUISINE'), poste_cuisine: 'COMPTOIRISTE', pin_hash: await hacherPin('4652'), telephone: '+2250700000009' },
  ]);

  // --- Catalogue RÉEL (export Supabase mobmgbedyyqeggxjpbrk) ---
  // Le catalogue de démo a été remplacé par le vrai menu (15 catégories,
  // 128 produits). On réutilise les UUID de l'export (cohérence local ↔ cloud).
  // Champs ignorés (hors schéma) : allergenes, populaire, temps_preparation_min.
  const cheminCatalogue = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..', 'docs/menu_export.json');
  const exportCatalogue = JSON.parse(readFileSync(cheminCatalogue, 'utf8')) as {
    categories: {
      id: string; nom: string; ordre: number; active: boolean;
      produits: { id: string; nom: string; description: string | null; prix: number; photo_url: string | null; disponible: boolean }[];
    }[];
  };

  const lignesCategories = await db
    .insert(categories)
    .values(exportCatalogue.categories.map((c) => ({ id: c.id, nom: c.nom, ordre: c.ordre, actif: c.active })))
    .returning();
  const catParNom = new Map(lignesCategories.map((c) => [c.nom, c]));

  const aInserer = exportCatalogue.categories.flatMap((c) =>
    c.produits.map((p) => ({
      id: p.id,
      categorie_id: c.id,
      nom: p.nom,
      description: p.description,
      prix_base: p.prix,
      image_url: p.photo_url,
      disponible: p.disponible,
    })),
  );
  const lignesArticles = aInserer.length ? await db.insert(articles).values(aInserer).returning() : [];

  const parNom = new Map(lignesArticles.map((a) => [a.nom, a]));
  // Articles réels servant d'exemples aux extras de démo (options, combo, canaux)
  const chawarmaPoulet = parNom.get('Chawarma Poulet')!;
  const boissonCombo = parNom.get('Boisson')!;
  const pizzaCanal = parNom.get('Pizza 4 Saisons (M)')!;

  // Surcharges de prix par canal (§5.2) — exemple sur 2 vrais articles
  await db.insert(prixCanaux).values([
    { article_id: chawarmaPoulet.id, canal: 'YANGO', prix: 3000 },
    { article_id: chawarmaPoulet.id, canal: 'GLOVO', prix: 3300 },
    { article_id: pizzaCanal.id, canal: 'YANGO', prix: 6500 },
    { article_id: pizzaCanal.id, canal: 'GLOVO', prix: 7000 },
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
    { combo_id: combo!.id, article_id: boissonCombo.id, quantite: 1 },
  ]);

  // Correction 4 : attribution automatique — poste de cuisine par catégorie
  // (les catégories absentes du mapping vont au CUISINIER par défaut)
  await db.insert(mappingPosteCategorie).values([
    { poste_cuisine: 'PIZZAIOLO', categorie_id: catParNom.get('Pizzas')!.id },
    { poste_cuisine: 'COMPTOIRISTE', categorie_id: catParNom.get('Boissons')!.id },
    { poste_cuisine: 'COMPTOIRISTE', categorie_id: catParNom.get('Jus Naturels')!.id },
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

  // qr_token : jeton du QR collé sur chaque table (CORRECTIONS3 — page client /t/:qr_token)
  const jeton = (numero: string) => `SAMER-${numero.replace(/\s+/g, '-')}`;
  await db.insert(tablesSalle).values([
    ...Array.from({ length: 6 }, (_, i) => ({ zone_id: zoneRC!.id, numero: `T${i + 1}`, qr_token: jeton(`T${i + 1}`) })),
    ...Array.from({ length: 4 }, (_, i) => ({ zone_id: zoneTerrasse!.id, numero: `TE${i + 1}`, qr_token: jeton(`TE${i + 1}`) })),
    ...Array.from({ length: 2 }, (_, i) => ({ zone_id: zoneVIP!.id, numero: `VIP${i + 1}`, qr_token: jeton(`VIP${i + 1}`) })),
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
