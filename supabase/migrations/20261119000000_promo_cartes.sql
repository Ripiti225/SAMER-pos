-- ============================================================================
-- PROMO-02 — Codes promo « cartes colis » : tables du cloud POS.
-- Brief : ~/BRIEF_CODES_PROMO_CARTES.md (décisions du 19/11/2026).
--
-- Le client reçoit un autocollant −20 % dans son sac de livraison. Le QR ouvre
-- une page d'activation où il rattache le code à son numéro ; à sa prochaine
-- commande, son numéro suffit. SEULE la caisse consomme un code.
--
-- Cette migration ne crée que des tables et des colonnes. Les fonctions
-- (activation, vérification, réservation, création de lot) viennent avec
-- PROMO-03, la libération des réservations avec PROMO-04.
--
-- RÈGLE DE SÉCURITÉ DE LA SYNCHRO — pourquoi aucune colonne n'est ajoutée à une
-- table qui DESCEND vers les caisses (`categories`, `articles`, `promotions`…) :
-- `sync-pull` lit ces tables en `select *` et la caisse les réécrit colonne par
-- colonne. Une colonne inconnue d'une caisse pas encore mise à jour ferait
-- échouer TOUTE sa descente, catalogue compris, sur les 8 sites. Une table
-- inconnue, elle, est ignorée sans dommage. L'exclusion « Chawarma » vit donc
-- dans sa propre table, `promo_categories_exclues`.
--
-- Montants en FCFA entiers. Fuseau Africa/Abidjan = UTC toute l'année.
-- Idempotente : rejouable sans effet.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Coordonnées des restaurants (imprimées sur les autocollants)
--    `restaurants` ne descend pas vers les caisses : colonnes sans risque.
-- ----------------------------------------------------------------------------
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS telephone     TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS adresse       TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS prefixe_promo TEXT;
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS slug_site     TEXT;

