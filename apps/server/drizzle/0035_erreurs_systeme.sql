-- Journal local de diagnostic visible dans Réglages > Santé du système.
-- Aucun corps de requête n'est conservé afin de ne pas enregistrer les PIN.
CREATE TABLE IF NOT EXISTS "erreurs_systeme" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "niveau" TEXT NOT NULL DEFAULT 'ERREUR',
  "origine" TEXT NOT NULL,
  "code" TEXT,
  "message_fr" TEXT NOT NULL,
  "detail_technique" TEXT,
  "contexte" JSONB NOT NULL DEFAULT '{}',
  "occurrences" INTEGER NOT NULL DEFAULT 1,
  "premiere_occurrence" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "derniere_occurrence" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "resolue_le" TIMESTAMPTZ,
  "resolue_par" UUID REFERENCES "utilisateurs"("id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_erreurs_systeme_derniere"
  ON "erreurs_systeme" ("derniere_occurrence" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_erreurs_systeme_non_resolues"
  ON "erreurs_systeme" ("resolue_le");
