-- ============================================================================
-- POS OFFLINE-FIRST — CHEZ SAMER / AL KAYAN
-- Schéma PostgreSQL 16 — Base LOCALE (1 instance par restaurant)
-- Version 1.0 — conforme au cahier des charges v1.1
--
-- NOTES CLOUD : la base cloud POS reprend les mêmes tables avec en plus
--   une colonne restaurant_id UUID NOT NULL sur chaque table métier,
--   RLS activée par restaurant_id, et une clé API distincte par site.
--   Les tables sync_outbox / parametres_locaux n'existent qu'en local.
--
-- CONVENTIONS
--   * Tous les montants sont en FCFA, stockés en INTEGER (pas de centimes).
--   * Tous les id sont des UUID v4 générés côté serveur local (synchro sans conflit).
--   * created_at / updated_at en timestamptz, générés par la base.
--   * Les libellés visibles par l'utilisateur sont en français.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gen_random_uuid()

-- ============================================================================
-- 0. CONFIGURATION DU SITE
-- ============================================================================

CREATE TABLE restaurant (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          TEXT NOT NULL UNIQUE,           -- ex: 'SAMER_ANGRE7E'
  nom           TEXT NOT NULL,                  -- ex: 'Chez Samer Angré 7E'
  marque        TEXT NOT NULL CHECK (marque IN ('SAMER','AL_KAYAN')),
  couleur_hex   TEXT NOT NULL,                  -- '#EF9F27' ou '#2D7D46'
  actif         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Base locale : exactement 1 ligne. Base cloud : 1 ligne par site.

CREATE TABLE parametres_locaux (        -- LOCAL UNIQUEMENT
  cle           TEXT PRIMARY KEY,       -- ex: 'seuil_alerte_ecart_caisse'
  valeur        JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 1. UTILISATEURS ET RÔLES (§8, §14.1)
-- ============================================================================

CREATE TYPE role_pos AS ENUM ('PROPRIETAIRE','MANAGER','CAISSIER','SERVEUR','CUISINE');
CREATE TYPE poste_cuisine AS ENUM ('CUISINIER','PIZZAIOLO','COMPTOIRISTE');

-- Sprint 4B+4C : rôles composés de permissions (roles + role_permissions).
CREATE TABLE roles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom        TEXT NOT NULL UNIQUE,
  systeme    BOOLEAN NOT NULL DEFAULT FALSE,
  actif      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE role_permissions (
  role_id        UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_cle TEXT NOT NULL,
  PRIMARY KEY (role_id, permission_cle)
);

CREATE TABLE utilisateurs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom_complet     TEXT NOT NULL,
  role            role_pos,                     -- ancien enum (compat), source = role_id
  role_id         UUID REFERENCES roles(id),    -- rôle composé (sprint 4B+4C)
  poste_cuisine   poste_cuisine,                -- NULL sauf cuisine
  pin_hash        TEXT NOT NULL,                -- argon2id, jamais le PIN en clair
  telephone       TEXT,                         -- pour pointage SMS
  actif           BOOLEAN NOT NULL DEFAULT TRUE,
  -- anti-force brute (§14.1)
  tentatives_pin  SMALLINT NOT NULL DEFAULT 0,
  verrou_jusqua   TIMESTAMPTZ,
  -- sprint 4C : PIN posé par l'employé (code temporaire à usage unique)
  doit_definir_pin      BOOLEAN NOT NULL DEFAULT FALSE,
  pin_temporaire_hash   TEXT,
  pin_temporaire_expire TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 2. CATALOGUE (§5.2) — maîtrisé par le siège, écrasé à la descente de synchro
-- ============================================================================

CREATE TABLE categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id   UUID REFERENCES categories(id),
  nom         TEXT NOT NULL,
  ordre       SMALLINT NOT NULL DEFAULT 0,
  actif       BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE articles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  categorie_id  UUID NOT NULL REFERENCES categories(id),
  nom           TEXT NOT NULL,
  description   TEXT,
  prix_base     INTEGER NOT NULL CHECK (prix_base >= 0),  -- prix sur place, FCFA
  image_url     TEXT,
  disponible    BOOLEAN NOT NULL DEFAULT TRUE,            -- legacy (source = disponibilite_locale)
  actif         BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Disponibilité LOCALE (sprint 4C §2.3) : posée sur place, jamais écrasée par
-- une descente de catalogue (source de vérité pour « épuisé »).
CREATE TABLE disponibilite_locale (
  article_id  UUID PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  disponible  BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Surcharge de prix par canal/partenaire (§5.2) : ex chawarma 3000 Yango, 3500 Glovo
CREATE TABLE prix_canaux (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id  UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  canal       TEXT NOT NULL,     -- 'YANGO','GLOVO','SAMER_DELIV','EMPORTER'...
  prix        INTEGER NOT NULL CHECK (prix >= 0),
  UNIQUE (article_id, canal)
);

-- Groupes d'options (choix sans supplément) : ex "Cuisson", "Sauce"
CREATE TABLE groupes_options (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id  UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  nom         TEXT NOT NULL,
  choix_min   SMALLINT NOT NULL DEFAULT 0,
  choix_max   SMALLINT NOT NULL DEFAULT 1
);

CREATE TABLE options (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  groupe_id   UUID NOT NULL REFERENCES groupes_options(id) ON DELETE CASCADE,
  nom         TEXT NOT NULL
);

-- Suppléments payants
CREATE TABLE supplements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id  UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  nom         TEXT NOT NULL,
  prix        INTEGER NOT NULL CHECK (prix >= 0)
);

-- Combos / menus à prix packagé
CREATE TABLE combos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom         TEXT NOT NULL,
  prix        INTEGER NOT NULL CHECK (prix >= 0),
  disponible  BOOLEAN NOT NULL DEFAULT TRUE,
  actif       BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE combo_articles (
  combo_id    UUID NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  article_id  UUID NOT NULL REFERENCES articles(id),
  quantite    SMALLINT NOT NULL DEFAULT 1,
  PRIMARY KEY (combo_id, article_id)
);

-- Correction 4 : correspondance poste de cuisine ↔ catégorie, pour
-- l'attribution automatique des plats préparés (ex. Pizzas → PIZZAIOLO).
CREATE TABLE mapping_poste_categorie (
  poste_cuisine  poste_cuisine NOT NULL,
  categorie_id   UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (poste_cuisine, categorie_id)
);

-- Promotions automatiques (§5.5) : happy hour, promo du jour
CREATE TABLE promotions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom           TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('POURCENTAGE','MONTANT')),
  valeur        INTEGER NOT NULL,          -- 20 (=%) ou 500 (=FCFA)
  heure_debut   TIME,
  heure_fin     TIME,
  jours         SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}', -- 1=lundi
  article_id    UUID REFERENCES articles(id),   -- NULL = tout le menu
  actif         BOOLEAN NOT NULL DEFAULT TRUE
);

