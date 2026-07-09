-- ============================================================================
-- SPRINT 4C — Salle (2.2) : une table peut être désactivée (départ d'une zone,
-- table retirée). Jamais de suppression : l'historique des commandes la référence.
-- ============================================================================

ALTER TABLE tables_salle ADD COLUMN actif BOOLEAN NOT NULL DEFAULT TRUE;

-- Base d'URL pour les QR clients (page téléphone /t/:qr_token). Vide = chemin seul.
INSERT INTO parametres_locaux (cle, valeur)
VALUES ('url_base_client', '""'::jsonb)
ON CONFLICT (cle) DO NOTHING;
