-- ============================================================================
-- 2026-08-16 — Ce que le caissier saisit doit arriver dans SamerTrackly, sans
-- ressaisie. Deux choses dans cette migration, et la première est un CORRECTIF.
--
-- 1. LES TABLES MANQUANTES (bloquant).
--    `sync-push` acquitte de façon CONTIGUË : une table absente de
--    `COLONNES_VENTES` renvoie `null`, la boucle `break`, et le seq n'est jamais
--    acquitté. La file locale étant strictement ordonnée, TOUT CE QUI SUIT est
--    bloqué à jamais pour ce site. Or le POS publie déjà huit tables que le
--    cloud n'a pas — dont `equipe_service`, écrite à CHAQUE ouverture de
--    service. Le premier site enrôlé aurait gelé sa synchro dès son premier
--    shift, ventes comprises. Jamais vu jusqu'ici : aucun site n'est enrôlé.
--    Trois autres (`clients_fidelite`, `points_fidelite`, `pointages`) étaient
--    autorisées côté fonction mais n'avaient aucune table : même gel.
--
-- 2. LES SAISIES DU CAISSIER (demande du 2026-08-16) : dépenses et inventaire
--    LIGNE À LIGNE. Le rapport Z figé (`services_caisse.rapport_z`) remonte
--    déjà et porte le résumé (écart, modes, dépenses, livraisons, Kdo,
--    inventaire, équipe, retours) ; ces tables apportent le détail — quelle
--    dépense, quel produit, combien manquait.
--
-- Conventions reprises telles quelles : `restaurant_id` obligatoire, PK
-- COMPOSITE (restaurant_id, id) — deux sites portent les mêmes UUID puisque
-- l'image de déploiement est clonée — et RLS forcée (seules les Edge Functions,
-- en service_role, accèdent aux données).
--
-- Idempotent : rejouable sans effet.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tables publiées par le POS et absentes du cloud
-- ----------------------------------------------------------------------------

