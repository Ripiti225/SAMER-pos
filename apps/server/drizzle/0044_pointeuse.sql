-- Pointeuse Hikvision (DS-K1T320EFWX) — décidé le 2026-10-26.
--
-- Les présences viennent désormais de la pointeuse : touche Entrée / Sortie +
-- reconnaissance faciale. Le serveur POS lit les pointages de l'appareil sur
-- le réseau local (ISAPI) et les reporte sur l'équipe du service.
--
-- Règles de paie retenues par le propriétaire :
--   * l'arrivée est l'heure RÉELLE du pointage, même avant l'ouverture du shift ;
--   * une Sortie puis une Entrée dans le même shift : l'absence est DÉDUITE ;
--   * qui n'a pas pointé sa sortie : le caissier tranche « reste / part » à la
--     clôture, un employé à la fois (comme avant la pointeuse).
--
-- Tables et colonnes LOCALES : rien ici ne monte au cloud (la liste blanche
-- de `equipe_service` côté cloud ne connaît pas les nouvelles colonnes).

-- ---------------------------------------------------------------------------
-- 1. Équipe du service : sortie pointée et absences déduites
-- ---------------------------------------------------------------------------
-- Heure de la DERNIÈRE sortie pointée. NULL = toujours là (ou parti sans
-- pointer : sa sortie est alors la clôture du shift).
ALTER TABLE "equipe_service" ADD COLUMN IF NOT EXISTS "depart_le" timestamp with time zone;--> statement-breakpoint
-- Cumul des absences Sortie → Entrée dans ce shift, retiré des heures faites.
ALTER TABLE "equipe_service" ADD COLUMN IF NOT EXISTS "secondes_absence" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Qui a daté l'arrivée : POINTEUSE, CAISSE (secours PIN manager) ou OUVERTURE
-- (ancien fonctionnement : coché par le caissier à l'ouverture).
ALTER TABLE "equipe_service" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'OUVERTURE' NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "equipe_service" ADD CONSTRAINT "equipe_service_absence_check" CHECK ("secondes_absence" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "equipe_service" ADD CONSTRAINT "equipe_service_source_check"
    CHECK ("source" IN ('POINTEUSE','CAISSE','OUVERTURE'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Numéro de l'employé dans la pointeuse (« N° employé » de l'appareil)
-- ---------------------------------------------------------------------------
ALTER TABLE "utilisateurs" ADD COLUMN IF NOT EXISTS "pointeuse_no" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "utilisateurs_pointeuse_no_key"
  ON "utilisateurs" ("pointeuse_no") WHERE "pointeuse_no" IS NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Journal des pointages lus sur l'appareil
-- ---------------------------------------------------------------------------
-- Chaque événement est gardé tel quel, une seule fois (appareil + n° de série
-- de l'événement) : relire la pointeuse après une coupure ne double rien.
CREATE TABLE IF NOT EXISTS "pointeuse_evenements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Numéro de série de l'appareil (un site pourrait en avoir deux).
  "appareil" text NOT NULL,
  -- serialNo de l'événement dans l'appareil (croissant).
  "numero" bigint NOT NULL,
  "employe_no" text NOT NULL,
  "nom_appareil" text,
  "utilisateur_id" uuid REFERENCES "utilisateurs"("id"),
  "sens" text NOT NULL,
  "pointe_le" timestamp with time zone NOT NULL,
  -- APPLIQUE   reporté sur l'équipe d'un shift ;
  -- EN_ATTENTE entrée pointée sans shift ouvert : reprise à l'ouverture ;
  -- INCONNU    numéro absent du POS (à rattacher dans Réglages › Pointeuse) ;
  -- IGNORE     sans effet (doublon de sens, sortie hors shift, trop ancien).
  "statut" text NOT NULL,
  "service_id" uuid REFERENCES "services_caisse"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pointeuse_evenements_sens_check" CHECK ("sens" IN ('ENTREE','SORTIE')),
  CONSTRAINT "pointeuse_evenements_statut_check"
    CHECK ("statut" IN ('APPLIQUE','EN_ATTENTE','INCONNU','IGNORE'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pointeuse_evenements_numero_key"
  ON "pointeuse_evenements" ("appareil", "numero");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pointeuse_evenements_utilisateur"
  ON "pointeuse_evenements" ("utilisateur_id", "pointe_le");
