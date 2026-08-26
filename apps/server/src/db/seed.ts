/**
 * Seed de démonstration (voir CLAUDE.md).
 * Réinitialise les données puis insère un site NEUTRE (identité à configurer
 * dans Réglages → Restaurant) : catalogue + rôles + compte propriétaire.
 * Rien de propre à un restaurant précis — l'image est copiée sur les 7 sites.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../env.js';
import argon2 from 'argon2';
import { sql } from 'drizzle-orm';
import { TABLE_KDO } from '@pos/shared';
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
  produitsInventaire,
  promotions,
  restaurant,
  supplements,
  tablesSalle,
  utilisateurs,
  zones,
} from './schema/index.js';

import { CATALOGUE_INVENTAIRE } from './catalogue-inventaire.js';
import { etablirRolesSysteme } from '../modules/roles/service.js';
import { genererQrToken } from '../modules/salle/qr.js';
import { appliquerRoutageDefaut } from '../modules/reglages/routage-defaut.js';
import { appliquerRecettesDefaut } from '../modules/inventaire/recettes-defaut.js';

export async function hacherPin(pin: string): Promise<string> {
  return argon2.hash(pin, { type: argon2.argon2id });
}

export async function seed(): Promise<void> {
  // Remise à zéro complète (TRUNCATE n'est pas bloqué par le trigger append-only,
  // qui ne vise que UPDATE/DELETE ligne à ligne — acceptable pour un seed de démo).
  await db.execute(sql`
    TRUNCATE TABLE appels_table, actions_recues, points_fidelite, clients_fidelite,
      notations, sync_etat, sync_outbox, audit_log, paiements, note_split_items, notes_split, equipe_service,
      commande_items, commandes, services_caisse, tables_salle, zones,
      promotions, mapping_poste_categorie, combo_articles, combos, supplements,
      options, groupes_options, prix_canaux, articles, categories,
      role_permissions, utilisateurs, roles,
      parametres_locaux, restaurant
      RESTART IDENTITY CASCADE
  `);
  await db.execute(sql`ALTER SEQUENCE seq_numero_ticket RESTART WITH 1`);

  // Identité NEUTRE : la même image de déploiement part sur les 7 sites. Chaque
  // poste prend son identité (code, nom, marque, couleur, id) à l'étape
  // Réglages → Restaurant. Tant qu'elle n'est pas faite, la caisse affiche
  // « Restaurant à configurer » : l'oubli se voit tout de suite.
  await db.insert(restaurant).values({
    code: 'A_CONFIGURER',
    nom: 'Restaurant à configurer',
    marque: 'SAMER',
    couleur_hex: '#EF9F27',
  });

  await db.insert(parametresLocaux).values([
    { cle: 'seuil_alerte_ecart_caisse', valeur: 2000 },
    // Verrouillage automatique après inactivité DÉSACTIVÉ (0) : un compte n'est
    // déconnecté que par le bouton « Se déconnecter ». Remettre une valeur > 0
    // dans Réglages pour réactiver le verrou par PIN.
    { cle: 'verrou_inactivite_caisse_secondes', valeur: 0 },
    { cle: 'verrouillage_inactivite_serveur_secondes', valeur: 0 },
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
    // Sprint 4 C : QR de table — adresse web de l'APP CLIENT (port 5176).
    // Vide = le serveur détecte l'IP LAN automatiquement (joignable depuis un
    // téléphone). On ne renseigne ici que pour figer un domaine/IP en prod.
    { cle: 'url_base_client', valeur: '' },
    // SamerTrackly : PAS de restaurant par défaut. L'image de déploiement est
    // copiée telle quelle (même `data/pgdata`) sur tous les postes : un id seedé
    // ici ferait descendre l'équipe de CE restaurant-là sur TOUS les sites.
    // Le paramètre est posé par Réglages → Restaurant (étape 4 du déploiement) ;
    // tant qu'il est absent, la synchro équipe se saute d'elle-même.
    // Facture : contact sous le logo + message de pied (éditables dans Réglages).
    // Entête VIDE : l'adresse est propre à chaque site (image commune).
    { cle: 'ticket_entete', valeur: '' },
    // Pied VIDE lui aussi : l'image commune sert des sites Chez Samer ET des
    // sites Al Kayan. Un « à bientôt chez Samer ! » seedé ici s'imprimerait sur
    // les tickets de l'autre marque. Chaque site pose le sien dans Réglages.
    { cle: 'ticket_pied', valeur: '' },
    // Imprimante thermique ESC/POS : NOM de l'imprimante Windows, propre à
    // chaque poste (modifiable dans Réglages). Vide = repli console, ce qui est
    // le bon défaut : un nom seedé ici n'existerait sur aucun autre PC et la
    // caisse se croirait configurée sans jamais rien imprimer.
    { cle: 'imprimante_thermique_queue', valeur: '' },
  ]);

  // --- Rôles système (sprint 4B+4C) puis utilisateurs raccordés ---
  const roleIdParNom = await etablirRolesSysteme(db);
  const rid = (nom: string) => roleIdParNom.get(nom)!;

  // --- DEUX comptes propriétaire, et eux seuls, dans l'image de déploiement :
  // le patron et l'administrateur qui installe/dépanne les 7 sites. Tous les
  // autres employés arrivent ensuite par Réglages → Équipe (ou la descente
  // SamerTrackly) : les seeder ici les enverrait sur tous les restaurants.
  await db.insert(utilisateurs).values([
    { nom_complet: 'SAMER Zreik', role: 'PROPRIETAIRE', role_id: rid('PROPRIETAIRE'), pin_hash: await hacherPin('852741'), telephone: '+2250700000001' },
    { nom_complet: 'Admin Willy', role: 'PROPRIETAIRE', role_id: rid('PROPRIETAIRE'), pin_hash: await hacherPin('2212'), telephone: '+2250700000002' },
  ]);

  // --- Équipe RÉELLE « Samer Angré 7E » (source : docs/effectifs-par-restaurant.md)
  // NE FAIT PAS PARTIE DE L'IMAGE DE DÉPLOIEMENT : le dossier master est copié
  // tel quel sur les 7 sites, donc seeder cette équipe installerait les comptes
  // (noms, téléphones, photos et PIN utilisables) du 7E chez tous les autres
  // restaurants. Sur un site neuf, l'équipe arrive de SamerTrackly après
  // Réglages → Restaurant. Pour retrouver ces comptes en local (dev, ou
  // réinstallation du 7E hors ligne) : `SEED_EQUIPE_7E=1 pnpm db:seed`.
  const PHOTO = 'https://wlwotzxnzowbkbfcpnyi.supabase.co/storage/v1/object/public/photos';
  type Recrue = {
    nom: string;
    role: 'MANAGER' | 'CAISSIER' | 'SERVEUR' | 'CUISINE';
    pc: 'CUISINIER' | 'PIZZAIOLO' | null;
    poste: string;
    tel: string | null;
    photo: string;
    code: string; // PIN connu (à réattribuer par l'encadrant ensuite)
  };
  const equipe7E: Recrue[] = [
    { nom: 'BAZIE Jean Marc', role: 'CUISINE', pc: 'CUISINIER', poste: 'Cuisinier', tel: '0545104508', photo: `${PHOTO}/travailleurs/1778112607127_v9qppaeqfhh.heic`, code: '240101' },
    { nom: 'DIE YANNICK', role: 'SERVEUR', pc: null, poste: 'Serveur/se', tel: '0173163855', photo: `${PHOTO}/travailleurs/1779381741835_5rm8criwdqi.jpeg`, code: '240102' },
    { nom: 'DJE ANGE WILFRIED DORGELEX', role: 'MANAGER', pc: null, poste: 'Gérant / manager général', tel: '0778565312', photo: `${PHOTO}/photos/1778793969237_ijbhx85eq6e.jpg`, code: '240103' },
    { nom: 'GNOLEBA ZEKALO FULGENCE', role: 'CUISINE', pc: null, poste: 'Technicien de surface', tel: null, photo: `${PHOTO}/travailleurs/1778151645338_p385sou25z.jpg`, code: '240104' },
    { nom: 'GROGUHE ZRAGA MEDARD', role: 'CAISSIER', pc: null, poste: 'Comptoiriste', tel: '0101042021', photo: `${PHOTO}/travailleurs/1778151303984_b6nakqvyf5p.jpg`, code: '240105' },
    { nom: 'Hilary Sea', role: 'CAISSIER', pc: null, poste: 'Caissière', tel: '0777497272', photo: `${PHOTO}/travailleurs/1778151245288_dzcbagocd2f.jpg`, code: '240106' },
    { nom: 'KONE DJENEBA', role: 'SERVEUR', pc: null, poste: 'Serveur/se', tel: '0576360142', photo: `${PHOTO}/travailleurs/1778151460294_lq8en88d5af.jpg`, code: '240107' },
    { nom: 'Marie-Paule Gnepa', role: 'CAISSIER', pc: null, poste: 'Caissière', tel: null, photo: `${PHOTO}/travailleurs/1779381800359_5dotqfeume.jpeg`, code: '240108' },
    { nom: 'N’GUESSAN FLORA', role: 'CAISSIER', pc: null, poste: 'Caissière', tel: '0718901301', photo: `${PHOTO}/travailleurs/1778112557214_p83hfr9j86.jpg`, code: '240109' },
    { nom: 'N’ZI KONAN SERAPHIN', role: 'CAISSIER', pc: null, poste: 'Caissier/re', tel: '0701841311', photo: `${PHOTO}/travailleurs/1778151386842_t72lqo48h0l.jpg`, code: '240110' },
    { nom: 'SINGO BEUH VINCENT', role: 'CUISINE', pc: 'CUISINIER', poste: 'Cuisinier', tel: '0586627024', photo: `${PHOTO}/travailleurs/1778167391514_slwz99h3uok.jpg`, code: '240111' },
    { nom: 'TRAORÉ ZAWELA MICHAEL', role: 'CAISSIER', pc: null, poste: 'Caissier/re', tel: '0565121801', photo: `${PHOTO}/travailleurs/1778514165178_olleere5s6i.jpg`, code: '240112' },
    { nom: 'YAO KOUAME JULSON DARIN', role: 'CUISINE', pc: 'CUISINIER', poste: 'Cuisinier', tel: '0105340894', photo: `${PHOTO}/travailleurs/1778514338713_zz8cwrxohk.jpg`, code: '240113' },
  ];
  if (process.env.SEED_EQUIPE_7E === '1') {
    await db.insert(utilisateurs).values(
      await Promise.all(
        equipe7E.map(async (e) => ({
          nom_complet: e.nom,
          role: e.role,
          role_id: rid(e.role),
          poste_cuisine: e.pc,
          poste: e.poste,
          photo_url: e.photo,
          telephone: e.tel,
          // Code de connexion connu (le compte est directement utilisable).
          pin_hash: await hacherPin(e.code),
          doit_definir_pin: false,
        })),
      ),
    );
  }

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

  // Routage d'impression par défaut (Cuisine/Caisse/Bar par catégorie) — général,
  // modifiable ensuite dans Réglages › Routage impression.
  await appliquerRoutageDefaut(db);

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
  // Jetons QR ALÉATOIRES (non devinables) — comme en production. Un jeton
  // prévisible (ex. SAMER-T1) permettrait d'énumérer les tables via /api/client.
  const jeton = (_numero: string) => genererQrToken();
  await db.insert(tablesSalle).values([
    ...Array.from({ length: 6 }, (_, i) => ({ zone_id: zoneRC!.id, numero: `T${i + 1}`, qr_token: jeton(`T${i + 1}`) })),
    ...Array.from({ length: 4 }, (_, i) => ({ zone_id: zoneTerrasse!.id, numero: `TE${i + 1}`, qr_token: jeton(`TE${i + 1}`) })),
    ...Array.from({ length: 2 }, (_, i) => ({ zone_id: zoneVIP!.id, numero: `VIP${i + 1}`, qr_token: jeton(`VIP${i + 1}`) })),
    // Table du Kdo (repas offert) : en RC, car le cadeau se consomme sur place
    // — contrairement aux tables virtuelles de livraison ci-dessous.
    { zone_id: zoneRC!.id, numero: TABLE_KDO, partenaire: TABLE_KDO },
    { zone_id: zoneLivraison!.id, numero: 'YANGO', partenaire: 'YANGO' },
    { zone_id: zoneLivraison!.id, numero: 'GLOVO', partenaire: 'GLOVO' },
    { zone_id: zoneLivraison!.id, numero: 'SAMER DELLY', partenaire: 'SAMER_DELLY' },
  ]);

  // Catalogue de comptage de l'inventaire (§ 6.9). Il est réinséré ICI parce
  // que le TRUNCATE ... articles ... CASCADE plus haut emporte
  // `produits_inventaire` : sans cette ligne, `db:migrate && db:seed` laissait
  // un inventaire VIDE, donc validable sans rien compter — le verrou de clôture
  // n'aurait plus rien verrouillé.
  await db.insert(produitsInventaire).values(CATALOGUE_INVENTAIRE).onConflictDoNothing();

  // Recettes d'inventaire par défaut (migration 0022) : sans elles, les sorties
  // resteraient à 0 et le théorique se réduirait à initial + entrées. Ne couvre
  // que les liaisons lisibles dans le nom de l'article ; le reste se règle dans
  // Réglages › Recettes d'inventaire.
  await appliquerRecettesDefaut(db);
}

const lanceEnScript = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (lanceEnScript) {
  await seed();
  console.log('Seed inséré ✔');
  console.log('Propriétaires : SAMER Zreik PIN 852741 · Admin Willy PIN 2212 (seuls comptes de base).');
  console.log('Équipe 7E : PIN 240101 → 240113 dans l’ordre de la liste (cf. seed.ts / Réglages › Équipe).');
  await fermerDb();
}