-- Équipe du jour (remplace la remontée des pointages) : qui était là, arrivé à
-- quelle heure, resté ou parti à la clôture.
CREATE TABLE IF NOT EXISTS equipe_service (
  id             UUID NOT NULL,
  restaurant_id  UUID NOT NULL,
  service_id     UUID,
  utilisateur_id UUID,
  poste_jour     TEXT,
  pointe_le      TIMESTAMPTZ,  -- heure du CLIC, jamais saisie à la main
  reste          BOOLEAN,      -- NULL/false à la clôture = enregistré parti
  created_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cloud_equipe_service ON equipe_service (restaurant_id, service_id);

-- Séquence de caisse (journée) : le rasage du gérant, tous shifts confondus.
-- Les totaux sont dans `rapport` (JSONB figé), pas en colonnes.
CREATE TABLE IF NOT EXISTS sequences_caisse (
  id            UUID NOT NULL,
  restaurant_id UUID NOT NULL,
  ouverte_le    TIMESTAMPTZ,
  cloturee_le   TIMESTAMPTZ,
  cloturee_par  UUID,
  statut        TEXT,
  rapport       JSONB
);
CREATE INDEX IF NOT EXISTS idx_cloud_sequences ON sequences_caisse (restaurant_id, ouverte_le);

-- Rôles et permissions : l'administration des accès, éditée sur site.
CREATE TABLE IF NOT EXISTS roles (
  id            UUID NOT NULL,
  restaurant_id UUID NOT NULL,
  nom           TEXT,
  systeme       BOOLEAN,   -- rôle verrouillé, non supprimable
  actif         BOOLEAN,
  created_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ
);

-- Permissions d'un rôle. Le POS publie la LISTE ENTIÈRE à chaque modification,
-- avec le rôle pour identifiant (`record_id = role_id`) : une seule ligne par
-- rôle, remplacée à chaque fois. Pas une ligne par permission — sinon une
-- permission retirée resterait au cloud, faute de suppression dans l'outbox.
CREATE TABLE IF NOT EXISTS role_permissions (
  id            UUID NOT NULL,   -- = role_id
  restaurant_id UUID NOT NULL,
  role_id       UUID,
  permissions   JSONB            -- tableau de clés de permission
);
CREATE INDEX IF NOT EXISTS idx_cloud_role_perms ON role_permissions (restaurant_id, role_id);

-- Plats du jour : ce que le site a rendu indisponible localement.
-- `id` = article_id (la table locale n'a pas d'autre clé).
CREATE TABLE IF NOT EXISTS disponibilite_locale (
  id            UUID NOT NULL,
  restaurant_id UUID NOT NULL,
  article_id    UUID,
  disponible    BOOLEAN
);

-- Options réutilisables (migration locale 0020).
CREATE TABLE IF NOT EXISTS options_catalogue (
  id            UUID NOT NULL,
  restaurant_id UUID NOT NULL,
  nom           TEXT,
  prix          INTEGER,     -- 0 = option gratuite
  actif         BOOLEAN,
  ordre         SMALLINT,
  updated_at    TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS options_liaisons (
  id            UUID NOT NULL,
  restaurant_id UUID NOT NULL,
  option_id     UUID,
  categorie_id  UUID,
  article_id    UUID
);
CREATE INDEX IF NOT EXISTS idx_cloud_options_liaisons ON options_liaisons (restaurant_id, option_id);

-- Fidélité : autorisée côté fonction depuis le sprint 4, mais la table
-- n'existait pas — l'upsert échouait et gelait la file, comme une table
-- inconnue. C'est le même défaut, vu de l'autre bout.
CREATE TABLE IF NOT EXISTS clients_fidelite (
  id            UUID NOT NULL,
  restaurant_id UUID NOT NULL,
  telephone     TEXT,
  nom           TEXT,
  created_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cloud_fidelite_tel ON clients_fidelite (restaurant_id, telephone);

CREATE TABLE IF NOT EXISTS points_fidelite (
  id            UUID NOT NULL,
  restaurant_id UUID NOT NULL,
  client_id     UUID,
  commande_id   UUID,
  points        INTEGER,
  source        TEXT,
  created_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cloud_points_fidelite ON points_fidelite (restaurant_id, client_id);

-- ----------------------------------------------------------------------------
-- 2. Ce que le caissier saisit : dépenses et inventaire, ligne à ligne
-- ----------------------------------------------------------------------------

-- Registre des sorties de caisse du service : achats, salaires, primes.
-- `agent_id` renseigné = ligne de paie. Une ligne de salaire n'est jamais
-- supprimable côté POS : elle vient d'argent réellement sorti du tiroir.
CREATE TABLE IF NOT EXISTS depenses (
  id            UUID NOT NULL,
  restaurant_id UUID NOT NULL,
  service_id    UUID,
  categorie     TEXT,
  libelle       TEXT,
  montant       INTEGER,
  agent_id      UUID,       -- qui a été payé (salaire, encouragement)
  saisi_par     UUID,
  auto          BOOLEAN,    -- née d'un paiement réel → indélébile côté POS
  motif         TEXT,       -- obligatoire si le montant s'écarte du taux
  created_at    TIMESTAMPTZ,
  -- L'outbox du POS n'a pas d'opération DELETE : une ligne effacée sur le site
  -- est republiée avec ce marqueur. À EXCLURE DES TOTAUX SamerTrackly, sinon
  -- une dépense supprimée gonflerait les charges du restaurant pour toujours.
  supprime      BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_cloud_depenses ON depenses (restaurant_id, service_id);
CREATE INDEX IF NOT EXISTS idx_cloud_depenses_agent ON depenses (restaurant_id, agent_id);

-- Un inventaire par service. `montant_manquant` est une INFORMATION : le POS
-- ne retient rien sur la caisse, contrairement à SamerTrackly qui déduit.
CREATE TABLE IF NOT EXISTS inventaires_service (
  id               UUID NOT NULL,
  restaurant_id    UUID NOT NULL,
  service_id       UUID,
  valide           BOOLEAN,
  valide_le        TIMESTAMPTZ,
  valide_par       UUID,
  debloque_par     UUID,          -- issue de secours manager (PIN + motif)
  debloque_le      TIMESTAMPTZ,
  debloque_motif   TEXT,
  montant_manquant INTEGER,
  created_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cloud_inventaires ON inventaires_service (restaurant_id, service_id);

-- Le comptage produit par produit. `produit_id` référence le catalogue de
-- comptage LOCAL (les 52 produits SamerTrackly, identiques sur les 7 sites) :
-- il n'est pas remonté, le siège le connaît déjà. Les quantités sont
-- NUMÉRIQUES, pas entières — le fromage se compte en grammes et la glace en
-- pots de 4,5. Seuls les MONTANTS restent des entiers FCFA.
CREATE TABLE IF NOT EXISTS inventaire_lignes (
  id                 UUID NOT NULL,
  restaurant_id      UUID NOT NULL,
  inventaire_id      UUID,
  produit_id         UUID,
  stock_initial      NUMERIC(12,2),   -- repris du service précédent
  entrees            NUMERIC(12,2),
  sorties            NUMERIC(12,2),   -- déduites des ventes (recettes)
  stock_compte       NUMERIC(12,2),   -- la SEULE saisie du caissier
  ecart              NUMERIC(12,2),
  quantite_expliquee NUMERIC(12,2),
  explication        TEXT
);
CREATE INDEX IF NOT EXISTS idx_cloud_inv_lignes ON inventaire_lignes (restaurant_id, inventaire_id);

-- Réceptions de marchandise pendant le service (onglet « Entrées reçues »).
CREATE TABLE IF NOT EXISTS entrees_stock (
  id            UUID NOT NULL,
  restaurant_id UUID NOT NULL,
  inventaire_id UUID,
  produit_id    UUID,
  quantite      NUMERIC(12,2),
  fournisseur   TEXT,
  saisi_par     UUID,
  created_at    TIMESTAMPTZ,
  -- Même règle que `depenses.supprime` : à exclure des totaux, sinon une
  -- réception saisie par erreur gonfle le stock du site au siège.
  supprime      BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_cloud_entrees_stock ON entrees_stock (restaurant_id, inventaire_id);

-- ----------------------------------------------------------------------------
-- 2 bis. Fiche employé : SamerTrackly est MAÎTRE (décision du 2026-08-16)
-- ----------------------------------------------------------------------------
-- Le siège décide l'embauche, le rôle, le taux et le départ ; la caisse reçoit
-- l'équipe par le bouton « Synchroniser (SamerTrackly) ». Sans séparation, les
-- deux écrivaient la MÊME ligne `utilisateurs` et le dernier écrasait l'autre
-- en silence — un téléphone corrigé sur site revenait à l'ancien cinq minutes
-- plus tard, sans que personne ne le voie.
--
-- Ce que le site modifie atterrit donc ICI (redirection dans `sync-push`), et
-- jamais dans `utilisateurs`. Le siège y lit ce que le restaurant a changé, et
-- surtout les employés CRÉÉS SUR PLACE (`externe_id` NULL) qui, autrement,
-- n'existeraient nulle part chez lui.
CREATE TABLE IF NOT EXISTS utilisateurs_site (
  id             UUID NOT NULL,
  restaurant_id  UUID NOT NULL,
  nom_complet    TEXT,
  role           TEXT,
  role_id        UUID,
  poste_cuisine  TEXT,
  poste          TEXT,
  photo_url      TEXT,
  externe_id     TEXT,        -- NULL = employé créé sur le site, inconnu du siège
  telephone      TEXT,
  disponibilite  TEXT,
  taux_journalier INTEGER,
  actif          BOOLEAN,
  recu_le        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cloud_users_site ON utilisateurs_site (restaurant_id, externe_id);

-- ----------------------------------------------------------------------------
-- 3. Rebut de synchro : ne plus JAMAIS geler un site sur une table inconnue
-- ----------------------------------------------------------------------------
-- `sync-push` garera ici une ligne dont la table lui est inconnue, puis
-- l'acquittera et continuera. La donnée n'est pas perdue (elle est là, en
-- JSONB, rejouable), et les ventes du site continuent de remonter. C'est ce
-- qui manquait : jusqu'ici, un POS plus récent que le cloud gelait le site.
CREATE TABLE IF NOT EXISTS sync_rejets (
  id            BIGSERIAL PRIMARY KEY,
  restaurant_id UUID NOT NULL,
  seq           BIGINT,
  table_name    TEXT,
  record_id     UUID,
  operation     TEXT,
  payload       JSONB,
  raison        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cloud_rejets ON sync_rejets (restaurant_id, table_name, created_at);

-- ----------------------------------------------------------------------------
-- 4. PK composite + RLS sur toutes les tables neuves
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  t     TEXT;
  pk    TEXT;
  ncols INT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'equipe_service','sequences_caisse','roles','role_permissions',
    'disponibilite_locale','options_catalogue','options_liaisons',
    'clients_fidelite','points_fidelite',
    'depenses','inventaires_service','inventaire_lignes','entrees_stock',
    'utilisateurs_site'
  ]
  LOOP
    CONTINUE WHEN to_regclass(t) IS NULL;

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

-- RLS : tout est verrouillé, y compris le rebut. Seules les Edge Functions
-- (service_role) accèdent aux données ; aucune politique anonyme.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'equipe_service','sequences_caisse','roles','role_permissions',
    'disponibilite_locale','options_catalogue','options_liaisons',
    'clients_fidelite','points_fidelite',
    'depenses','inventaires_service','inventaire_lignes','entrees_stock',
    'utilisateurs_site','sync_rejets'
  ]
  LOOP
    CONTINUE WHEN to_regclass(t) IS NULL;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ============================================================================
-- FIN — appliquer via l'éditeur SQL Supabase (ou `supabase db push`), PUIS
-- redéployer `sync-push` (il connaît les nouvelles tables et le rebut).
-- La publication côté POS ne s'active qu'APRÈS : publier avant, c'est geler.
-- ============================================================================