DO $$
BEGIN
  -- Préfixe : 3 lettres, sans I ni L (confondus avec 1 à la saisie).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'restaurants_prefixe_promo_format') THEN
    ALTER TABLE restaurants ADD CONSTRAINT restaurants_prefixe_promo_format
      CHECK (prefixe_promo IS NULL OR prefixe_promo ~ '^[A-HJKM-Z]{3}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'restaurants_telephone_format') THEN
    ALTER TABLE restaurants ADD CONSTRAINT restaurants_telephone_format
      CHECK (telephone IS NULL OR telephone ~ '^\+225[0-9]{10}$');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS restaurants_prefixe_promo_unique
  ON restaurants (prefixe_promo) WHERE prefixe_promo IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS restaurants_slug_site_unique
  ON restaurants (slug_site) WHERE slug_site IS NOT NULL;

-- Reprise depuis SAMER DELIV (site + base) et SamerTrackly, le 19/11/2026.
-- Al Kayan KMS / Yop : coordonnées données par la direction le même jour.
-- Ne touche qu'aux restaurants encore vides : une correction faite ensuite dans
-- la console du siège n'est jamais écrasée si la migration est rejouée.
UPDATE restaurants r SET
  telephone     = COALESCE(r.telephone, v.telephone),
  adresse       = COALESCE(r.adresse, v.adresse),
  prefixe_promo = COALESCE(r.prefixe_promo, v.prefixe),
  slug_site     = COALESCE(r.slug_site, v.slug)
FROM (VALUES
  ('SAMER_PALMERAIE', '+2250777303333', 'Riviera Palmeraie, après le rond-point de la SODECI', 'PAM', 'palmeraie'),
  ('SAMER_ANGRE_7E',  '+2250797480761', 'Angré 7e tranche, en face de la station Shell',       'ANG', 'angre-7e'),
  ('SAMER_LAVAGE',    '+2250799288709', 'Yopougon Saint André (Lavage)',                       'SAN', 'saint-andre'),
  ('SAMER_MAROC',     '+2250758648890', 'Yopougon Maroc',                                      'MAR', 'maroc'),
  ('SAMER_OASIS',     '+2250719016548', 'Yopougon Oasis',                                      'OAS', 'oasis'),
  ('ALA_BRAISE',      '+2250701111118', 'Yopougon Maroc, à 100 m de l''antenne Maroc',         'BRA', NULL),
  ('AL_KAYAN_KMS',    '+2250749111118', 'Juste au rond-point Kahira',                          'AKK', NULL),
  ('AL_KAYAN_YOP',    '+2250151111191', 'À 100 m de l''antenne Maroc, en allant vers Canaris', 'AKY', NULL)
) AS v(code, telephone, adresse, prefixe, slug)
WHERE r.code = v.code;

-- ----------------------------------------------------------------------------
-- 2. Lots : N codes pour UN restaurant, une remise, une période
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS promo_lots (
  restaurant_id UUID        NOT NULL REFERENCES restaurants (restaurant_id),
  id            UUID        NOT NULL DEFAULT gen_random_uuid(),
  libelle       TEXT        NOT NULL CHECK (length(trim(libelle)) > 0),
  pourcentage   INTEGER     NOT NULL DEFAULT 20 CHECK (pourcentage BETWEEN 1 AND 100),
  valide_du     TIMESTAMPTZ NOT NULL,
  valide_au     TIMESTAMPTZ NOT NULL,
  quantite      INTEGER     NOT NULL CHECK (quantite BETWEEN 1 AND 2000),
  annule_le     TIMESTAMPTZ,
  cree_par      TEXT,                  -- identité de la session siège
  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
  version       BIGINT      NOT NULL DEFAULT 0,
  PRIMARY KEY (restaurant_id, id),
  CHECK (valide_au > valide_du)
);

-- ----------------------------------------------------------------------------
-- 3. Codes : un par autocollant
--
-- Cycle : DISPONIBLE → RESERVE → UTILISE ; ANNULE quand le lot est annulé.
-- L'activation (rattachement d'un numéro) NE change PAS le statut.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS promo_codes (
  restaurant_id        UUID        NOT NULL,
  id                   UUID        NOT NULL DEFAULT gen_random_uuid(),
  lot_id               UUID        NOT NULL,
  code                 TEXT        NOT NULL UNIQUE
                       CHECK (code ~ '^[A-HJKM-Z]{3}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$'),
  statut               TEXT        NOT NULL DEFAULT 'DISPONIBLE'
                       CHECK (statut IN ('DISPONIBLE', 'RESERVE', 'UTILISE', 'ANNULE')),
  -- Activation par le client (page du site)
  telephone            TEXT        CHECK (telephone IS NULL OR telephone ~ '^\+225[0-9]{10}$'),
  active_le            TIMESTAMPTZ,
  consentement_relance BOOLEAN     NOT NULL DEFAULT false,
  -- Réservation (commande du site en attente, ou caisse qui a vérifié le code)
  reserve_le           TIMESTAMPTZ,
  reserve_source       TEXT        CHECK (reserve_source IN ('SITE', 'POS')),
  reserve_ref          TEXT,
  -- Consommation (caisse uniquement)
  utilise_le           TIMESTAMPTZ,
  utilise_commande_id  UUID,
  utilise_canal        TEXT        CHECK (utilise_canal IN ('SUR_PLACE', 'TELEPHONE', 'SITE')),
  version              BIGINT      NOT NULL DEFAULT 0,
  PRIMARY KEY (restaurant_id, id),
  FOREIGN KEY (restaurant_id, lot_id) REFERENCES promo_lots (restaurant_id, id),
  -- Un numéro sans date d'activation (ou l'inverse) n'a pas de sens.
  CHECK ((telephone IS NULL) = (active_le IS NULL)),
  -- Pas d'activation sans consentement (R13).
  CHECK (telephone IS NULL OR consentement_relance),
  CHECK (statut <> 'RESERVE' OR (reserve_le IS NOT NULL AND reserve_source IS NOT NULL)),
  CHECK (statut <> 'UTILISE' OR (utilise_le IS NOT NULL AND utilise_commande_id IS NOT NULL
                                 AND utilise_canal IS NOT NULL))
);

-- Recherche par numéro (R12) : codes encore utilisables d'un client, par restaurant.
CREATE INDEX IF NOT EXISTS promo_codes_telephone
  ON promo_codes (restaurant_id, telephone) WHERE telephone IS NOT NULL AND statut IN ('DISPONIBLE', 'RESERVE');
-- Libération des réservations expirées (PROMO-04).
CREATE INDEX IF NOT EXISTS promo_codes_reserves
  ON promo_codes (reserve_le) WHERE statut = 'RESERVE';
CREATE INDEX IF NOT EXISTS promo_codes_lot ON promo_codes (restaurant_id, lot_id);

