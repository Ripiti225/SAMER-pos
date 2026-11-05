-- Correction du stock initial en début de shift. Le chiffre corrigé va dans
-- inventaire_lignes.stock_initial ; cette table garde qui, quand, pourquoi, et
-- qui paie. Une correction remplacée reste en base : c'est l'historique.
CREATE TABLE IF NOT EXISTS "corrections_stock_initial" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "inventaire_id"       uuid NOT NULL REFERENCES "inventaires_service"("id") ON DELETE CASCADE,
  "produit_id"          uuid NOT NULL REFERENCES "produits_inventaire"("id") ON DELETE CASCADE,
  "produit_code"        text NOT NULL,
  "produit_nom"         text NOT NULL,
  "produit_prix"        integer NOT NULL,
  "stock_reporte"       numeric(12,2) NOT NULL,
  "stock_avant"         numeric(12,2) NOT NULL,
  "stock_apres"         numeric(12,2) NOT NULL,
  "explication"         text NOT NULL,
  "saisi_par"           uuid NOT NULL REFERENCES "utilisateurs"("id"),
  "service_sortant_id"  uuid REFERENCES "services_caisse"("id"),
  "caissier_sortant_id" uuid REFERENCES "utilisateurs"("id"),
  "shift_intermediaire_debloque" boolean NOT NULL DEFAULT false,
  "ecart_sortant_avant" numeric(12,2),
  "ecart_sortant_apres" numeric(12,2),
  "statut"              text NOT NULL,
  "valide_par"          uuid REFERENCES "utilisateurs"("id"),
  "valide_le"           timestamp with time zone,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "corrections_stock_initial_stock_check" CHECK ("stock_apres" >= 0),
  CONSTRAINT "corrections_stock_initial_explication_check" CHECK (length(btrim("explication")) > 0),
  CONSTRAINT "corrections_stock_initial_statut_check" CHECK ("statut" IN
    ('SANS_LITIGE','A_VALIDER','RECONNUE_SORTANT','VALIDEE_MANAGER','REMPLACEE'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "corrections_stock_initial_active"
  ON "corrections_stock_initial" ("inventaire_id", "produit_id") WHERE "statut" <> 'REMPLACEE';
