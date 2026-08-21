-- ============================================================================
-- CONSOLE SIÈGE — vue de groupe sur les 7 restaurants (2026-08-17)
--
-- Objectif : un compte d'administration qui voit TOUS les restaurants d'un
-- coup, sans caisse, et qui diffuse catalogue et employés vers plusieurs sites
-- en une seule action. Il ne remplace ni la caisse, ni SamerTrackly.
--
-- Deux ajouts seulement, le reste existe déjà :
--   1. `restaurants` — le chaînon manquant entre les deux mondes. Le cloud POS
--      identifie un site par un UUID régénéré à la configuration du poste ;
--      SamerTrackly l'identifie par le sien. RIEN ne reliait les deux :
--      `parametres_locaux` (qui porte `samtrackly_restaurant_id`) est une table
--      de DESCENTE, elle ne remonte jamais, et `sites_autorises` ne garde qu'un
--      code texte. Sans cette table, la console ne peut pas dire que les ventes
--      du site X sont celles de « Samer Angré 7E ».
--   2. `siege_utilisateurs` — qui a le droit d'ouvrir la console. Le cloud ne
--      connaissait jusqu'ici que des clés de SITE (machines), jamais des
--      humains. On s'appuie sur Supabase Auth pour l'identité, et cette table
--      dit lesquels de ces comptes sont autorisés, et avec quel niveau.
--
-- Principe inchangé : RLS forcée partout, aucun accès anonyme. Seules les Edge
-- Functions (service_role) lisent et écrivent. La clé service_role ne quitte
-- jamais le cloud — la console n'embarque que la clé publique (anon).
--
-- Idempotent : réexécutable sans risque.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Annuaire des restaurants du groupe
-- ----------------------------------------------------------------------------
-- Une ligne par site enrôlé. `restaurant_id` = l'UUID du POS (celui qui porte
-- toutes les ventes) ; `samtrackly_id` = l'UUID du même restaurant côté RH.
-- La ligne est écrite à l'enrôlement du site (voir `enroler-site.ts`, qui
-- affiche désormais l'INSERT correspondant) et reste corrigeable ici.
CREATE TABLE IF NOT EXISTS restaurants (
  restaurant_id   UUID PRIMARY KEY,
  code            TEXT NOT NULL,
  nom             TEXT NOT NULL,
  marque          TEXT NOT NULL DEFAULT 'SAMER' CHECK (marque IN ('SAMER', 'AL_KAYAN')),
  couleur_hex     TEXT,
  -- Le pont vers SamerTrackly. NULL tant qu'on ne l'a pas relié : la console
  -- affiche alors le site sans pouvoir montrer son équipe.
  samtrackly_id   UUID,
  actif           BOOLEAN NOT NULL DEFAULT TRUE,
  enrole_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un restaurant SamerTrackly ne peut être relié qu'à UN site POS. Sans cette
-- contrainte, deux postes mal configurés se partageraient la même équipe et
-- leurs ventes se retrouveraient additionnées sous un seul restaurant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_samtrackly
  ON restaurants (samtrackly_id) WHERE samtrackly_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. Comptes autorisés sur la console siège
-- ----------------------------------------------------------------------------
-- `user_id` référence `auth.users` : l'authentification (mot de passe, reset,
-- verrouillage) est déléguée à Supabase Auth, on ne réinvente pas de PIN ici.
-- La console est un outil de bureau, pas une caisse tactile.
--
-- Niveaux :
--   ADMIN   — voit tout et écrit (catalogue, employés).
--   LECTURE — voit tout, n'écrit rien. Pour un comptable ou un associé.
CREATE TABLE IF NOT EXISTS siege_utilisateurs (
  user_id     UUID PRIMARY KEY,
  nom_complet TEXT NOT NULL,
  niveau      TEXT NOT NULL DEFAULT 'LECTURE' CHECK (niveau IN ('ADMIN', 'LECTURE')),
  actif       BOOLEAN NOT NULL DEFAULT TRUE,
  cree_le     TIMESTAMPTZ NOT NULL DEFAULT now(),
  vu_le       TIMESTAMPTZ
);

