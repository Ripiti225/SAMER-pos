-- Corrections du stock initial, reçues des caisses par sync-push (POS 0050).
-- À passer AVANT de déployer sync-push et les caisses : une table inconnue finit
-- dans sync_rejets au lieu d'arriver à destination.
CREATE TABLE IF NOT EXISTS corrections_stock_initial (
  id                            UUID NOT NULL,
  restaurant_id                 UUID NOT NULL,
  inventaire_id                 UUID,
  produit_id                    UUID,
  produit_code                  TEXT,
  produit_nom                   TEXT,
  produit_prix                  INTEGER,
  stock_reporte                 NUMERIC(12,2),
  stock_avant                   NUMERIC(12,2),
  stock_apres                   NUMERIC(12,2),
  explication                   TEXT,
  saisi_par                     UUID,
  service_sortant_id            UUID,
  caissier_sortant_id           UUID,
  shift_intermediaire_debloque  BOOLEAN,
  ecart_sortant_avant           NUMERIC(12,2),
  ecart_sortant_apres           NUMERIC(12,2),
  statut                        TEXT,
  valide_par                    UUID,
  valide_le                     TIMESTAMPTZ,
  created_at                    TIMESTAMPTZ,
  PRIMARY KEY (restaurant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_cloud_corrections_stock
  ON corrections_stock_initial (restaurant_id, inventaire_id);

-- Seules les Edge Functions (service_role) y accèdent.
ALTER TABLE corrections_stock_initial ENABLE ROW LEVEL SECURITY;
ALTER TABLE corrections_stock_initial FORCE ROW LEVEL SECURITY;
