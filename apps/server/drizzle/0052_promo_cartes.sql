-- Codes promo « cartes colis » — miroir LOCAL des codes du restaurant (PROMO-08).
-- Brief : ~/BRIEF_CODES_PROMO_CARTES.md § 5 ; cloud : supabase/migrations/20261119000000.
--
-- La caisse valide un code HORS LIGNE : elle reçoit les lots, les codes et les
-- catégories exclues de SON restaurant par la descente (flux PROMO_CODES).
--
-- Le statut d'un code ne doit JAMAIS reculer sur une caisse. Un code encaissé
-- ici pendant une coupure, pas encore remonté, ne doit pas repasser
-- « disponible » à la descente suivante. D'où deux jeux de colonnes :
--   * les colonnes du cloud (statut, telephone, reserve_*, utilise_*) que la
--     descente écrase à chaque fois, sans exception ;
--   * les colonnes `local_*`, que la descente ne connaît pas et ne touche donc
--     jamais : ce que CETTE caisse a fait du code (réservé pour une commande
--     ouverte, puis utilisé à l'encaissement).
-- Le statut qui compte en caisse combine les deux (modules/promo/statut.ts).
--
-- Pas de clé étrangère vers les lots ni vers les catégories : une ligne qui
-- arriverait avant son parent ferait échouer TOUTE la descente, catalogue compris.

CREATE TABLE IF NOT EXISTS "promo_lots" (
  "id" uuid PRIMARY KEY NOT NULL,
  "libelle" text NOT NULL,
  "pourcentage" integer NOT NULL,
  "valide_du" timestamp with time zone NOT NULL,
  "valide_au" timestamp with time zone NOT NULL,
  "quantite" integer NOT NULL,
  "annule_le" timestamp with time zone,
  "cree_par" text,
  "cree_le" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "promo_codes" (
  "id" uuid PRIMARY KEY NOT NULL,
  "lot_id" uuid NOT NULL,
  "code" text NOT NULL,
  -- Colonnes du cloud : la descente les écrase.
  "statut" text NOT NULL,
  "telephone" text,
  "active_le" timestamp with time zone,
  "consentement_relance" boolean NOT NULL DEFAULT false,
  "reserve_le" timestamp with time zone,
  "reserve_source" text,
  "reserve_ref" text,
  "utilise_le" timestamp with time zone,
  "utilise_commande_id" uuid,
  "utilise_canal" text,
  -- Colonnes de la caisse : la descente ne les touche jamais.
  "local_statut" text,
  "local_commande_id" uuid,
  "local_canal" text,
  "local_le" timestamp with time zone,
  CONSTRAINT "promo_codes_local_statut_check" CHECK ("local_statut" IS NULL OR "local_statut" IN ('RESERVE','UTILISE')),
  CONSTRAINT "promo_codes_local_canal_check" CHECK ("local_canal" IS NULL OR "local_canal" IN ('SUR_PLACE','TELEPHONE','SITE'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "promo_codes_code_key" ON "promo_codes" ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promo_codes_telephone_idx" ON "promo_codes" ("telephone") WHERE "telephone" IS NOT NULL;--> statement-breakpoint

-- `id` = categories.id ; `exclue = false` lève une exclusion posée avant.
CREATE TABLE IF NOT EXISTS "promo_categories_exclues" (
  "id" uuid PRIMARY KEY NOT NULL,
  "exclue" boolean NOT NULL DEFAULT true,
  "modifie_par" text,
  "modifie_le" timestamp with time zone NOT NULL DEFAULT now()
);
