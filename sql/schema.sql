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
-- Poste d'impression (routage des tickets) : chaque poste ↔ une imprimante locale.
CREATE TYPE poste_impression AS ENUM ('CAISSE','CUISINE','BAR');

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
  -- Salaire journalier proposé au paiement (§6.8). Modifiable au moment de
  -- payer, mais tout écart au taux de la fiche exige un motif.
  taux_journalier INTEGER CHECK (taux_journalier IS NULL OR taux_journalier >= 0),
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
  canal       TEXT NOT NULL,     -- 'YANGO','GLOVO','SAMER_DELLY','EMPORTER'...
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

-- Options reutilisables (migration 0020). Remplacent groupes_options/options
-- et supplements, qui restent en place uniquement parce que la descente cloud
-- les alimente encore : plus aucune lecture applicative ne passe par eux.
-- Tables LOCALES, volontairement HORS descente (cf. sync/descente.ts) : une
-- synchro du siege ne les ecrase jamais. Prix unique porte par l'option.
CREATE TABLE options_catalogue (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom         TEXT NOT NULL CHECK (length(btrim(nom)) > 0),
  prix        INTEGER NOT NULL DEFAULT 0 CHECK (prix >= 0),  -- 0 = option gratuite
  actif       BOOLEAN NOT NULL DEFAULT TRUE,
  ordre       SMALLINT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Unicite sur (nom, prix) : le meme nom peut exister a deux prix, la reprise
-- de l'existant ne doit jamais fusionner deux prix de vente differents.
CREATE UNIQUE INDEX options_catalogue_nom_prix_idx
  ON options_catalogue (lower(btrim(nom)), prix);

-- Liaison d'une option a une CATEGORIE entiere OU a un ARTICLE precis.
-- Les options d'un article = celles de sa categorie UNION les siennes.
CREATE TABLE options_liaisons (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  option_id     UUID NOT NULL REFERENCES options_catalogue(id) ON DELETE CASCADE,
  categorie_id  UUID REFERENCES categories(id) ON DELETE CASCADE,
  article_id    UUID REFERENCES articles(id) ON DELETE CASCADE,
  CHECK ((categorie_id IS NULL) <> (article_id IS NULL))
);
CREATE UNIQUE INDEX options_liaisons_categorie_idx
  ON options_liaisons (option_id, categorie_id) WHERE categorie_id IS NOT NULL;
CREATE UNIQUE INDEX options_liaisons_article_idx
  ON options_liaisons (option_id, article_id) WHERE article_id IS NOT NULL;

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

-- Routage d'impression LOCAL (jamais écrasé par une descente catalogue cloud,
-- comme disponibilite_locale). Résolution : article ?? catégorie ?? CUISINE.
CREATE TABLE routage_categorie (
  categorie_id  UUID PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE,
  poste         poste_impression NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE routage_article (
  article_id    UUID PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  poste         poste_impression NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
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
  -- Marqueur de table VIRTUELLE (§5.1) : livraisons en zone 'Livraison'
  -- ('YANGO','GLOVO','SAMER_DELLY') et cadeaux en zone RC ('KDO' — le repas
  -- offert se consomme sur place). NULL = vraie table physique.
  partenaire  TEXT,
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
  -- Verrou de clôture (§6.10) : sans inventaire validé, pas de clôture.
  -- Appliqué CÔTÉ SERVEUR — l'UI ne fait que le refléter.
  inventaire_valide  BOOLEAN NOT NULL DEFAULT FALSE,
  rapport_z          JSONB             -- snapshot figé du rapport Z
);
CREATE UNIQUE INDEX un_service_ouvert_par_caissier
  ON services_caisse (caissier_id) WHERE statut = 'OUVERT';

-- Équipe du jour (allègement — remplace le pointage) : présents d'un service
-- + leur poste du jour (info + remontée back-office, pas de chronométrage).
CREATE TABLE equipe_service (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id     UUID NOT NULL REFERENCES services_caisse(id) ON DELETE CASCADE,
  utilisateur_id UUID NOT NULL REFERENCES utilisateurs(id),
  poste_jour     TEXT NOT NULL,
  -- Heure d'ARRIVÉE = heure du clic sur « Pointer » (§6.7). Une heure saisie à
  -- la main est une heure négociable ; le clic, lui, est daté par le système.
  pointe_le      TIMESTAMPTZ,
  -- Départ (§6.8) : NULL = pas encore tranché, TRUE = reste, FALSE = parti.
  -- À la clôture, tout ce qui n'est pas TRUE est enregistré comme PARTI — le
  -- caissier ne marque donc que les exceptions.
  reste          BOOLEAN,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (service_id, utilisateur_id)
);

-- Registre des dépenses du service (§6.8) : services_caisse.depenses en est la
-- SOMME, la caissière ne retape aucun total.
CREATE TABLE depenses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id  UUID NOT NULL REFERENCES services_caisse(id) ON DELETE CASCADE,
  categorie   TEXT NOT NULL CHECK (categorie IN
              ('MARCHE','LEGUMES','FRUITS','ANNEXES','SALAIRES','ENCOURAGEMENTS')),
  libelle     TEXT NOT NULL CHECK (length(btrim(libelle)) > 0),
  montant     INTEGER NOT NULL CHECK (montant > 0),
  agent_id    UUID REFERENCES utilisateurs(id),   -- qui a été payé (salaire/encouragement)
  saisi_par   UUID NOT NULL REFERENCES utilisateurs(id),
  -- Ligne née d'un paiement réel : NON SUPPRIMABLE. L'effacer ferait
  -- disparaître de l'argent réellement sorti du tiroir.
  auto        BOOLEAN NOT NULL DEFAULT FALSE,
  -- Obligatoire quand le montant payé s'écarte du taux de la fiche : seul
  -- moyen pour le manager de comprendre un écart de paie.
  motif       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Un salaire ou un encouragement dit toujours QUI a été payé.
  CONSTRAINT depenses_agent_check CHECK (
    categorie NOT IN ('SALAIRES','ENCOURAGEMENTS') OR agent_id IS NOT NULL)
);
CREATE INDEX idx_depenses_service ON depenses (service_id);

