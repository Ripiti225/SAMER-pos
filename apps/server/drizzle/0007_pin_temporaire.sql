-- ============================================================================
-- SPRINT 4C — Équipe (2.1) : le PIN est posé par l'EMPLOYÉ lui-même.
-- L'encadrant ne connaît jamais le PIN. À la création / réinitialisation, un
-- code temporaire à usage unique est émis ; l'employé choisit son PIN ensuite.
-- ============================================================================

ALTER TABLE utilisateurs
  ADD COLUMN doit_definir_pin       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN pin_temporaire_hash    TEXT,
  ADD COLUMN pin_temporaire_expire  TIMESTAMPTZ;
