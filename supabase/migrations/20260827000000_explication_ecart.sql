-- Le cloud attend la validation finale du caissier avant d'envoyer le shift à
-- SamerTrackly, afin que l'explication accompagne toujours son écart.
ALTER TABLE public.services_caisse
  ADD COLUMN IF NOT EXISTS explication_ecart TEXT,
  ADD COLUMN IF NOT EXISTS remis_le TIMESTAMPTZ;
