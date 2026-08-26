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
  numeric,
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
  // Migration 0024 : le comptoir et l'entretien ne sont ni des caissiers ni des
  // cuisiniers. `SUPERVISEUR` reste volontairement absent — ce rôle n'a jamais
  // existé que dans la table `roles`, la colonne `utilisateurs.role` étant un
  // vestige de compatibilité dont `role_id` est la source de vérité.
  'COMPTOIRISTE',
  'ENTRETIEN',
]);
export const posteCuisine = pgEnum('poste_cuisine', ['CUISINIER', 'PIZZAIOLO', 'COMPTOIRISTE']);
// Poste d'impression (routage des tickets) : chaque poste ↔ une imprimante locale.
export const posteImpression = pgEnum('poste_impression', ['CAISSE', 'CUISINE', 'BAR']);
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
  'DJAMO',
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
  // Champs modifiés MANUELLEMENT dans le POS (nom_complet, poste, photo_url,
  // telephone, role…) : la synchro SamerTrackly ne les écrase plus.
  champs_manuels: jsonb('champs_manuels').notNull().default(sql`'[]'::jsonb`),
  // Présence / absence RH (ne bloque pas la connexion, informatif pour l'équipe).
  disponibilite: disponibiliteEmploye('disponibilite').notNull().default('PRESENT'),
  // Salaire journalier proposé à l'écran Dépenses › Paie (modifiable, avec
  // motif obligatoire). NULL = employé qui n'est pas payé à la journée.
  taux_journalier: integer('taux_journalier'),
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
  /**
   * Catégorie réservée à un ou plusieurs partenaires de livraison (migration
   * 0023). NULL = catégorie normale, visible partout. Sinon, elle n'apparaît
   * que sur une commande dont le `partenaire` est dans la liste : c'est ce qui
   * empêche « Glovo spéciale » de s'afficher au client qui scanne un QR de
   * table ou au serveur qui prend une commande en salle.
   */
  partenaires: text('partenaires').array(),
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

/**
 * Options réutilisables (migration 0020). Remplacent groupes_options/options et
 * supplements côté application — ces trois tables restent déclarées uniquement
 * parce que la descente cloud les alimente encore.
 * Tables LOCALES : volontairement absentes de sync/descente.ts, une synchro du
 * siège ne les écrase donc jamais (même principe que disponibilite_locale).
 */
export const optionsCatalogue = pgTable('options_catalogue', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  nom: text('nom').notNull(),
  /** 0 = option gratuite (pâte à l'ail), > 0 = option payante (fromage). */
  prix: integer('prix').notNull().default(0),
  actif: boolean('actif').notNull().default(true),
  ordre: smallint('ordre').notNull().default(0),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [check('options_catalogue_prix_check', sql`${t.prix} >= 0`)]);

/**
 * Liaison d'une option à une CATÉGORIE entière ou à un ARTICLE précis
 * (exactement l'un des deux — contrainte CHECK côté base).
 * Les options d'un article = celles de sa catégorie UNION les siennes.
 */
export const optionsLiaisons = pgTable('options_liaisons', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  option_id: uuid('option_id').notNull().references(() => optionsCatalogue.id, { onDelete: 'cascade' }),
  categorie_id: uuid('categorie_id').references(() => categories.id, { onDelete: 'cascade' }),
  article_id: uuid('article_id').references(() => articles.id, { onDelete: 'cascade' }),
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
/**
 * Séquence de caisse (journée) : regroupe TOUS les shifts (services) faits
 * depuis la dernière fermeture. Seul un porteur de `caisse.fermer_sequence`
 * (gérant par défaut) la « rase » en fin de journée. Une seule OUVERTE à la fois.
 */
export const sequencesCaisse = pgTable('sequences_caisse', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  ouverte_le: timestamp('ouverte_le', { withTimezone: true }).notNull().defaultNow(),
  cloturee_le: timestamp('cloturee_le', { withTimezone: true }),
  cloturee_par: uuid('cloturee_par').references(() => utilisateurs.id),
  statut: text('statut').notNull().default('OUVERTE'),
  rapport: jsonb('rapport'),
}, (t) => [
  // Au plus une séquence OUVERTE : index unique partiel sur la valeur du statut.
  uniqueIndex('un_sequence_ouverte').on(t.statut).where(sql`statut = 'OUVERTE'`),
  check('sequences_caisse_statut_check', sql`${t.statut} IN ('OUVERTE','CLOTUREE')`),
]);

