-- ============================================================================
-- RECETTES D'INVENTAIRE DANS LA DESCENTE (2026-08-17)
--
-- Le problème. `produits_inventaire` (catalogue de comptage) et
-- `inventaire_consommations` (ce qu'un plat consomme) sont aujourd'hui des
-- tables LOCALES : ni dans la montée, ni dans la descente, ni dans le cloud.
-- Elles arrivent sur les 7 sites uniquement parce que l'image du master est
-- copiée telle quelle — une seule fois, au déploiement.
--
-- Après ce déploiement, plus aucun canal. Le jour où le siège ajoute un plat
-- depuis la console, le plat descend sur les 7 sites mais sa recette reste au
-- siège : l'inventaire ignore que ce plat sort du pain, et l'écart devient faux
-- partout. Un plat et sa recette doivent voyager ENSEMBLE.
--
-- La correction : les deux tables rejoignent le flux CATALOGUE, exactement
-- comme `articles` ou `supplements`. Cloud maître, descente en moins de 5 min.
--
-- Décision du boss (2026-08-17) : `produits_inventaire.prix` est le MÊME dans
-- tous les restaurants — contrairement au prix de vente des plats, ajustable
-- par site. Ce prix ne sert qu'à chiffrer un manquant d'inventaire non
-- expliqué ; le siège le fixe, les sites l'appliquent.
--
-- Idempotent : réexécutable sans risque.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Catalogue de comptage
-- ----------------------------------------------------------------------------
-- Miroir de la table locale + `restaurant_id` et `version`, comme toute table
-- de descente. `code` n'est PAS unique ici : il l'est par restaurant, et deux
-- sites portent légitimement le même code (image clonée).
CREATE TABLE IF NOT EXISTS produits_inventaire (
  id            UUID NOT NULL,
  restaurant_id UUID NOT NULL,
  code          TEXT,
  categorie     TEXT,
  nom           TEXT,
  prix          INTEGER,
  unite         TEXT,
  role          TEXT,
  ratio         NUMERIC(12, 3),
  ordre         SMALLINT,
  actif         BOOLEAN,
  version       BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (restaurant_id, id)
);

-- ----------------------------------------------------------------------------
-- 2. Recettes : ce qu'un article de vente consomme
-- ----------------------------------------------------------------------------
-- Un-à-plusieurs dans les deux sens : « Pain chawarma » sort avec les
-- 6 chawarmas, un « Poulet Pané + Frites » consomme poulet, frites ET pain.
-- `quantite` se compose avec le `ratio` du produit, elle ne le remplace pas.
CREATE TABLE IF NOT EXISTS inventaire_consommations (
  id            UUID NOT NULL,
  restaurant_id UUID NOT NULL,
  produit_id    UUID,
  article_id    UUID,
  quantite      NUMERIC(12, 3),
  version       BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (restaurant_id, id)
);

-- Le couple (produit, article) est unique côté local : on le reproduit ici,
-- sinon deux écritures du siège créeraient deux recettes pour le même plat et
-- l'inventaire compterait la sortie en double.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conso_produit_article
  ON inventaire_consommations (restaurant_id, produit_id, article_id);

-- ----------------------------------------------------------------------------
-- 3. Versions, index de descente et RLS
-- ----------------------------------------------------------------------------
-- `bump_version()` et `cloud_version_seq` existent depuis le schéma initial :
-- on réutilise, on ne redéfinit pas. La version est une séquence GLOBALE, donc
-- l'index (restaurant_id, version) est ce qui rend la descente incrémentale.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['produits_inventaire', 'inventaire_consommations']
  LOOP
    CONTINUE WHEN to_regclass(t) IS NULL;
    EXECUTE format('DROP TRIGGER IF EXISTS trg_version ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_version BEFORE INSERT OR UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION bump_version()', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_ver ON %I (restaurant_id, version)', t, t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ============================================================================
-- APRÈS CETTE MIGRATION — l'ordre compte
--
-- 1. Redéployer `sync-pull` et `admin-catalogue` (elles connaissent désormais
--    les deux tables via `_shared/tables.ts`).
-- 2. Déployer le POS : `descente.ts` doit savoir écrire ces deux tables, sinon
--    il les ignore silencieusement (`CONFLIT[table]` absent → `return`).
--
-- Sans risque de perte si l'ordre n'est pas respecté : la descente ignore une
-- table qu'elle ne connaît pas, elle ne gèle rien. C'est la MONTÉE qui gelait
-- sur une table inconnue, et ce défaut est corrigé depuis le 2026-08-16.
--
-- PREMIER REMPLISSAGE : le cloud est vide. Tant que les 111 recettes et
-- 52 produits du master n'y sont pas montés, la descente n'a rien à envoyer —
-- les sites gardent ce que l'image leur a donné, donc rien ne casse. Le
-- versement initial se fera depuis la console siège (écran Catalogue).
-- ============================================================================
