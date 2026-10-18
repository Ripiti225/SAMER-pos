-- Garde le temps déjà travaillé lorsqu'un membre marqué « Reste » enchaîne
-- plusieurs shifts. Zéro pour les présences existantes : aucun report ancien
-- n'est déduit sans preuve de continuité.
ALTER TABLE "equipe_service"
  ADD COLUMN IF NOT EXISTS "secondes_reportees" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "equipe_service"
  ADD CONSTRAINT "equipe_service_secondes_reportees_check"
  CHECK ("secondes_reportees" >= 0);