export const servicesCaisse = pgTable('services_caisse', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  caissier_id: uuid('caissier_id').notNull().references(() => utilisateurs.id),
  sequence_id: uuid('sequence_id').references(() => sequencesCaisse.id),
  fond_de_caisse: integer('fond_de_caisse').notNull(),
  ouvert_le: timestamp('ouvert_le', { withTimezone: true }).notNull().defaultNow(),
  cloture_le: timestamp('cloture_le', { withTimezone: true }),
  // Accusé de fin par le caissier (bouton « Terminer »). NULL après clôture =
  // « point à valider » : au retour, le caissier est renvoyé au ticket.
  remis_le: timestamp('remis_le', { withTimezone: true }),
  statut: text('statut').notNull().default('OUVERT'),
  especes_comptees: integer('especes_comptees'),
  especes_theorique: integer('especes_theorique'),
  ecart: integer('ecart'),
  // Réconciliation de fermeture (§ brief) : dépenses + détail des sources.
  depenses: integer('depenses').notNull().default(0),
  reconciliation: jsonb('reconciliation'),
  vente_totale: integer('vente_totale'),
  total_systeme: integer('total_systeme'),
  // Verrou de clôture (§ 6.10) : sans inventaire validé, pas de clôture.
  // Appliqué CÔTÉ SERVEUR — l'UI ne fait que le refléter.
  inventaire_valide: boolean('inventaire_valide').notNull().default(false),
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
  // Heure d'ARRIVÉE = heure du clic sur « Pointer » (§ 6.7). Une heure saisie à
  // la main est une heure négociable ; le clic est daté par le système.
  pointe_le: timestamp('pointe_le', { withTimezone: true }),
  // Départ (§ 6.8) : NULL = pas encore tranché, true = reste, false = parti.
  // À la clôture, tout ce qui n'est pas `true` est enregistré comme PARTI —
  // le caissier ne marque donc que les exceptions.
  reste: boolean('reste'),
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
  // Code court lisible (ex. « SP215 ») imprimé sur reçu + bons cuisine. Non
  // séquentiel (préfixe type + 3 chiffres aléatoires), unique dans le service.
  // Le numero_ticket reste la référence continue d'audit.
  code_commande: text('code_commande'),
  type: typeCommande('type').notNull(),
  table_id: uuid('table_id').references(() => tablesSalle.id),
  partenaire: text('partenaire'),
  // Saisis dans la modale qui s'ouvre au lancement en cuisine d'une commande
  // partenaire. Facultatifs (le caissier peut fermer) : le ticket Z compte les
  // commandes ET les contacts recueillis, pour que le trou se voie.
  ref_partenaire: text('ref_partenaire'),
  contact_client: text('contact_client'),
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
  // Kdo : repas offert, clôturé PAYEE sans aucune ligne de paiement. Il compte
  // dans la vente du shift (comme une livraison Yango) mais jamais dans le
  // théorique espèces, qui ne se calcule que sur les paiements encaissés.
  offert: boolean('offert').notNull().default(false),
  motif_offert: text('motif_offert'),
  promo_id: uuid('promo_id').references(() => promotions.id),
  promo_montant: integer('promo_montant').notNull().default(0),
  total: integer('total').notNull().default(0),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_commandes_service').on(t.service_id),
  index('idx_commandes_jour').on(t.created_at),
  // Le code court est unique par service (retry côté serveur en cas de collision).
  uniqueIndex('uniq_code_commande_service')
    .on(t.service_id, t.code_commande)
    .where(sql`${t.code_commande} IS NOT NULL`),
  check(
    'remise_motif_obligatoire',
    sql`${t.remise_montant} = 0 OR (${t.remise_motif} IS NOT NULL AND ${t.remise_par} IS NOT NULL)`,
  ),
  // Un Kdo ne peut pas être clôturé sans dire pourquoi il a été offert. La règle
  // est appliquée côté serveur ; ce CHECK est la ceinture de sécurité (un cadeau
  // sans motif est exactement ce qui rend un abus indétectable).
  check(
    'motif_offert_obligatoire',
    sql`${t.offert} = false OR ${t.statut} <> 'PAYEE' OR ${t.motif_offert} IS NOT NULL`,
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
// 6 bis. Dépenses du service (DESIGN_V2 § 6.8)
// `services_caisse.depenses` en devient la SOMME : la caissière ne retape rien
// à la clôture, où la ligne passe en lecture seule.
// ---------------------------------------------------------------------------
export const depenses = pgTable('depenses', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  service_id: uuid('service_id').notNull().references(() => servicesCaisse.id, { onDelete: 'cascade' }),
  categorie: text('categorie').notNull(),
  libelle: text('libelle').notNull(),
  montant: integer('montant').notNull(),
  /** Qui a été payé (salaire, encouragement). */
  agent_id: uuid('agent_id').references(() => utilisateurs.id),
  saisi_par: uuid('saisi_par').notNull().references(() => utilisateurs.id),
  /**
   * Ligne née d'un paiement réel : NON SUPPRIMABLE. L'effacer ferait
   * disparaître de l'argent réellement sorti du tiroir.
   */
  auto: boolean('auto').notNull().default(false),
  /** Obligatoire quand le montant payé s'écarte du taux de la fiche. */
  motif: text('motif'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_depenses_service').on(t.service_id),
  uniqueIndex('un_salaire_par_agent_et_service')
    .on(t.service_id, t.agent_id)
    .where(sql`categorie = 'SALAIRES'`),
  check('depenses_categorie_check', sql`${t.categorie} IN ('MARCHE','LEGUMES','FRUITS','ANNEXES','SALAIRES','ENCOURAGEMENTS')`),
  check('depenses_montant_check', sql`${t.montant} > 0`),
  check('depenses_libelle_check', sql`length(btrim(${t.libelle})) > 0`),
  check('depenses_agent_check', sql`${t.categorie} NOT IN ('SALAIRES','ENCOURAGEMENTS') OR ${t.agent_id} IS NOT NULL`),
]);

// ---------------------------------------------------------------------------
// 6 ter. Inventaire de fin de service (DESIGN_V2 § 6.9)
// Sans inventaire validé, pas de clôture.
// ---------------------------------------------------------------------------
/**
 * Catalogue de COMPTAGE (celui de SamerTrackly), distinct du catalogue de
 * VENTE (`articles`) : les lignes de consommation (« Manaïche (100g) ») et les
 * totaux dérivés (« Total Fromage ») ne sont pas vendables. `article_id` fait
 * le pont quand il existe — c'est lui qui porte les sorties automatiques.
 * Table LOCALE : absente de sync/descente.ts.
 */
export const produitsInventaire = pgTable('produits_inventaire', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  code: text('code').notNull().unique(),
  categorie: text('categorie').notNull(),
  nom: text('nom').notNull(),
  /** Prix de vente : sert à chiffrer le manquant non expliqué. */
  prix: integer('prix').notNull().default(0),
  unite: text('unite').notNull().default('u'),
  role: text('role').notNull().default('COMPTE'),
  /** Grammes de fromage, boules de glace, portions par sachet — selon le rôle. */
  ratio: numeric('ratio', { precision: 12, scale: 3 }),
  ordre: smallint('ordre').notNull().default(0),
  actif: boolean('actif').notNull().default(true),
}, (t) => [
  check('produits_inventaire_categorie_check', sql`${t.categorie} IN ('PAIN','POUL','APER','PLAT','FROM','BOIS','GLAC','FRIT')`),
  check('produits_inventaire_prix_check', sql`${t.prix} >= 0`),
  check(
    'produits_inventaire_role_check',
    sql`${t.role} IN ('COMPTE','ENTREE','AUTO_ENT','CONSO','CONSO_POULET','CONSO_FROMAGE','CONSO_GLACE','CONSO_FRITES','TOTAL_POULET','TOTAL_FROMAGE','TOTAL_GLACE','TOTAL_FRITES','DARINA')`,
  ),
]);

export const inventairesService = pgTable('inventaires_service', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  service_id: uuid('service_id').notNull().unique().references(() => servicesCaisse.id, { onDelete: 'cascade' }),
  valide: boolean('valide').notNull().default(false),
  valide_le: timestamp('valide_le', { withTimezone: true }),
  valide_par: uuid('valide_par').references(() => utilisateurs.id),
  /** Issue de secours manager (PIN + motif), tracée au journal d'audit. */
  debloque_par: uuid('debloque_par').references(() => utilisateurs.id),
  debloque_le: timestamp('debloque_le', { withTimezone: true }),
  debloque_motif: text('debloque_motif'),
  /** Manquant non expliqué chiffré : INFORMATION manager, jamais une retenue. */
  montant_manquant: integer('montant_manquant').notNull().default(0),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('inventaires_service_manquant_check', sql`${t.montant_manquant} >= 0`),
  check('inventaires_service_deblocage_check', sql`${t.debloque_par} IS NULL OR ${t.debloque_motif} IS NOT NULL`),
]);

