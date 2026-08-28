-- ============================================================================
-- POS OFFLINE-FIRST — SCHÉMA CLOUD (Supabase, projet dédié POS)
-- Sprint 3 — réplica cloud des ventes + source siège du catalogue.
--
-- Principes de fiabilité (§16 risque 3) : zéro perte, zéro doublon.
--   * Chaque table métier reprend les colonnes locales + restaurant_id.
--   * PK = (restaurant_id, id) : l'id reste le MÊME UUID que local → UPSERT
--     idempotent, rejouable ; et deux sites qui portent le même UUID (image de
--     déploiement copiée telle quelle) ne peuvent JAMAIS s'écraser l'un l'autre.
--     Tout UPSERT doit donc cibler (restaurant_id, id) — jamais id seul.
--   * Les tables de ventes N'ONT PAS de FK croisées : les lignes arrivent
--     par lots dans l'ordre du seq local, mais un lot peut couper un
--     parent/enfant ; on privilégie un réplica tolérant plutôt que des
--     contraintes qui feraient échouer une remontée. L'intégrité est
--     garantie en amont par la base LOCALE (source de vérité).
--   * RLS activée partout : accès uniquement via les Edge Functions
--     (service_role), jamais de lecture anonyme.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- Contrôle de synchronisation
-- ----------------------------------------------------------------------------

