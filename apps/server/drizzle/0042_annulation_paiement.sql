-- Annulation d'un paiement saisi par erreur (2026-10-21), tant que le shift
-- où il a été encaissé est encore OUVERT.
--
-- Un paiement n'est JAMAIS supprimé ni modifié : il est CONTRE-PASSÉ par une
-- ligne négative du même mode, sur le même shift, rattachée à l'original par
-- `contrepasse_de`. Pourquoi une ligne de plus plutôt qu'un drapeau « annulé »
-- sur l'original :
--  - toutes les sommes existantes (théorique espèces, ticket Z, mobile money,
--    rapport X, réconciliation locale ↔ cloud) restent justes SANS filtre ;
--  - le cloud reçoit un simple INSERT de plus, avec des colonnes qu'il connaît
--    déjà : ses sommes (tableau de bord du siège) sont justes dès la remontée,
--    sans migration cloud préalable ni risque de bloquer l'outbox ;
--  - l'original reste tel qu'il a été encaissé, comme le journal d'audit.
--
-- `annule_par` (l'administrateur qui a saisi son PIN) et `annulation_motif`
-- sont portés par la contre-passation : c'est elle, l'acte de correction.
ALTER TABLE "paiements"
  ADD COLUMN IF NOT EXISTS "contrepasse_de"   uuid REFERENCES "paiements"("id"),
  ADD COLUMN IF NOT EXISTS "annule_par"       uuid REFERENCES "utilisateurs"("id"),
  ADD COLUMN IF NOT EXISTS "annulation_motif" text;

-- Un encaissement est positif ; une contre-passation est négative, signée et
-- motivée. Rien d'autre n'entre dans la table.
ALTER TABLE "paiements" DROP CONSTRAINT IF EXISTS "paiements_montant_check";
ALTER TABLE "paiements" ADD CONSTRAINT "paiements_montant_check" CHECK (
  ("contrepasse_de" IS NULL AND "montant" > 0
    AND "annule_par" IS NULL AND "annulation_motif" IS NULL)
  OR ("contrepasse_de" IS NOT NULL AND "montant" < 0
    AND "annule_par" IS NOT NULL AND "annulation_motif" IS NOT NULL)
);

-- La contre-passation d'un paiement en espèces reprend en négatif le billet et
-- la monnaie rendue : la monnaie rendue du shift reste ainsi juste elle aussi.
ALTER TABLE "paiements" DROP CONSTRAINT IF EXISTS "paiements_monnaie_check";
ALTER TABLE "paiements" ADD CONSTRAINT "paiements_monnaie_check" CHECK (
  ("montant_recu" IS NULL AND "monnaie_rendue" IS NULL)
  OR ("contrepasse_de" IS NULL AND "montant_recu" >= "montant"
    AND "monnaie_rendue" = "montant_recu" - "montant")
  OR ("contrepasse_de" IS NOT NULL AND "montant_recu" <= "montant"
    AND "monnaie_rendue" = "montant_recu" - "montant")
);

-- Un paiement ne s'annule qu'une fois : deux caisses qui valident en même
-- temps se heurtent ici, même si le contrôle applicatif a laissé passer.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_paiements_contrepasse_de"
  ON "paiements" ("contrepasse_de") WHERE "contrepasse_de" IS NOT NULL;
