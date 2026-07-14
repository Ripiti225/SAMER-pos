-- Accusé de fin de shift par le caissier : un shift clôturé mais non « remis »
-- (remis_le NULL) est un « point à valider » — le caissier y est renvoyé.
ALTER TABLE "services_caisse" ADD COLUMN "remis_le" timestamptz;
