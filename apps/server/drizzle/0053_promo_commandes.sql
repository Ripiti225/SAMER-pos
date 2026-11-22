-- Code promo carte sur une commande (PROMO-09). Mêmes noms que les colonnes
-- déjà créées dans le cloud (supabase/migrations/20261119000000) : la montée
-- les envoie telles quelles (COLONNES_VENTES).
--
-- Le code carte est une réduction À PART du happy hour (`promo_id`,
-- `promo_montant`) : le cumul est autorisé, en cascade, et le siège doit
-- pouvoir les compter séparément.
ALTER TABLE "commandes" ADD COLUMN IF NOT EXISTS "code_promo_id" uuid;--> statement-breakpoint
ALTER TABLE "commandes" ADD COLUMN IF NOT EXISTS "code_promo_code" text;--> statement-breakpoint
ALTER TABLE "commandes" ADD COLUMN IF NOT EXISTS "code_promo_montant" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "commandes" ADD COLUMN IF NOT EXISTS "code_promo_canal" text;--> statement-breakpoint
ALTER TABLE "commandes" DROP CONSTRAINT IF EXISTS "commandes_code_promo_check";--> statement-breakpoint
ALTER TABLE "commandes" ADD CONSTRAINT "commandes_code_promo_check" CHECK (
  "code_promo_montant" >= 0
  AND ("code_promo_canal" IS NULL OR "code_promo_canal" IN ('SUR_PLACE','TELEPHONE','SITE'))
  AND (("code_promo_id" IS NULL) = ("code_promo_code" IS NULL))
  AND ("code_promo_id" IS NOT NULL OR "code_promo_montant" = 0)
);--> statement-breakpoint
ALTER TABLE "notes_split" ADD COLUMN IF NOT EXISTS "code_promo_montant" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "notes_split" DROP CONSTRAINT IF EXISTS "notes_split_code_promo_check";--> statement-breakpoint
ALTER TABLE "notes_split" ADD CONSTRAINT "notes_split_code_promo_check" CHECK ("code_promo_montant" >= 0);
