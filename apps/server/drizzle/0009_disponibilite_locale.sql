-- ============================================================================
-- SPRINT 4C — Disponibilité LOCALE des plats (2.3).
-- La disponibilité « épuisé » est posée sur place et ne doit JAMAIS être écrasée
-- par une descente de catalogue. On la sort de la table articles (que la descente
-- réécrit) vers une table dédiée, clé = article_id. La descente incrémentale
-- fait un UPSERT des articles (jamais un DELETE global) : les lignes de
-- disponibilite_locale existantes sont préservées, les manquantes créées à TRUE.
-- ============================================================================

CREATE TABLE disponibilite_locale (
  article_id  UUID PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  disponible  BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reprise de l'état actuel (articles.disponible) sans rien perdre.
INSERT INTO disponibilite_locale (article_id, disponible)
SELECT id, disponible FROM articles
ON CONFLICT (article_id) DO NOTHING;
