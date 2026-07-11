-- ============================================================================
-- Sessions serveur PERSISTÉES : survivent à un redémarrage du serveur/mini-PC.
-- Le magasin de sessions les recharge au démarrage (plus de déconnexion
-- générale quand le PC redémarre). Le cookie httpOnly reste l'id de session.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  utilisateur_id   UUID NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
  nom_complet      TEXT NOT NULL,
  role_id          UUID,
  role_nom         TEXT NOT NULL,
  est_proprietaire BOOLEAN NOT NULL DEFAULT FALSE,
  est_superviseur  BOOLEAN NOT NULL DEFAULT FALSE,
  expire_a         TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions (expire_a);