-- Un même agent n'est payé qu'une fois par service (le bouton « Payer »
-- disparaît ensuite). Un encouragement reste possible en plus du salaire.
CREATE UNIQUE INDEX un_salaire_par_agent_et_service
  ON depenses (service_id, agent_id) WHERE categorie = 'SALAIRES';

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
  -- Code court lisible (ex. « SP215 »), imprimé sur reçu + bons cuisine ;
  -- préfixe type + 3 chiffres aléatoires, unique dans le service. Le
  -- numero_ticket reste la référence continue d'audit.
  code_commande  TEXT,
  type           type_commande NOT NULL,
  table_id       UUID REFERENCES tables_salle(id),
  partenaire     TEXT,                              -- YANGO/GLOVO/SAMER_DELLY si livraison
  ref_partenaire TEXT,                              -- n° de commande côté partenaire
  contact_client TEXT,                              -- téléphone du client livré (saisi à l'envoi en cuisine)
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
  -- Kdo (repas offert, table virtuelle KDO en zone RC) : clôturé PAYEE SANS
  -- aucune ligne de paiement. Compte dans la vente du shift comme une livraison
  -- Yango, mais jamais dans le théorique espèces (calculé sur les paiements).
  offert         BOOLEAN NOT NULL DEFAULT false,
  motif_offert   TEXT,                              -- obligatoire à la clôture
  promo_id       UUID REFERENCES promotions(id),
  promo_montant  INTEGER NOT NULL DEFAULT 0,
  total          INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT remise_motif_obligatoire
    CHECK (remise_montant = 0 OR (remise_motif IS NOT NULL AND remise_par IS NOT NULL)),
  CONSTRAINT motif_offert_obligatoire
    CHECK (offert = false OR statut <> 'PAYEE' OR motif_offert IS NOT NULL)
);
CREATE INDEX idx_commandes_service ON commandes (service_id);
CREATE INDEX idx_commandes_jour ON commandes (created_at);
-- Code court unique dans un même service (retry serveur en cas de collision).
CREATE UNIQUE INDEX uniq_code_commande_service
  ON commandes (service_id, code_commande) WHERE code_commande IS NOT NULL;

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
-- 10. (Pas de table de pointage dédiée. La présence reste portée par l'équipe
--     du jour : equipe_service.pointe_le pour l'arrivée, .reste pour le
--     départ — DESIGN_V2 §6.7/6.8. Toujours aucun chronométrage.)
-- ============================================================================

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
  source      TEXT NOT NULL DEFAULT 'POS',   -- 'POS' | 'SAMER_DELLY'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 12. INVENTAIRE DE SERVICE (DESIGN_V2 §6.9) — LOCAL UNIQUEMENT
-- ============================================================================
-- Ces tables ne figurent ni dans la descente de synchro (le siège ne les
-- écrase jamais) ni dans sync_outbox : le cloud n'a pas encore les tables
-- correspondantes, et publier vers une table absente ferait échouer toute la
-- remontée du site.
--
-- ⚠ Les QUANTITÉS sont numériques et non entières : le fromage se compte en
-- grammes, la glace en pots (4,5) et les frites en sachets. Seuls les MONTANTS
-- restent des entiers FCFA (règle du projet).