-- ============================================================================
-- 3. PLAN DE SALLE (§5.1)
-- ============================================================================

CREATE TABLE zones (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom     TEXT NOT NULL,               -- 'RC', 'VIP RC', 'Terrasse'...
  couleur TEXT,
  ordre   SMALLINT NOT NULL DEFAULT 0
);

CREATE TABLE tables_salle (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zone_id     UUID NOT NULL REFERENCES zones(id),
  numero      TEXT NOT NULL,           -- 'T1', 'VIP3'...
  -- tables virtuelles partenaires (§5.1) : zone 'Livraison'
  partenaire  TEXT,                    -- NULL, ou 'YANGO','GLOVO','SAMER_DELIV'
  statut      TEXT NOT NULL DEFAULT 'LIBRE'
              CHECK (statut IN ('LIBRE','OCCUPEE','ADDITION_DEMANDEE')),
  qr_token    TEXT UNIQUE,             -- token du QR de notation collé sur la table
  -- CORRECTIONS3 point 3 : serveur propriétaire (à l'ouverture, NULL si LIBRE)
  ouverte_par UUID REFERENCES utilisateurs(id),
  actif       BOOLEAN NOT NULL DEFAULT TRUE,   -- sprint 4C : désactivation (2.2)
  UNIQUE (zone_id, numero)
);

-- CORRECTIONS3 Point 1 : appels d'une table depuis le téléphone client (QR).
CREATE TABLE appels_table (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id    UUID NOT NULL REFERENCES tables_salle(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('APPEL_SERVEUR','DEMANDE_FACTURE')),
  statut      TEXT NOT NULL DEFAULT 'EN_ATTENTE' CHECK (statut IN ('EN_ATTENTE','TRAITE')),
  cree_le     TIMESTAMPTZ NOT NULL DEFAULT now(),
  traite_le   TIMESTAMPTZ,
  traite_par  UUID REFERENCES utilisateurs(id)
);
-- Anti-doublon : un seul appel EN_ATTENTE par (table, type).
CREATE UNIQUE INDEX un_appel_en_attente_par_table_type
  ON appels_table (table_id, type) WHERE statut = 'EN_ATTENTE';

-- ============================================================================
-- 4. SERVICES CAISSE / SHIFTS (§5.7, §14.3)
-- ============================================================================

CREATE TABLE services_caisse (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caissier_id        UUID NOT NULL REFERENCES utilisateurs(id),
  fond_de_caisse     INTEGER NOT NULL CHECK (fond_de_caisse >= 0),
  ouvert_le          TIMESTAMPTZ NOT NULL DEFAULT now(),
  cloture_le         TIMESTAMPTZ,
  statut             TEXT NOT NULL DEFAULT 'OUVERT'
                     CHECK (statut IN ('OUVERT','CLOTURE')),
  -- Comptage à l'aveugle (§14.3) : comptees est saisi AVANT que le serveur
  -- ne calcule/révèle theorique. L'API refuse de renvoyer theorique tant
  -- que especes_comptees IS NULL.
  especes_comptees   INTEGER,
  especes_theorique  INTEGER,
  ecart              INTEGER,          -- comptees - theorique, calculé à la clôture
  rapport_z          JSONB             -- snapshot figé du rapport Z
);
CREATE UNIQUE INDEX un_service_ouvert_par_caissier
  ON services_caisse (caissier_id) WHERE statut = 'OUVERT';

-- ============================================================================
-- 5. COMMANDES (§5.1) — cœur du sprint 1
-- ============================================================================

-- Numérotation séquentielle CONTINUE des tickets (§14.2) : aucun trou possible.
CREATE SEQUENCE seq_numero_ticket START 1;

CREATE TYPE type_commande AS ENUM ('SUR_PLACE','EMPORTER','LIVRAISON');
CREATE TYPE statut_commande AS ENUM
  ('OUVERTE','ENVOYEE_CUISINE','PRETE','SERVIE','PAYEE','ANNULEE');

CREATE TABLE commandes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  numero_ticket  BIGINT NOT NULL UNIQUE DEFAULT nextval('seq_numero_ticket'),
  type           type_commande NOT NULL,
  table_id       UUID REFERENCES tables_salle(id),
  partenaire     TEXT,                              -- YANGO/GLOVO/SAMER_DELIV si livraison
  ref_partenaire TEXT,                              -- n° de commande côté partenaire
  service_id     UUID REFERENCES services_caisse(id),
  caissier_id    UUID REFERENCES utilisateurs(id),
  serveur_id     UUID REFERENCES utilisateurs(id),  -- si prise en salle
  statut         statut_commande NOT NULL DEFAULT 'OUVERTE',
  -- CORRECTIONS3 : origine de la commande. Une proposition CLIENT_QR n'atteint
  -- JAMAIS la cuisine sans validation (serveur ou caisse en repli).
  origine        TEXT NOT NULL DEFAULT 'CAISSE'
                 CHECK (origine IN ('CAISSE','SERVEUR','CLIENT_QR')),
  refus_motif    TEXT,                              -- message si commande client refusée
  -- Sprint 4 B : fidélité (rattachement client + remise en points).
  -- FK vers clients_fidelite ajoutée par la migration 0005 (table définie §11).
  client_fidelite_id UUID,
  fidelite_points    INTEGER NOT NULL DEFAULT 0,
  fidelite_montant   INTEGER NOT NULL DEFAULT 0,
  -- montants figés (snapshot, jamais recalculés après paiement)
  sous_total     INTEGER NOT NULL DEFAULT 0,
  remise_montant INTEGER NOT NULL DEFAULT 0,
  remise_par     UUID REFERENCES utilisateurs(id),  -- manager/proprio uniquement
  remise_motif   TEXT,                              -- obligatoire si remise
  promo_id       UUID REFERENCES promotions(id),
  promo_montant  INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT remise_motif_obligatoire
    CHECK (remise_montant = 0 OR (remise_motif IS NOT NULL AND remise_par IS NOT NULL))
);
CREATE INDEX idx_commandes_service ON commandes (service_id);
CREATE INDEX idx_commandes_jour ON commandes (created_at);

