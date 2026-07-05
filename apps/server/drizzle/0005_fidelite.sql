-- ============================================================================
-- SPRINT 4 B — Fidélité : rattachement client + remise fidélité sur la commande
-- ============================================================================

ALTER TABLE commandes ADD COLUMN client_fidelite_id UUID REFERENCES clients_fidelite(id);
ALTER TABLE commandes ADD COLUMN fidelite_points INTEGER NOT NULL DEFAULT 0;   -- points utilisés
ALTER TABLE commandes ADD COLUMN fidelite_montant INTEGER NOT NULL DEFAULT 0;  -- remise FCFA