-- Catalogue de comptage — celui de SamerTrackly, identique sur les 7 sites.
-- Distinct du catalogue de VENTE (articles) : les lignes de consommation
-- (« Manaïche (100g) ») et les totaux dérivés (« Total Fromage ») ne sont pas
-- vendables. Le pont vers les ventes est la table inventaire_consommations
-- (migration 0022) : les sorties automatiques en viennent.
CREATE TABLE produits_inventaire (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL UNIQUE,
  categorie   TEXT NOT NULL CHECK (categorie IN
              ('PAIN','POUL','APER','PLAT','FROM','BOIS','GLAC','FRIT')),
  nom         TEXT NOT NULL,
  prix        INTEGER NOT NULL DEFAULT 0 CHECK (prix >= 0),  -- chiffre le manquant
  unite       TEXT NOT NULL DEFAULT 'u',
  role        TEXT NOT NULL DEFAULT 'COMPTE' CHECK (role IN
              ('COMPTE','ENTREE','AUTO_ENT',
               'CONSO','CONSO_POULET','CONSO_FROMAGE','CONSO_GLACE','CONSO_FRITES',
               'TOTAL_POULET','TOTAL_FROMAGE','TOTAL_GLACE','TOTAL_FRITES','DARINA')),
  -- Sens du ratio selon le rôle : grammes de fromage, boules de glace,
  -- portions par sachet de frites. NULL pour les lignes simples.
  ratio       NUMERIC(12,3),
  ordre       SMALLINT NOT NULL DEFAULT 0,
  actif       BOOLEAN NOT NULL DEFAULT TRUE
);

-- RECETTES (migration 0022) : ce qu'un article de vente consomme.
-- Le lien est un-à-plusieurs DANS LES DEUX SENS — « Pain chawarma » sort avec
-- les 6 Chawarmas ; un « Poulet Pané + Frites » consomme poulet, frites ET pain.
-- quantite = unités du produit par article vendu ; elle se COMPOSE avec ratio
-- (conversion SamerTrackly : grammes, boules, portions par sachet).
CREATE TABLE inventaire_consommations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produit_id  UUID NOT NULL REFERENCES produits_inventaire(id) ON DELETE CASCADE,
  article_id  UUID NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  quantite    NUMERIC(12,3) NOT NULL DEFAULT 1 CHECK (quantite > 0),
  UNIQUE (produit_id, article_id)
);
CREATE INDEX idx_inventaire_consommations_article ON inventaire_consommations (article_id);

-- Un inventaire par service. valide verrouille tout en lecture seule.
CREATE TABLE inventaires_service (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id       UUID NOT NULL UNIQUE REFERENCES services_caisse(id) ON DELETE CASCADE,
  valide           BOOLEAN NOT NULL DEFAULT FALSE,
  valide_le        TIMESTAMPTZ,
  valide_par       UUID REFERENCES utilisateurs(id),
  -- Issue de secours : sans elle, un caissier bloqué à 2 h du matin ne peut
  -- plus fermer sa caisse. Le déblocage est tracé (audit DEBLOCAGE_INVENTAIRE).
  debloque_par     UUID REFERENCES utilisateurs(id),
  debloque_le      TIMESTAMPTZ,
  debloque_motif   TEXT,
  -- Manquant non expliqué, chiffré en FCFA. INFORMATION pour le manager :
  -- jamais déduit de la caisse (contrairement à SamerTrackly).
  montant_manquant INTEGER NOT NULL DEFAULT 0 CHECK (montant_manquant >= 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inventaires_service_deblocage_check CHECK (
    debloque_par IS NULL OR debloque_motif IS NOT NULL)
);

CREATE TABLE inventaire_lignes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inventaire_id      UUID NOT NULL REFERENCES inventaires_service(id) ON DELETE CASCADE,
  produit_id         UUID NOT NULL REFERENCES produits_inventaire(id) ON DELETE CASCADE,
  stock_initial      NUMERIC(12,2) NOT NULL DEFAULT 0,  -- repris du service précédent
  entrees            NUMERIC(12,2) NOT NULL DEFAULT 0,
  sorties            NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- La SEULE donnée que le caissier saisit. NULL = pas encore compté.
  stock_compte       NUMERIC(12,2),
  ecart              NUMERIC(12,2),
  quantite_expliquee NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (quantite_expliquee >= 0),
  explication        TEXT,
  UNIQUE (inventaire_id, produit_id)
);

CREATE TABLE entrees_stock (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inventaire_id UUID NOT NULL REFERENCES inventaires_service(id) ON DELETE CASCADE,
  produit_id    UUID NOT NULL REFERENCES produits_inventaire(id) ON DELETE CASCADE,
  quantite      NUMERIC(12,2) NOT NULL CHECK (quantite > 0),
  fournisseur   TEXT,
  saisi_par     UUID REFERENCES utilisateurs(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_entrees_stock_inventaire ON entrees_stock (inventaire_id);

-- ============================================================================
-- FIN — Tables sprint 1 : restaurant, parametres_locaux, utilisateurs,
-- categories, articles, prix_canaux, groupes_options, options, supplements,
-- combos, combo_articles, promotions, zones, tables_salle, services_caisse,
-- commandes, commande_items, notes_split, paiements, audit_log,
-- sync_outbox (structure seule), sync_etat.
-- Ajouts DESIGN_V2 (migration 0021) : depenses, produits_inventaire,
-- inventaires_service, inventaire_lignes, entrees_stock.
-- Migration 0022 : inventaire_consommations (recettes d'inventaire).
-- ============================================================================
