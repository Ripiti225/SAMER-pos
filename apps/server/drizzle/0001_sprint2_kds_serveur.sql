-- ============================================================================
-- SPRINT 2 — KDS + App Serveur tablette
-- ============================================================================

-- Idempotence des actions rejouées par la file locale des tablettes (§16 risque 7) :
-- chaque action porte un UUID généré sur la tablette ; le serveur ignore un
-- UUID déjà traité.
CREATE TABLE actions_recues (
  uuid       UUID PRIMARY KEY,
  traite_le  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Marqueur d'envoi en cuisine par article. Le cycle KDS utilise statut_cuisine
-- (A_PREPARER = en attente cuisine, EN_COURS = « Commencer », PRET) ;
-- envoye_le distingue un article encore dans l'addition (NULL) d'un article
-- déjà parti en cuisine (action protégée pour l'annuler).
ALTER TABLE commande_items ADD COLUMN envoye_le TIMESTAMPTZ;
