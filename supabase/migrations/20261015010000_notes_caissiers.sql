-- ============================================================================
-- Note des caissiers, affichée sur la caisse de chacun (2026-10-15).
--
-- Écrite par la fonction `publier-notes-pos` du projet SamerTrackly, qui la
-- calcule avec le même code que son écran « Note des caissiers » (sur 20,
-- 30 derniers jours). Descend vers chaque site par le flux NOTES de sync-pull.
--
-- Une ligne par COMPTE POS : clé (restaurant_id, id), id = id de l'utilisateur
-- sur la caisse. Même règle que les autres tables du cloud — la même image
-- disque part sur les 7 sites, un uuid peut donc exister dans deux restaurants.
-- ============================================================================

CREATE TABLE IF NOT EXISTS notes_caissiers (
  id              UUID NOT NULL,             -- utilisateur POS
  restaurant_id   UUID NOT NULL,
  note            NUMERIC(4,1),              -- NULL : pas encore assez de shifts
  note_precedente NUMERIC(4,1),              -- 30 jours d'avant : flèche de progression
  appreciation    TEXT,
  nb_shifts       INTEGER NOT NULL DEFAULT 0,
  min_shifts      INTEGER NOT NULL DEFAULT 8,
  criteres        JSONB NOT NULL DEFAULT '[]'::jsonb,
  bonus           JSONB,
  periode_debut   DATE,
  periode_fin     DATE,
  calcule_le      TIMESTAMPTZ NOT NULL DEFAULT now(),
  version         BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (restaurant_id, id)
);

DROP TRIGGER IF EXISTS trg_version_notes_caissiers ON notes_caissiers;
CREATE TRIGGER trg_version_notes_caissiers
  BEFORE INSERT OR UPDATE ON notes_caissiers
  FOR EACH ROW EXECUTE FUNCTION bump_version();

CREATE INDEX IF NOT EXISTS idx_notes_caissiers_descente ON notes_caissiers (restaurant_id, version);

-- RLS — verrouillage total, comme le reste du cloud : seules les fonctions
-- (clé de service) y lisent et y écrivent.
ALTER TABLE notes_caissiers ENABLE ROW LEVEL SECURITY;
