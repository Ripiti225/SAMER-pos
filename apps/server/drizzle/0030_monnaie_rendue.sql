-- Trace du billet reçu et de la monnaie rendue, sur le paiement lui-même.
--
-- Les deux colonnes restent NULL hors ESPECES et sur tout l'historique : la
-- monnaie rendue avant le 2026-08-28 n'a jamais été saisie, on ne l'invente
-- pas. Le CHECK est la garantie que `monnaie_rendue` ne peut pas mentir —
-- elle vaut exactement le rendu de monnaie du billet posé.
ALTER TABLE "paiements"
  ADD COLUMN IF NOT EXISTS "montant_recu"   integer,
  ADD COLUMN IF NOT EXISTS "monnaie_rendue" integer;

ALTER TABLE "paiements" DROP CONSTRAINT IF EXISTS "paiements_monnaie_check";
ALTER TABLE "paiements" ADD CONSTRAINT "paiements_monnaie_check" CHECK (
  ("montant_recu" IS NULL AND "monnaie_rendue" IS NULL)
  OR ("montant_recu" >= "montant" AND "monnaie_rendue" = "montant_recu" - "montant")
);

-- Le besoin en monnaie se lit toujours « sur une journée » : l'index porte
-- donc la date, pas le paiement.
CREATE INDEX IF NOT EXISTS "idx_paiements_monnaie_jour"
  ON "paiements" ("created_at") WHERE "monnaie_rendue" > 0;