CREATE TABLE commande_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commande_id    UUID NOT NULL REFERENCES commandes(id) ON DELETE CASCADE,
  article_id     UUID REFERENCES articles(id),
  combo_id       UUID REFERENCES combos(id),
  nom_snapshot   TEXT NOT NULL,        -- nom figé au moment de la vente
  prix_unitaire  INTEGER NOT NULL,     -- prix figé (canal appliqué)
  quantite       SMALLINT NOT NULL CHECK (quantite > 0),
  options        JSONB NOT NULL DEFAULT '[]',   -- [{groupe, choix}]
  supplements    JSONB NOT NULL DEFAULT '[]',   -- [{nom, prix}]
  statut_cuisine TEXT NOT NULL DEFAULT 'A_PREPARER'
                 CHECK (statut_cuisine IN ('A_PREPARER','EN_COURS','PRET','ANNULE')),
  -- Sprint 2 (KDS) : NULL = article encore dans l'addition, non NULL = parti
  -- en cuisine (son annulation devient une action protégée PIN manager).
  envoye_le      TIMESTAMPTZ,
  -- Correction 4 : attribution automatique du plat aux employés du poste
  -- correspondant (mapping_poste_categorie) pointés au moment de la
  -- préparation. Collective si plusieurs. Vide si personne n'est pointé.
  attribue_a     UUID[] NOT NULL DEFAULT '{}',
  annule_par     UUID REFERENCES utilisateurs(id),
  annule_motif   TEXT,
  CONSTRAINT item_source CHECK (article_id IS NOT NULL OR combo_id IS NOT NULL),
  CONSTRAINT annulation_tracee
    CHECK (statut_cuisine <> 'ANNULE' OR (annule_par IS NOT NULL AND annule_motif IS NOT NULL))
);

