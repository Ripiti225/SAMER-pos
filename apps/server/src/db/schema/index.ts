/**
 * Schéma Drizzle — MIROIR EXACT de sql/schema.sql (source de vérité).
 * Mêmes noms de tables et colonnes en français, mêmes contraintes, mêmes types.
 * La migration initiale (drizzle/0000_init.sql) est la copie du fichier SQL :
 * ce module sert au typage des requêtes, pas à générer le DDL initial.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSequence,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const rolePos = pgEnum('role_pos', [
  'PROPRIETAIRE',
  'MANAGER',
  'CAISSIER',
  'SERVEUR',
  'CUISINE',
]);
export const posteCuisine = pgEnum('poste_cuisine', ['CUISINIER', 'PIZZAIOLO', 'COMPTOIRISTE']);
// Disponibilité d'un employé (RH légère, gérée depuis Réglages › Équipe).
export const disponibiliteEmploye = pgEnum('disponibilite_employe', ['PRESENT', 'MALADE', 'CONGE', 'PERMISSION']);
export const typeCommande = pgEnum('type_commande', ['SUR_PLACE', 'EMPORTER', 'LIVRAISON']);
export const statutCommande = pgEnum('statut_commande', [
  'OUVERTE',
  'ENVOYEE_CUISINE',
  'PRETE',
  'SERVIE',
  'PAYEE',
  'ANNULEE',
]);
export const modePaiement = pgEnum('mode_paiement', [
  'ESPECES',
  'WAVE',
  'ORANGE_MONEY',
  'MTN_MOMO',
  'MOOV_MONEY',
  'CARTE',
]);

// Numérotation séquentielle CONTINUE des tickets (§14.2)
export const seqNumeroTicket = pgSequence('seq_numero_ticket', { startWith: 1 });

// ---------------------------------------------------------------------------
// 0. Configuration du site
// ---------------------------------------------------------------------------
export const restaurant = pgTable('restaurant', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  code: text('code').notNull().unique(),
  nom: text('nom').notNull(),
  marque: text('marque').notNull(),
  couleur_hex: text('couleur_hex').notNull(),
  actif: boolean('actif').notNull().default(true),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('restaurant_marque_check', sql`${t.marque} IN ('SAMER','AL_KAYAN')`)]);

export const parametresLocaux = pgTable('parametres_locaux', {
  cle: text('cle').primaryKey(),
  valeur: jsonb('valeur').notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// 1. Utilisateurs et rôles (§8, §14.1) — sprint 4B+4C : rôles composés
// ---------------------------------------------------------------------------
export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  nom: text('nom').notNull().unique(),
  systeme: boolean('systeme').notNull().default(false),
  actif: boolean('actif').notNull().default(true),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rolePermissions = pgTable('role_permissions', {
  role_id: uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  permission_cle: text('permission_cle').notNull(),
}, (t) => [primaryKey({ columns: [t.role_id, t.permission_cle] })]);

export const utilisateurs = pgTable('utilisateurs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  nom_complet: text('nom_complet').notNull(),
  // Ancien enum conservé (compat) ; source de vérité = role_id.
  role: rolePos('role'),
  role_id: uuid('role_id').references(() => roles.id),
  poste_cuisine: posteCuisine('poste_cuisine'),
  // Intitulé de poste réel (RH) : « Cuisinier », « Comptoiriste », « Serveur/se »…
  poste: text('poste'),
  // Photo de l'employé (URL) — affichée dans Réglages › Équipe.
  photo_url: text('photo_url'),
  // Identifiant du même employé dans SamerTrackly (RH) — pour la synchro
  // automatique (upsert sans doublon). NULL = employé créé localement.
  externe_id: text('externe_id'),
  // Présence / absence RH (ne bloque pas la connexion, informatif pour l'équipe).
  disponibilite: disponibiliteEmploye('disponibilite').notNull().default('PRESENT'),
  pin_hash: text('pin_hash').notNull(),
  telephone: text('telephone'),
  actif: boolean('actif').notNull().default(true),
  tentatives_pin: smallint('tentatives_pin').notNull().default(0),
  verrou_jusqua: timestamp('verrou_jusqua', { withTimezone: true }),
  // Sprint 4C : PIN posé par l'employé (code temporaire à usage unique).
  doit_definir_pin: boolean('doit_definir_pin').notNull().default(false),
  pin_temporaire_hash: text('pin_temporaire_hash'),
  pin_temporaire_expire: timestamp('pin_temporaire_expire', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// 2. Catalogue (§5.2)
// ---------------------------------------------------------------------------
export const categories = pgTable('categories', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  parent_id: uuid('parent_id'),
  nom: text('nom').notNull(),
  ordre: smallint('ordre').notNull().default(0),
  actif: boolean('actif').notNull().default(true),
});

export const articles = pgTable('articles', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  categorie_id: uuid('categorie_id').notNull().references(() => categories.id),
  nom: text('nom').notNull(),
  description: text('description'),
  prix_base: integer('prix_base').notNull(),
  image_url: text('image_url'),
  disponible: boolean('disponible').notNull().default(true),
  actif: boolean('actif').notNull().default(true),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('articles_prix_base_check', sql`${t.prix_base} >= 0`)]);

// Disponibilité LOCALE (sprint 4C, 2.3) : jamais écrasée par une descente.
export const disponibiliteLocale = pgTable('disponibilite_locale', {
  article_id: uuid('article_id').primaryKey().references(() => articles.id, { onDelete: 'cascade' }),
  disponible: boolean('disponible').notNull().default(true),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const prixCanaux = pgTable('prix_canaux', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  article_id: uuid('article_id').notNull().references(() => articles.id, { onDelete: 'cascade' }),
  canal: text('canal').notNull(),
  prix: integer('prix').notNull(),
}, (t) => [uniqueIndex('prix_canaux_article_id_canal_key').on(t.article_id, t.canal)]);

export const groupesOptions = pgTable('groupes_options', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  article_id: uuid('article_id').notNull().references(() => articles.id, { onDelete: 'cascade' }),
  nom: text('nom').notNull(),
  choix_min: smallint('choix_min').notNull().default(0),
  choix_max: smallint('choix_max').notNull().default(1),
});

export const options = pgTable('options', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  groupe_id: uuid('groupe_id').notNull().references(() => groupesOptions.id, { onDelete: 'cascade' }),
  nom: text('nom').notNull(),
});

export const supplements = pgTable('supplements', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  article_id: uuid('article_id').notNull().references(() => articles.id, { onDelete: 'cascade' }),
  nom: text('nom').notNull(),
  prix: integer('prix').notNull(),
});

export const combos = pgTable('combos', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  nom: text('nom').notNull(),
  prix: integer('prix').notNull(),
  disponible: boolean('disponible').notNull().default(true),
  actif: boolean('actif').notNull().default(true),
});

export const comboArticles = pgTable('combo_articles', {
  combo_id: uuid('combo_id').notNull().references(() => combos.id, { onDelete: 'cascade' }),
  article_id: uuid('article_id').notNull().references(() => articles.id),
  quantite: smallint('quantite').notNull().default(1),
}, (t) => [primaryKey({ columns: [t.combo_id, t.article_id] })]);

export const promotions = pgTable('promotions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  nom: text('nom').notNull(),
  type: text('type').notNull(),
  valeur: integer('valeur').notNull(),
  heure_debut: time('heure_debut'),
  heure_fin: time('heure_fin'),
  jours: smallint('jours').array().notNull().default(sql`'{1,2,3,4,5,6,7}'`),
  article_id: uuid('article_id').references(() => articles.id),
  actif: boolean('actif').notNull().default(true),
}, (t) => [check('promotions_type_check', sql`${t.type} IN ('POURCENTAGE','MONTANT')`)]);

// ---------------------------------------------------------------------------
// 3. Plan de salle (§5.1)
// ---------------------------------------------------------------------------
export const zones = pgTable('zones', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  nom: text('nom').notNull(),
  couleur: text('couleur'),
  ordre: smallint('ordre').notNull().default(0),
});

export const tablesSalle = pgTable('tables_salle', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  zone_id: uuid('zone_id').notNull().references(() => zones.id),
  numero: text('numero').notNull(),
  partenaire: text('partenaire'),
  statut: text('statut').notNull().default('LIBRE'),
  qr_token: text('qr_token').unique(),
  ouverte_par: uuid('ouverte_par').references(() => utilisateurs.id),
  actif: boolean('actif').notNull().default(true),
}, (t) => [
  uniqueIndex('tables_salle_zone_id_numero_key').on(t.zone_id, t.numero),
  check('tables_salle_statut_check', sql`${t.statut} IN ('LIBRE','OCCUPEE','ADDITION_DEMANDEE')`),
]);

// ---------------------------------------------------------------------------
// 4. Services caisse / shifts (§5.7, §14.3)
// ---------------------------------------------------------------------------
export const servicesCaisse = pgTable('services_caisse', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  caissier_id: uuid('caissier_id').notNull().references(() => utilisateurs.id),
  fond_de_caisse: integer('fond_de_caisse').notNull(),
  ouvert_le: timestamp('ouvert_le', { withTimezone: true }).notNull().defaultNow(),
  cloture_le: timestamp('cloture_le', { withTimezone: true }),
  statut: text('statut').notNull().default('OUVERT'),
  especes_comptees: integer('especes_comptees'),
  especes_theorique: integer('especes_theorique'),
  ecart: integer('ecart'),
  rapport_z: jsonb('rapport_z'),
}, (t) => [
  uniqueIndex('un_service_ouvert_par_caissier')
    .on(t.caissier_id)
    .where(sql`statut = 'OUVERT'`),
  check('services_caisse_statut_check', sql`${t.statut} IN ('OUVERT','CLOTURE')`),
]);

// Équipe du jour (allègement — remplace le pointage) : présents d'un service
// + leur poste du jour. Info + remontée back-office.
export const equipeService = pgTable('equipe_service', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  service_id: uuid('service_id').notNull().references(() => servicesCaisse.id, { onDelete: 'cascade' }),
  utilisateur_id: uuid('utilisateur_id').notNull().references(() => utilisateurs.id),
  poste_jour: text('poste_jour').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('equipe_service_service_utilisateur_key').on(t.service_id, t.utilisateur_id)]);

// Sessions serveur PERSISTÉES : survivent à un redémarrage du serveur/mini-PC
// (le magasin les recharge au démarrage). Cookie httpOnly = id de session.
export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  utilisateur_id: uuid('utilisateur_id').notNull().references(() => utilisateurs.id, { onDelete: 'cascade' }),
  nom_complet: text('nom_complet').notNull(),
  role_id: uuid('role_id'),
  role_nom: text('role_nom').notNull(),
  est_proprietaire: boolean('est_proprietaire').notNull().default(false),
  est_superviseur: boolean('est_superviseur').notNull().default(false),
  expire_a: timestamp('expire_a', { withTimezone: true }).notNull(),
});

// ---------------------------------------------------------------------------
// 5. Commandes (§5.1) — cœur du sprint 1
// ---------------------------------------------------------------------------
export const commandes = pgTable('commandes', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  numero_ticket: bigint('numero_ticket', { mode: 'number' })
    .notNull()
    .unique()
    .default(sql`nextval('seq_numero_ticket')`),
  type: typeCommande('type').notNull(),
  table_id: uuid('table_id').references(() => tablesSalle.id),
  partenaire: text('partenaire'),
  ref_partenaire: text('ref_partenaire'),
  service_id: uuid('service_id').references(() => servicesCaisse.id),
  caissier_id: uuid('caissier_id').references(() => utilisateurs.id),
  serveur_id: uuid('serveur_id').references(() => utilisateurs.id),
  statut: statutCommande('statut').notNull().default('OUVERTE'),
  origine: text('origine').notNull().default('CAISSE'),
  refus_motif: text('refus_motif'),
  client_fidelite_id: uuid('client_fidelite_id').references(() => clientsFidelite.id),
  fidelite_points: integer('fidelite_points').notNull().default(0),
  fidelite_montant: integer('fidelite_montant').notNull().default(0),
  sous_total: integer('sous_total').notNull().default(0),
  remise_montant: integer('remise_montant').notNull().default(0),
  remise_par: uuid('remise_par').references(() => utilisateurs.id),
  remise_motif: text('remise_motif'),
  promo_id: uuid('promo_id').references(() => promotions.id),
  promo_montant: integer('promo_montant').notNull().default(0),
  total: integer('total').notNull().default(0),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_commandes_service').on(t.service_id),
  index('idx_commandes_jour').on(t.created_at),
  check(
    'remise_motif_obligatoire',
    sql`${t.remise_montant} = 0 OR (${t.remise_motif} IS NOT NULL AND ${t.remise_par} IS NOT NULL)`,
  ),
]);

export const commandeItems = pgTable('commande_items', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  commande_id: uuid('commande_id').notNull().references(() => commandes.id, { onDelete: 'cascade' }),
  article_id: uuid('article_id').references(() => articles.id),
  combo_id: uuid('combo_id').references(() => combos.id),
  nom_snapshot: text('nom_snapshot').notNull(),
  prix_unitaire: integer('prix_unitaire').notNull(),
  quantite: smallint('quantite').notNull(),
  options: jsonb('options').notNull().default(sql`'[]'`),
  supplements: jsonb('supplements').notNull().default(sql`'[]'`),
  statut_cuisine: text('statut_cuisine').notNull().default('A_PREPARER'),
  envoye_le: timestamp('envoye_le', { withTimezone: true }),
  attribue_a: uuid('attribue_a').array().notNull().default(sql`'{}'`),
  annule_par: uuid('annule_par').references(() => utilisateurs.id),
  annule_motif: text('annule_motif'),
}, (t) => [
  check('item_source', sql`${t.article_id} IS NOT NULL OR ${t.combo_id} IS NOT NULL`),
  check(
    'annulation_tracee',
    sql`${t.statut_cuisine} <> 'ANNULE' OR (${t.annule_par} IS NOT NULL AND ${t.annule_motif} IS NOT NULL)`,
  ),
]);

// ---------------------------------------------------------------------------
// 6. Paiements (§5.5) — mixte + split
// ---------------------------------------------------------------------------
export const notesSplit = pgTable('notes_split', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  commande_id: uuid('commande_id').notNull().references(() => commandes.id, { onDelete: 'cascade' }),
  libelle: text('libelle').notNull().default('Note 1'),
  montant: integer('montant').notNull(),
}, (t) => [check('notes_split_montant_check', sql`${t.montant} > 0`)]);

export const paiements = pgTable('paiements', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  commande_id: uuid('commande_id').notNull().references(() => commandes.id),
  note_id: uuid('note_id').references(() => notesSplit.id),
  mode: modePaiement('mode').notNull(),
  montant: integer('montant').notNull(),
  encaisse_par: uuid('encaisse_par').notNull().references(() => utilisateurs.id),
  service_id: uuid('service_id').notNull().references(() => servicesCaisse.id),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('paiements_montant_check', sql`${t.montant} > 0`)]);

// ---------------------------------------------------------------------------
// 7. Journal d'audit immuable (§14.2)
// ---------------------------------------------------------------------------
export const auditLog = pgTable('audit_log', {
  seq: bigserial('seq', { mode: 'number' }).primaryKey(),
  id: uuid('id').notNull().default(sql`gen_random_uuid()`),
  user_id: uuid('user_id').references(() => utilisateurs.id),
  action: text('action').notNull(),
  entite: text('entite').notNull(),
  entite_id: uuid('entite_id'),
  montant: integer('montant'),
  motif: text('motif'),
  meta: jsonb('meta').notNull().default(sql`'{}'`),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// 8. Synchronisation — outbox (local uniquement)
// ---------------------------------------------------------------------------
export const syncOutbox = pgTable('sync_outbox', {
  seq: bigserial('seq', { mode: 'number' }).primaryKey(),
  table_name: text('table_name').notNull(),
  record_id: uuid('record_id').notNull(),
  operation: text('operation').notNull(),
  payload: jsonb('payload').notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  synced_at: timestamp('synced_at', { withTimezone: true }),
}, (t) => [
  index('idx_outbox_pending').on(t.seq).where(sql`synced_at IS NULL`),
  check('sync_outbox_operation_check', sql`${t.operation} IN ('INSERT','UPDATE')`),
]);

export const syncEtat = pgTable('sync_etat', {
  flux: text('flux').primaryKey(),
  version: bigint('version', { mode: 'number' }).notNull().default(0),
  synced_at: timestamp('synced_at', { withTimezone: true }),
});

// CORRECTIONS3 Point 1 : appels d'une table depuis le téléphone client (QR)
export const appelsTable = pgTable('appels_table', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  table_id: uuid('table_id').notNull().references(() => tablesSalle.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  statut: text('statut').notNull().default('EN_ATTENTE'),
  cree_le: timestamp('cree_le', { withTimezone: true }).notNull().defaultNow(),
  traite_le: timestamp('traite_le', { withTimezone: true }),
  traite_par: uuid('traite_par').references(() => utilisateurs.id),
}, (t) => [
  uniqueIndex('un_appel_en_attente_par_table_type')
    .on(t.table_id, t.type)
    .where(sql`statut = 'EN_ATTENTE'`),
  check('appels_table_type_check', sql`${t.type} IN ('APPEL_SERVEUR','DEMANDE_FACTURE')`),
  check('appels_table_statut_check', sql`${t.statut} IN ('EN_ATTENTE','TRAITE')`),
]);

// Correction 4 : poste de cuisine ↔ catégorie (attribution automatique)
export const mappingPosteCategorie = pgTable('mapping_poste_categorie', {
  poste_cuisine: posteCuisine('poste_cuisine').notNull(),
  categorie_id: uuid('categorie_id').notNull().references(() => categories.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.poste_cuisine, t.categorie_id] })]);

// Sprint 2 : idempotence de la file locale des tablettes serveur
export const actionsRecues = pgTable('actions_recues', {
  uuid: uuid('uuid').primaryKey(),
  traite_le: timestamp('traite_le', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// 9-11. Sprint 2+ (tables présentes dans le schéma, NON implémentées en sprint 1)
// ---------------------------------------------------------------------------
export const notations = pgTable('notations', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  table_id: uuid('table_id').references(() => tablesSalle.id),
  commande_id: uuid('commande_id').references(() => commandes.id),
  cuisine: smallint('cuisine'),
  service: smallint('service'),
  ambiance: smallint('ambiance'),
  commentaire: text('commentaire'),
  serveur_id: uuid('serveur_id').references(() => utilisateurs.id),
  caissier_id: uuid('caissier_id').references(() => utilisateurs.id),
  cuisiniers: uuid('cuisiniers').array().notNull().default(sql`'{}'`),
  device_hash: text('device_hash'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const clientsFidelite = pgTable('clients_fidelite', {
  id: uuid('id').primaryKey(),
  telephone: text('telephone').unique(),
  nom: text('nom'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pointsFidelite = pgTable('points_fidelite', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  client_id: uuid('client_id').notNull().references(() => clientsFidelite.id),
  commande_id: uuid('commande_id').references(() => commandes.id),
  points: integer('points').notNull(),
  source: text('source').notNull().default('POS'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
