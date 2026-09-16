CREATE TABLE visites_qr (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id UUID NOT NULL REFERENCES tables_salle(id) ON DELETE CASCADE,
  cree_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  expire_le TIMESTAMPTZ NOT NULL,
  derniere_activite_le TIMESTAMPTZ NOT NULL DEFAULT now(),
  distance_metres INTEGER,
  precision_metres INTEGER
);

CREATE INDEX idx_visites_qr_table_expire ON visites_qr (table_id, expire_le);

ALTER TABLE commandes
  ADD COLUMN visite_qr_id UUID REFERENCES visites_qr(id);

CREATE INDEX idx_commandes_visite_qr ON commandes (visite_qr_id);
