-- Explication saisie après révélation de l'écart, lors de la validation du point.
ALTER TABLE "services_caisse"
  ADD COLUMN IF NOT EXISTS "explication_ecart" text;