-- ----------------------------------------------------------------------------
-- 4. Exclusion des remises par catégorie (Chawarma)
--    Table à part, et non une colonne de `categories` : voir l'en-tête.
--    Une ligne = cette catégorie de ce restaurant n'est jamais remisée.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS promo_categories_exclues (
  restaurant_id UUID        NOT NULL,
  id            UUID        NOT NULL,      -- = categories.id
  exclue        BOOLEAN     NOT NULL DEFAULT true,  -- false = exclusion levée (la ligne descend quand même)
  modifie_par   TEXT,
  modifie_le    TIMESTAMPTZ NOT NULL DEFAULT now(),
  version       BIGINT      NOT NULL DEFAULT 0,
  PRIMARY KEY (restaurant_id, id),
  FOREIGN KEY (restaurant_id, id) REFERENCES categories (restaurant_id, id)
);

-- ----------------------------------------------------------------------------
-- 5. Événements remontés par les caisses (via l'outbox → sync-push)
--    Le cloud en déduit le statut du code (premier encaissement gagnant).
--    PK (restaurant_id, id) : sync-push fait un upsert sur ce couple.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS promo_utilisations (
  restaurant_id UUID        NOT NULL,
  id            UUID        NOT NULL,
  code_id       UUID        NOT NULL,
  commande_id   UUID        NOT NULL,
  evenement     TEXT        NOT NULL CHECK (evenement IN ('RESERVE', 'UTILISE', 'LIBERE')),
  canal         TEXT        CHECK (canal IN ('SUR_PLACE', 'TELEPHONE', 'SITE')),
  montant       INTEGER     NOT NULL DEFAULT 0 CHECK (montant >= 0),
  created_at    TIMESTAMPTZ NOT NULL,      -- heure de la caisse
  recu_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (restaurant_id, id)
);
CREATE INDEX IF NOT EXISTS promo_utilisations_code ON promo_utilisations (restaurant_id, code_id, created_at);

-- ----------------------------------------------------------------------------
-- 6. Conflits : même code encaissé par deux caisses pendant une coupure.
--    La seconde commande reste valide ; le siège voit l'anomalie.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS promo_conflits (
  restaurant_id UUID        NOT NULL,
  id            UUID        NOT NULL DEFAULT gen_random_uuid(),
  code_id       UUID        NOT NULL,
  commande_id_a UUID        NOT NULL,      -- premier encaissement (gardé)
  commande_id_b UUID        NOT NULL,      -- second encaissement
  detecte_le    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolu        BOOLEAN     NOT NULL DEFAULT false,
  PRIMARY KEY (restaurant_id, id),
  UNIQUE (code_id, commande_id_b)
);

-- ----------------------------------------------------------------------------
-- 7. Limite d'essais du site (10 / IP / heure, puis blocage 1 h)
--    On garde une empreinte de l'IP, jamais l'IP elle-même.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS promo_essais (
  id         BIGSERIAL   PRIMARY KEY,
  ip_empreinte TEXT      NOT NULL,
  reussi     BOOLEAN     NOT NULL,
  essai_le   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS promo_essais_ip ON promo_essais (ip_empreinte, essai_le DESC);

-- ----------------------------------------------------------------------------
-- 8. Commandes et notes : la remise du code carte, à côté du happy hour
--    Tables de MONTÉE : une colonne en plus côté cloud est sans risque, une
--    caisse qui ne l'envoie pas encore laisse simplement la valeur par défaut.
-- ----------------------------------------------------------------------------
ALTER TABLE commandes   ADD COLUMN IF NOT EXISTS code_promo_id      UUID;
ALTER TABLE commandes   ADD COLUMN IF NOT EXISTS code_promo_code    TEXT;
ALTER TABLE commandes   ADD COLUMN IF NOT EXISTS code_promo_montant INTEGER NOT NULL DEFAULT 0;
ALTER TABLE commandes   ADD COLUMN IF NOT EXISTS code_promo_canal   TEXT;
ALTER TABLE notes_split ADD COLUMN IF NOT EXISTS code_promo_montant INTEGER NOT NULL DEFAULT 0;

-- ----------------------------------------------------------------------------
-- 9. Version (descente vers les caisses) + verrouillage
-- ----------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  -- Tables qui descendent (PROMO-08) : version monotone à chaque écriture.
  FOREACH t IN ARRAY ARRAY['promo_lots', 'promo_codes', 'promo_categories_exclues']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_version ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_version BEFORE INSERT OR UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION bump_version()', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_ver ON %I (restaurant_id, version)', t, t);
  END LOOP;

  -- Tout est verrouillé : aucune politique, donc aucune lecture publique.
  -- Seules les fonctions (service_role) y accèdent — le site comme la console.
  FOREACH t IN ARRAY ARRAY['promo_lots', 'promo_codes', 'promo_categories_exclues',
                           'promo_utilisations', 'promo_conflits', 'promo_essais']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