-- Un site = un restaurant. Clé API propre, révocable individuellement.
CREATE TABLE IF NOT EXISTS sites_autorises (
  restaurant_id UUID PRIMARY KEY,
  code          TEXT NOT NULL,
  cle_hash      TEXT NOT NULL UNIQUE,   -- sha256(cle_site) en hexadécimal
  actif         BOOLEAN NOT NULL DEFAULT TRUE,
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Suivi « dernier sync par site » (montée).
CREATE TABLE IF NOT EXISTS sync_journal (
  id            BIGSERIAL PRIMARY KEY,
  restaurant_id UUID NOT NULL,
  type          TEXT NOT NULL,          -- 'PUSH' | 'PULL' | 'RECONCILE'
  nb_lignes     INTEGER NOT NULL DEFAULT 0,
  dernier_seq   BIGINT,                 -- dernier seq local acquitté (PUSH)
  recu_le       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sync_journal_site ON sync_journal (restaurant_id, recu_le);

-- Résultat des réconciliations quotidiennes.
CREATE TABLE IF NOT EXISTS reconciliations (
  id            BIGSERIAL PRIMARY KEY,
  restaurant_id UUID NOT NULL,
  jour          DATE NOT NULL,
  total_local   INTEGER NOT NULL,
  total_cloud   INTEGER NOT NULL,
  ecart         INTEGER NOT NULL,
  statut        TEXT NOT NULL CHECK (statut IN ('OK','ECART')),
  detail        JSONB NOT NULL DEFAULT '{}',
  recu_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, jour)
);

-- ----------------------------------------------------------------------------
-- Tables de VENTES (montée local → cloud). PK = id, + restaurant_id.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS commandes (
  id             UUID PRIMARY KEY,
  restaurant_id  UUID NOT NULL,
  numero_ticket  BIGINT,
  type           TEXT,
  table_id       UUID,
  partenaire     TEXT,
  ref_partenaire TEXT,
  contact_client TEXT,
  service_id     UUID,
  caissier_id    UUID,
  serveur_id     UUID,
  statut         TEXT,
  origine        TEXT,
  refus_motif    TEXT,
  sous_total     INTEGER,
  remise_montant INTEGER,
  remise_par     UUID,
  remise_motif   TEXT,
  promo_id       UUID,
  promo_montant  INTEGER,
  total          INTEGER,
  created_at     TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cloud_commandes ON commandes (restaurant_id, created_at);

CREATE TABLE IF NOT EXISTS commande_items (
  id             UUID PRIMARY KEY,
  restaurant_id  UUID NOT NULL,
  commande_id    UUID,
  article_id     UUID,
  combo_id       UUID,
  nom_snapshot   TEXT,
  prix_unitaire  INTEGER,
  quantite       SMALLINT,
  options        JSONB,
  supplements    JSONB,
  statut_cuisine TEXT,
  envoye_le      TIMESTAMPTZ,
  attribue_a     UUID[],
  annule_par     UUID,
  annule_motif   TEXT
);
CREATE INDEX IF NOT EXISTS idx_cloud_items ON commande_items (restaurant_id, commande_id);

CREATE TABLE IF NOT EXISTS notes_split (
  id             UUID PRIMARY KEY,
  restaurant_id  UUID NOT NULL,
  commande_id    UUID,
  numero         SMALLINT NOT NULL CHECK (numero > 0),
  libelle        TEXT,
  type           TEXT NOT NULL DEFAULT 'ARTICLES' CHECK (type IN ('ARTICLES','MONTANT_HISTORIQUE')),
  statut         TEXT NOT NULL DEFAULT 'A_PAYER' CHECK (statut IN ('A_PAYER','PARTIELLEMENT_PAYEE','PAYEE','ANNULEE')),
  sous_total     INTEGER NOT NULL CHECK (sous_total > 0),
  promo_montant  INTEGER NOT NULL DEFAULT 0 CHECK (promo_montant >= 0),
  remise_montant INTEGER NOT NULL DEFAULT 0 CHECK (remise_montant >= 0),
  fidelite_montant INTEGER NOT NULL DEFAULT 0 CHECK (fidelite_montant >= 0),
  client_fidelite_id UUID,
  fidelite_points INTEGER NOT NULL DEFAULT 0,
  montant        INTEGER,
  service_id     UUID,
  payee_par      UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  payee_le       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cloud_notes ON notes_split (restaurant_id, commande_id);

CREATE TABLE IF NOT EXISTS note_split_items (
  id               UUID PRIMARY KEY,
  restaurant_id    UUID NOT NULL,
  note_id           UUID NOT NULL,
  commande_item_id UUID NOT NULL,
  quantite         SMALLINT NOT NULL CHECK (quantite > 0),
  montant_brut     INTEGER NOT NULL CHECK (montant_brut > 0),
  UNIQUE (restaurant_id, note_id, commande_item_id)
);
CREATE INDEX IF NOT EXISTS idx_cloud_note_split_items ON note_split_items (restaurant_id, note_id);

CREATE TABLE IF NOT EXISTS paiements (
  id             UUID PRIMARY KEY,
  restaurant_id  UUID NOT NULL,
  commande_id    UUID,
  note_id        UUID,
  mode           TEXT,
  montant        INTEGER,
  montant_recu   INTEGER,
  monnaie_rendue INTEGER,
  encaisse_par   UUID,
  service_id     UUID,
  created_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cloud_paiements ON paiements (restaurant_id, created_at);

CREATE TABLE IF NOT EXISTS services_caisse (
  id                UUID PRIMARY KEY,
  restaurant_id     UUID NOT NULL,
  caissier_id       UUID,
  fond_de_caisse    INTEGER,
  ouvert_le         TIMESTAMPTZ,
  cloture_le        TIMESTAMPTZ,
  statut            TEXT,
  especes_comptees  INTEGER,
  especes_theorique INTEGER,
  ecart             INTEGER,
  explication_ecart TEXT,
  remis_le          TIMESTAMPTZ,
  rapport_z         JSONB
);
CREATE INDEX IF NOT EXISTS idx_cloud_services ON services_caisse (restaurant_id, ouvert_le);

CREATE TABLE IF NOT EXISTS audit_log (
  id            UUID PRIMARY KEY,
  restaurant_id UUID NOT NULL,
  seq           BIGINT,               -- seq local (ordre par site, informatif)
  user_id       UUID,
  action        TEXT,
  entite        TEXT,
  entite_id     UUID,
  montant       INTEGER,
  motif         TEXT,
  meta          JSONB,
  created_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cloud_audit ON audit_log (restaurant_id, created_at);

-- Sprint 4 : présences (pointages) et fidélité (réplica montée).
CREATE TABLE IF NOT EXISTS pointages (
  id             UUID PRIMARY KEY,
  restaurant_id  UUID NOT NULL,
  user_id        UUID,
  methode        TEXT,
  arrivee        TIMESTAMPTZ,
  depart         TIMESTAMPTZ,
  depart_oublie  BOOLEAN
);
CREATE INDEX IF NOT EXISTS idx_cloud_pointages ON pointages (restaurant_id, arrivee);

CREATE TABLE IF NOT EXISTS clients_fidelite (
  id            UUID PRIMARY KEY,
  restaurant_id UUID NOT NULL,
  telephone     TEXT,
  nom           TEXT,
  created_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cloud_clients ON clients_fidelite (restaurant_id, telephone);

CREATE TABLE IF NOT EXISTS points_fidelite (
  id            UUID PRIMARY KEY,
  restaurant_id UUID NOT NULL,
  client_id     UUID,
  commande_id   UUID,
  note_id       UUID,
  points        INTEGER,
  source        TEXT,
  created_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cloud_points ON points_fidelite (restaurant_id, client_id);

-- ----------------------------------------------------------------------------
-- Tables de CATALOGUE / UTILISATEURS / PROMOTIONS (descente cloud → local).
-- Source siège. Colonne version : monotone, bump à chaque écriture (trigger).
-- ----------------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS cloud_version_seq START 1;

CREATE OR REPLACE FUNCTION bump_version() RETURNS trigger AS $$
BEGIN
  NEW.version := nextval('cloud_version_seq');
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Macro : crée une table descente avec restaurant_id + version + trigger.
-- (écrites explicitement pour lisibilité)

CREATE TABLE IF NOT EXISTS categories (
  id            UUID PRIMARY KEY,
  restaurant_id UUID NOT NULL,
  parent_id     UUID,
  nom           TEXT,
  ordre         SMALLINT,
  actif         BOOLEAN,
  version       BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS articles (
  id            UUID PRIMARY KEY,
  restaurant_id UUID NOT NULL,
  categorie_id  UUID,
  nom           TEXT,
  description   TEXT,
  prix_base     INTEGER,
  image_url     TEXT,
  disponible    BOOLEAN,
  actif         BOOLEAN,
  updated_at    TIMESTAMPTZ,
  version       BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS prix_canaux (
  id            UUID PRIMARY KEY,
  restaurant_id UUID NOT NULL,
  article_id    UUID,
  canal         TEXT,
  prix          INTEGER,
  version       BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS groupes_options (
  id            UUID PRIMARY KEY,
  restaurant_id UUID NOT NULL,
  article_id    UUID,
  nom           TEXT,
  choix_min     SMALLINT,
  choix_max     SMALLINT,
  version       BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS options (
  id            UUID PRIMARY KEY,
  restaurant_id UUID NOT NULL,
  groupe_id     UUID,
  nom           TEXT,
  version       BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS supplements (
  id            UUID PRIMARY KEY,
  restaurant_id UUID NOT NULL,
  article_id    UUID,
  nom           TEXT,
  prix          INTEGER,
  version       BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS combos (
  id            UUID PRIMARY KEY,
  restaurant_id UUID NOT NULL,
  nom           TEXT,
  prix          INTEGER,
  disponible    BOOLEAN,
  actif         BOOLEAN,
  version       BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS combo_articles (
  id            UUID PRIMARY KEY,   -- clé de synchro synthétique (uuid) côté cloud
  restaurant_id UUID NOT NULL,
  combo_id      UUID,
  article_id    UUID,
  quantite      SMALLINT,
  version       BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS promotions (
  id            UUID PRIMARY KEY,
  restaurant_id UUID NOT NULL,
  nom           TEXT,
  type          TEXT,
  valeur        INTEGER,
  heure_debut   TIME,
  heure_fin     TIME,
  jours         SMALLINT[],
  article_id    UUID,
  actif         BOOLEAN,
  version       BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS utilisateurs (
  id             UUID PRIMARY KEY,
  restaurant_id  UUID NOT NULL,
  nom_complet    TEXT,
  role           TEXT,
  poste_cuisine  TEXT,
  pin_hash       TEXT,
  telephone      TEXT,
  actif          BOOLEAN,
  version        BIGINT NOT NULL DEFAULT 0
);

-- Barème fidélité & autres paramètres édités au siège (sprint 4C §2.5) :
-- descendent comme le catalogue (clé = restaurant_id + cle).
CREATE TABLE IF NOT EXISTS parametres_locaux (
  restaurant_id UUID NOT NULL,
  cle           TEXT NOT NULL,
  valeur        JSONB,
  version       BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (restaurant_id, cle)
);

-- Triggers de version sur chaque table descente
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['categories','articles','prix_canaux','groupes_options',
    'options','supplements','combos','combo_articles','promotions','utilisateurs',
    'parametres_locaux']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_version ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_version BEFORE INSERT OR UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION bump_version()', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_ver ON %I (restaurant_id, version)', t, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Cloisonnement : PK composite (restaurant_id, id) sur toutes les tables
-- métier. Deux restaurants peuvent porter le même UUID (même image de
-- déploiement) sans jamais se marcher dessus. Idempotent.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t     TEXT;
  pk    TEXT;
  ncols INT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'commandes','commande_items','notes_split','note_split_items','paiements','services_caisse',
    'audit_log','pointages','clients_fidelite','points_fidelite',
    'categories','articles','prix_canaux','groupes_options','options',
    'supplements','combos','combo_articles','promotions','utilisateurs'
  ]
  LOOP
    CONTINUE WHEN to_regclass(t) IS NULL;  -- cloud plus ancien : table absente
    SELECT c.conname, array_length(c.conkey, 1)
      INTO pk, ncols
      FROM pg_constraint c
     WHERE c.conrelid = t::regclass AND c.contype = 'p';
    IF pk IS NOT NULL AND ncols = 1 THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, pk);
    END IF;
    IF pk IS NULL OR ncols = 1 THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN id SET NOT NULL', t);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN restaurant_id SET NOT NULL', t);
      EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY (restaurant_id, id)', t);
    END IF;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS notes_split_commande_numero_unique
  ON notes_split (restaurant_id, commande_id, numero);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notes_split_commande_fk') THEN
    ALTER TABLE notes_split ADD CONSTRAINT notes_split_commande_fk
      FOREIGN KEY (restaurant_id, commande_id) REFERENCES commandes(restaurant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notes_split_client_fk') THEN
    ALTER TABLE notes_split ADD CONSTRAINT notes_split_client_fk
      FOREIGN KEY (restaurant_id, client_fidelite_id) REFERENCES clients_fidelite(restaurant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notes_split_service_fk') THEN
    ALTER TABLE notes_split ADD CONSTRAINT notes_split_service_fk
      FOREIGN KEY (restaurant_id, service_id) REFERENCES services_caisse(restaurant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notes_split_payee_par_fk') THEN
    ALTER TABLE notes_split ADD CONSTRAINT notes_split_payee_par_fk
      FOREIGN KEY (restaurant_id, payee_par) REFERENCES utilisateurs(restaurant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'note_split_items_note_fk') THEN
    ALTER TABLE note_split_items ADD CONSTRAINT note_split_items_note_fk
      FOREIGN KEY (restaurant_id, note_id) REFERENCES notes_split(restaurant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'note_split_items_item_fk') THEN
    ALTER TABLE note_split_items ADD CONSTRAINT note_split_items_item_fk
      FOREIGN KEY (restaurant_id, commande_item_id) REFERENCES commande_items(restaurant_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'points_fidelite_note_fk') THEN
    ALTER TABLE points_fidelite ADD CONSTRAINT points_fidelite_note_fk
      FOREIGN KEY (restaurant_id, note_id) REFERENCES notes_split(restaurant_id, id);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- RLS : tout est verrouillé. Les Edge Functions utilisent la service_role,
-- qui contourne la RLS. Aucune politique anonyme => aucune lecture publique.
-- ----------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sites_autorises','sync_journal','reconciliations',
    'commandes','commande_items','notes_split','note_split_items','paiements','services_caisse','audit_log',
    'pointages','clients_fidelite','points_fidelite',
    'categories','articles','prix_canaux','groupes_options','options','supplements',
    'combos','combo_articles','promotions','utilisateurs','parametres_locaux']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ============================================================================
-- FIN — appliquer via l'éditeur SQL Supabase (ou `supabase db push`).
-- ============================================================================