-- ----------------------------------------------------------------------------
-- 3. Journal des actions du siège
-- ----------------------------------------------------------------------------
-- La caisse a son `audit_log` par site ; il ne couvre pas ce qui est décidé au
-- siège. Diffuser un plat sur 7 restaurants ou créer un employé partout est une
-- action lourde : elle doit laisser une trace nominative, avec sa portée.
CREATE TABLE IF NOT EXISTS siege_audit (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID,
  nom_complet TEXT,
  action      TEXT NOT NULL,
  entite      TEXT,
  entite_id   TEXT,
  -- Les restaurants touchés par l'action (UUID POS). C'est ce qui distingue
  -- « prix changé sur 1 site » de « prix changé partout ».
  portee      UUID[] NOT NULL DEFAULT '{}',
  meta        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_siege_audit_date ON siege_audit (created_at DESC);

-- ----------------------------------------------------------------------------
-- 4. RLS — verrouillage total, comme le reste du cloud
-- ----------------------------------------------------------------------------
-- Aucune politique n'est créée : avec RLS activée ET forcée sans politique,
-- personne ne lit rien, pas même le propriétaire des tables. Seul le
-- service_role (qui contourne la RLS) accède aux données, depuis les Edge
-- Functions. C'est déjà le régime des 23 autres tables.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['restaurants', 'siege_utilisateurs', 'siege_audit']
  LOOP
    CONTINUE WHEN to_regclass(t) IS NULL;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 5. Agrégats de groupe
-- ----------------------------------------------------------------------------
-- La console compare 7 restaurants sur une période. Fait côté client, cela
-- voudrait dire rapatrier chaque commande de chaque site — plusieurs dizaines
-- de milliers de lignes pour afficher sept chiffres. On agrège donc en SQL.
--
-- SECURITY INVOKER (défaut) : ces fonctions n'ouvrent aucun accès nouveau.
-- Seul le service_role, qui contourne déjà la RLS, peut les exécuter utilement.
--
-- Le CA ne compte QUE les commandes payées. Les annulées sont comptées à part :
-- un site qui annule beaucoup est un signal, pas une ligne à cacher.
CREATE OR REPLACE FUNCTION siege_ventes(p_debut TIMESTAMPTZ, p_fin TIMESTAMPTZ)
RETURNS TABLE (
  restaurant_id UUID,
  nb_commandes  BIGINT,
  ca            BIGINT,
  nb_annulees   BIGINT,
  remises       BIGINT,
  panier_moyen  BIGINT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    c.restaurant_id,
    count(*) FILTER (WHERE c.statut = 'PAYEE'),
    COALESCE(sum(c.total) FILTER (WHERE c.statut = 'PAYEE'), 0)::BIGINT,
    count(*) FILTER (WHERE c.statut = 'ANNULEE'),
    COALESCE(sum(c.remise_montant) FILTER (WHERE c.statut = 'PAYEE'), 0)::BIGINT,
    COALESCE(
      sum(c.total) FILTER (WHERE c.statut = 'PAYEE')
        / NULLIF(count(*) FILTER (WHERE c.statut = 'PAYEE'), 0),
      0
    )::BIGINT
  FROM commandes c
  WHERE c.created_at >= p_debut AND c.created_at < p_fin
  GROUP BY c.restaurant_id;
$$;

-- Même découpage, jour par jour : alimente la courbe de tendance.
CREATE OR REPLACE FUNCTION siege_ventes_jour(p_debut TIMESTAMPTZ, p_fin TIMESTAMPTZ)
RETURNS TABLE (restaurant_id UUID, jour DATE, ca BIGINT, nb_commandes BIGINT)
LANGUAGE sql
STABLE
AS $$
  SELECT
    c.restaurant_id,
    (c.created_at AT TIME ZONE 'Africa/Abidjan')::DATE,
    COALESCE(sum(c.total), 0)::BIGINT,
    count(*)
  FROM commandes c
  WHERE c.created_at >= p_debut AND c.created_at < p_fin AND c.statut = 'PAYEE'
  GROUP BY 1, 2;
$$;

-- Clôtures et écarts de caisse. `rapport_z` est volontairement EXCLU ici : il
-- pèse lourd (tout le point de caisse en JSONB) et la liste n'en a pas besoin.
-- La console le charge à la demande, quand on ouvre une clôture précise.
CREATE OR REPLACE FUNCTION siege_clotures(p_debut TIMESTAMPTZ, p_fin TIMESTAMPTZ)
RETURNS TABLE (
  restaurant_id     UUID,
  service_id        UUID,
  caissier_id       UUID,
  ouvert_le         TIMESTAMPTZ,
  cloture_le        TIMESTAMPTZ,
  statut            TEXT,
  fond_de_caisse    INTEGER,
  especes_comptees  INTEGER,
  especes_theorique INTEGER,
  ecart             INTEGER
)
LANGUAGE sql
STABLE
AS $$
  SELECT s.restaurant_id, s.id, s.caissier_id, s.ouvert_le, s.cloture_le, s.statut,
         s.fond_de_caisse, s.especes_comptees, s.especes_theorique, s.ecart
  FROM services_caisse s
  WHERE s.ouvert_le >= p_debut AND s.ouvert_le < p_fin
  ORDER BY s.ouvert_le DESC;
$$;

-- ============================================================================
-- APRÈS CETTE MIGRATION
--
-- 1. Créer le compte de connexion dans le dashboard Supabase :
--      Authentication → Users → Add user → email + mot de passe.
-- 2. L'autoriser (remplacer l'email) :
--      INSERT INTO siege_utilisateurs (user_id, nom_complet, niveau)
--      SELECT id, 'SAMER Zreik', 'ADMIN' FROM auth.users WHERE email = 'a@b.c'
--      ON CONFLICT (user_id) DO UPDATE SET niveau = 'ADMIN', actif = TRUE;
-- 3. Déployer la fonction `siege`.
--
-- Les lignes de `restaurants` se remplissent à l'enrôlement de chaque site :
-- `enroler-site.ts` affiche l'INSERT à coller en même temps que celui de
-- `sites_autorises`. Aucun site n'étant encore enrôlé, la table reste vide
-- jusqu'au premier — c'est normal, et la console le dit explicitement.
-- ============================================================================
