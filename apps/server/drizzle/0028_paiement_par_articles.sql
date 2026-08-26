-- Sous-notes liées aux articles : migration compatible avec les anciens splits.
ALTER TABLE "notes_split"
  ADD COLUMN IF NOT EXISTS "numero" smallint,
  ADD COLUMN IF NOT EXISTS "type" text NOT NULL DEFAULT 'MONTANT_HISTORIQUE',
  ADD COLUMN IF NOT EXISTS "statut" text NOT NULL DEFAULT 'A_PAYER',
  ADD COLUMN IF NOT EXISTS "sous_total" integer,
  ADD COLUMN IF NOT EXISTS "promo_montant" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "remise_montant" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "fidelite_montant" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "client_fidelite_id" uuid REFERENCES "clients_fidelite"("id"),
  ADD COLUMN IF NOT EXISTS "fidelite_points" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "service_id" uuid REFERENCES "services_caisse"("id"),
  ADD COLUMN IF NOT EXISTS "payee_par" uuid REFERENCES "utilisateurs"("id"),
  ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "payee_le" timestamptz;

WITH numerotees AS (
  SELECT id, row_number() OVER (PARTITION BY commande_id ORDER BY id)::smallint AS numero
  FROM notes_split
)
UPDATE notes_split n
SET numero = x.numero, sous_total = n.montant
FROM numerotees x
WHERE x.id = n.id;

UPDATE notes_split n
SET statut = CASE
  WHEN COALESCE(p.total_paye, 0) = 0 THEN 'A_PAYER'
  WHEN COALESCE(p.total_paye, 0) >= n.montant THEN 'PAYEE'
  ELSE 'PARTIELLEMENT_PAYEE'
END,
payee_le = CASE WHEN COALESCE(p.total_paye, 0) >= n.montant THEN p.dernier_paiement END,
service_id = CASE WHEN COALESCE(p.total_paye, 0) >= n.montant THEN p.service_id END,
payee_par = CASE WHEN COALESCE(p.total_paye, 0) >= n.montant THEN p.encaisse_par END
FROM (
  SELECT note_id, sum(montant)::integer AS total_paye, max(created_at) AS dernier_paiement,
         (array_agg(service_id ORDER BY created_at DESC))[1] AS service_id,
         (array_agg(encaisse_par ORDER BY created_at DESC))[1] AS encaisse_par
  FROM paiements WHERE note_id IS NOT NULL GROUP BY note_id
) p
WHERE p.note_id = n.id;

ALTER TABLE "notes_split"
  ALTER COLUMN "numero" SET NOT NULL,
  ALTER COLUMN "sous_total" SET NOT NULL,
  ALTER COLUMN "type" SET DEFAULT 'ARTICLES';

ALTER TABLE "notes_split" ADD CONSTRAINT "notes_split_commande_numero_unique" UNIQUE ("commande_id", "numero");
ALTER TABLE "notes_split" ADD CONSTRAINT "notes_split_numero_check" CHECK ("numero" > 0);
ALTER TABLE "notes_split" ADD CONSTRAINT "notes_split_type_check" CHECK ("type" IN ('ARTICLES','MONTANT_HISTORIQUE'));
ALTER TABLE "notes_split" ADD CONSTRAINT "notes_split_statut_check" CHECK ("statut" IN ('A_PAYER','PARTIELLEMENT_PAYEE','PAYEE','ANNULEE'));
ALTER TABLE "notes_split" ADD CONSTRAINT "notes_split_sous_total_check" CHECK ("sous_total" > 0);
ALTER TABLE "notes_split" ADD CONSTRAINT "notes_split_reductions_check" CHECK ("promo_montant" >= 0 AND "remise_montant" >= 0 AND "fidelite_montant" >= 0);

CREATE TABLE IF NOT EXISTS "note_split_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "note_id" uuid NOT NULL REFERENCES "notes_split"("id") ON DELETE CASCADE,
  "commande_item_id" uuid NOT NULL REFERENCES "commande_items"("id"),
  "quantite" smallint NOT NULL CHECK ("quantite" > 0),
  "montant_brut" integer NOT NULL CHECK ("montant_brut" > 0),
  CONSTRAINT "note_split_items_note_item_unique" UNIQUE ("note_id", "commande_item_id")
);

ALTER TABLE "points_fidelite"
  ADD COLUMN IF NOT EXISTS "note_id" uuid REFERENCES "notes_split"("id");