export const inventaireLignes = pgTable('inventaire_lignes', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  inventaire_id: uuid('inventaire_id').notNull().references(() => inventairesService.id, { onDelete: 'cascade' }),
  produit_id: uuid('produit_id').notNull().references(() => produitsInventaire.id, { onDelete: 'cascade' }),
  /** Stock final du service précédent — repris, jamais modifiable. */
  stock_initial: numeric('stock_initial', { precision: 12, scale: 2 }).notNull().default('0'),
  entrees: numeric('entrees', { precision: 12, scale: 2 }).notNull().default('0'),
  sorties: numeric('sorties', { precision: 12, scale: 2 }).notNull().default('0'),
  /** La SEULE donnée que le caissier saisit. NULL = pas encore compté. */
  stock_compte: numeric('stock_compte', { precision: 12, scale: 2 }),
  ecart: numeric('ecart', { precision: 12, scale: 2 }),
  /** Snapshot produit (migration 0026) : le pont vers SamerTrackly ne peut pas
   *  traduire `produit_id` — chaque site a ses propres uuid. Rempli par trigger. */
  produit_code: text('produit_code'),
  produit_nom: text('produit_nom'),
  /** Le prix qui a servi au comptage, pas celui du catalogue au transfert. */
  produit_prix: integer('produit_prix'),
  quantite_expliquee: numeric('quantite_expliquee', { precision: 12, scale: 2 }).notNull().default('0'),
  explication: text('explication'),
}, (t) => [
  uniqueIndex('inventaire_lignes_produit_key').on(t.inventaire_id, t.produit_id),
  check('inventaire_lignes_expliquee_check', sql`${t.quantite_expliquee} >= 0`),
]);