-- ============================================================================
-- 6. PAIEMENTS (§5.5) — mixte + split
-- ============================================================================

CREATE TYPE mode_paiement AS ENUM
  ('ESPECES','WAVE','ORANGE_MONEY','MTN_MOMO','MOOV_MONEY','CARTE');

-- Split de note : une commande est divisée en 1..n notes ; chaque note est
-- payée par 1..n paiements (paiement mixte). Cas simple = 1 note implicite.
CREATE TABLE notes_split (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commande_id  UUID NOT NULL REFERENCES commandes(id) ON DELETE CASCADE,
  libelle      TEXT NOT NULL DEFAULT 'Note 1',   -- 'Client A', 'Client B'...
  montant      INTEGER NOT NULL CHECK (montant > 0)
);

CREATE TABLE paiements (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commande_id  UUID NOT NULL REFERENCES commandes(id),
  note_id      UUID REFERENCES notes_split(id),
  mode         mode_paiement NOT NULL,
  montant      INTEGER NOT NULL CHECK (montant > 0),
  encaisse_par UUID NOT NULL REFERENCES utilisateurs(id),
  service_id   UUID NOT NULL REFERENCES services_caisse(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Règle serveur : SUM(paiements.montant) == commandes.total avant statut PAYEE.

-- ============================================================================
-- 7. JOURNAL D'AUDIT IMMUABLE (§14.2)
-- ============================================================================

CREATE TABLE audit_log (
  seq         BIGSERIAL PRIMARY KEY,             -- ordre strict local
  id          UUID NOT NULL DEFAULT gen_random_uuid(),  -- id global pour la synchro
  user_id     UUID REFERENCES utilisateurs(id),
  action      TEXT NOT NULL,   -- 'REMISE','ANNULATION_ITEM','REOUVERTURE_NOTE',
                               -- 'CORRECTION_POINTAGE','CONNEXION','ECHEC_PIN',
                               -- 'CLOTURE_SERVICE','MODIF_CATALOGUE_LOCAL'...
  entite      TEXT NOT NULL,
  entite_id   UUID,
  montant     INTEGER,
  motif       TEXT,
  meta        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only : personne (même propriétaire) ne modifie ni ne supprime.
CREATE OR REPLACE FUNCTION bloque_modification() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log est en ajout seul (append-only)';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER audit_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION bloque_modification();

-- ============================================================================
-- 8. SYNCHRONISATION — LOCAL UNIQUEMENT (§3.5, outbox pattern)
-- ============================================================================

CREATE TABLE sync_outbox (
  seq         BIGSERIAL PRIMARY KEY,
  table_name  TEXT NOT NULL,
  record_id   UUID NOT NULL,
  operation   TEXT NOT NULL CHECK (operation IN ('INSERT','UPDATE')),
  payload     JSONB NOT NULL,        -- ligne complète sérialisée
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at   TIMESTAMPTZ            -- NULL = en attente d'internet
);
CREATE INDEX idx_outbox_pending ON sync_outbox (seq) WHERE synced_at IS NULL;
-- Idempotence côté cloud : UPSERT sur (record_id). Rejouable sans doublon.

CREATE TABLE sync_etat (               -- suivi descente catalogue
  flux        TEXT PRIMARY KEY,        -- 'CATALOGUE','PROMOTIONS','UTILISATEURS'
  version     BIGINT NOT NULL DEFAULT 0,
  synced_at   TIMESTAMPTZ
);

-- Sprint 2 (§16 risque 7) : idempotence des actions rejouées par la file
-- locale des tablettes serveur. Chaque action porte un UUID généré sur la
-- tablette ; un UUID déjà présent ici est ignoré (rejeu sans doublon).
CREATE TABLE actions_recues (
  uuid       UUID PRIMARY KEY,
  traite_le  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 9. NOTATION CLIENT (§6) — sprint 2+
-- ============================================================================

CREATE TABLE notations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id     UUID REFERENCES tables_salle(id),
  commande_id  UUID REFERENCES commandes(id),   -- commande active récente exigée (§16 risque 10)
  cuisine      SMALLINT CHECK (cuisine BETWEEN 1 AND 5),
  service      SMALLINT CHECK (service BETWEEN 1 AND 5),
  ambiance     SMALLINT CHECK (ambiance BETWEEN 1 AND 5),
  commentaire  TEXT,
  serveur_id   UUID REFERENCES utilisateurs(id),
  caissier_id  UUID REFERENCES utilisateurs(id),
  cuisiniers   UUID[] NOT NULL DEFAULT '{}',
  device_hash  TEXT,                            -- anti-spam
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 10. POINTAGE (§7) — sprint 2+
-- ============================================================================

CREATE TABLE pointages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES utilisateurs(id),
  methode     TEXT NOT NULL CHECK (methode IN ('GEOFENCING','SMS_MDP','PIN_POS')),
  arrivee     TIMESTAMPTZ NOT NULL DEFAULT now(),
  depart      TIMESTAMPTZ,
  depart_oublie BOOLEAN NOT NULL DEFAULT FALSE  -- alerte manager (§7.3)
);

CREATE TABLE codes_pointage (            -- codes SMS à usage unique (§14.5)
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES utilisateurs(id),
  code_hash  TEXT NOT NULL,
  expire_a   TIMESTAMPTZ NOT NULL,       -- now() + 10 min
  utilise_a  TIMESTAMPTZ                 -- anti-rejeu
);

-- ============================================================================
-- 11. FIDÉLITÉ (§9) — sprint 2+, identifiant client partagé avec SAMER DELIV
-- ============================================================================

CREATE TABLE clients_fidelite (
  id          UUID PRIMARY KEY,          -- MÊME id que dans SAMER DELIV (pas de default)
  telephone   TEXT UNIQUE,
  nom         TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE points_fidelite (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES clients_fidelite(id),
  commande_id UUID REFERENCES commandes(id),
  points      INTEGER NOT NULL,          -- positif = gain, négatif = utilisation
  source      TEXT NOT NULL DEFAULT 'POS',   -- 'POS' | 'SAMER_DELIV'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- FIN — Tables sprint 1 : restaurant, parametres_locaux, utilisateurs,
-- categories, articles, prix_canaux, groupes_options, options, supplements,
-- combos, combo_articles, promotions, zones, tables_salle, services_caisse,
-- commandes, commande_items, notes_split, paiements, audit_log,
-- sync_outbox (structure seule), sync_etat.
-- ============================================================================
