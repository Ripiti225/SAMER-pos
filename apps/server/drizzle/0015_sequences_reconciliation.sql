-- Mode de paiement Djamo
ALTER TYPE "mode_paiement" ADD VALUE IF NOT EXISTS 'DJAMO';
--> statement-breakpoint
-- Séquence de caisse (journée) : regroupe les shifts jusqu'à la fermeture gérant.
CREATE TABLE "sequences_caisse" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ouverte_le" timestamptz DEFAULT now() NOT NULL,
  "cloturee_le" timestamptz,
  "cloturee_par" uuid REFERENCES "utilisateurs"("id"),
  "statut" text DEFAULT 'OUVERTE' NOT NULL,
  "rapport" jsonb,
  CONSTRAINT "sequences_caisse_statut_check" CHECK ("statut" IN ('OUVERTE','CLOTUREE'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "un_sequence_ouverte" ON "sequences_caisse" ("statut") WHERE "statut" = 'OUVERTE';
--> statement-breakpoint
-- Réconciliation de fermeture sur les shifts + rattachement à la séquence.
ALTER TABLE "services_caisse" ADD COLUMN "sequence_id" uuid REFERENCES "sequences_caisse"("id");
--> statement-breakpoint
ALTER TABLE "services_caisse" ADD COLUMN "depenses" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "services_caisse" ADD COLUMN "reconciliation" jsonb;
--> statement-breakpoint
ALTER TABLE "services_caisse" ADD COLUMN "vente_totale" integer;
--> statement-breakpoint
ALTER TABLE "services_caisse" ADD COLUMN "total_systeme" integer;