/**
 * Recettes d'inventaire (migration 0022) : ce qu'un article de vente consomme.
 * Le lien produit de comptage ↔ article est un-à-plusieurs DANS LES DEUX SENS —
 * « Pain chawarma » sort avec les 6 Chawarmas, un « Poulet Pané + Frites »
 * consomme poulet, frites ET pain. `quantite` = unités du produit par article
 * vendu ; elle se compose avec `ratio` (conversion SamerTrackly), elle ne le
 * remplace pas. Table LOCALE : jamais publiée, jamais écrasée par le cloud.
 */
export const inventaireConsommations = pgTable('inventaire_consommations', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  produit_id: uuid('produit_id').notNull().references(() => produitsInventaire.id, { onDelete: 'cascade' }),
  article_id: uuid('article_id').notNull().references(() => articles.id, { onDelete: 'cascade' }),
  quantite: numeric('quantite', { precision: 12, scale: 3 }).notNull().default('1'),
}, (t) => [
  uniqueIndex('inventaire_consommations_key').on(t.produit_id, t.article_id),
  index('idx_inventaire_consommations_article').on(t.article_id),
  check('inventaire_consommations_quantite_check', sql`${t.quantite} > 0`),
]);

export const entreesStock = pgTable('entrees_stock', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  inventaire_id: uuid('inventaire_id').notNull().references(() => inventairesService.id, { onDelete: 'cascade' }),
  produit_id: uuid('produit_id').notNull().references(() => produitsInventaire.id, { onDelete: 'cascade' }),
  quantite: numeric('quantite', { precision: 12, scale: 2 }).notNull(),
  fournisseur: text('fournisseur'),
  /** Snapshot produit (migration 0026) : le pont vers SamerTrackly ne peut pas
   *  traduire `produit_id` — chaque site a ses propres uuid. Rempli par trigger. */
  produit_code: text('produit_code'),
  produit_nom: text('produit_nom'),
  saisi_par: uuid('saisi_par').references(() => utilisateurs.id),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('idx_entrees_stock_inventaire').on(t.inventaire_id),
  check('entrees_stock_quantite_check', sql`${t.quantite} > 0`),
]);

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

// Routage d'impression LOCAL (comme disponibilite_locale : jamais écrasé par une
// descente catalogue cloud). Résolution d'un article :
//   routage_article[article] ?? routage_categorie[catégorie] ?? POSTE_IMPRESSION_DEFAUT
export const routageCategorie = pgTable('routage_categorie', {
  categorie_id: uuid('categorie_id').primaryKey().references(() => categories.id, { onDelete: 'cascade' }),
  poste: posteImpression('poste').notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const routageArticle = pgTable('routage_article', {
  article_id: uuid('article_id').primaryKey().references(() => articles.id, { onDelete: 'cascade' }),
  poste: posteImpression('poste').notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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
