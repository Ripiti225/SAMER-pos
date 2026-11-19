-- Pointage par téléphone sur le wifi du restaurant — décidé le 2026-11-19.
--
-- Chaque employé pointe depuis SON téléphone : la page est servie par le
-- mini-PC (http://<ip>:3001/pointage.html), donc joignable seulement depuis le
-- réseau du restaurant. Les pointages entrent dans le MÊME journal que la
-- pointeuse (`pointeuse_evenements`) : le premier pointage gagne, l'autre est
-- refusé (« Déjà pointé à 8 h 02 »).
--
-- Règles retenues par le propriétaire :
--   * arrivée + départ (pas de pause au téléphone) ;
--   * selfie obligatoire à chaque pointage, visible par le gérant ;
--   * un téléphone = un compte : le 1er téléphone se rattache tout seul, un
--     CHANGEMENT de téléphone passe par le gérant (PIN manager).
--
-- Tables LOCALES : rien ici ne monte au cloud. Seule la valeur TELEPHONE de
-- `equipe_service.source` remonte (colonne déjà connue du cloud, sans CHECK).

-- ---------------------------------------------------------------------------
-- 1. Nouvelle origine d'une arrivée
-- ---------------------------------------------------------------------------
ALTER TABLE "equipe_service" DROP CONSTRAINT IF EXISTS "equipe_service_source_check";--> statement-breakpoint
ALTER TABLE "equipe_service" ADD CONSTRAINT "equipe_service_source_check"
  CHECK ("source" IN ('POINTEUSE','TELEPHONE','CAISSE','OUVERTURE'));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Téléphones rattachés aux comptes
-- ---------------------------------------------------------------------------
-- Le téléphone garde une clé aléatoire (cookie httpOnly) ; on n'en stocke que
-- l'empreinte SHA-256. Une page web ne peut pas lire l'IMEI : c'est le verrou
-- dans les DEUX sens, tenu ici, qui fait le garde-fou.
CREATE TABLE IF NOT EXISTS "appareils_pointage" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "utilisateur_id" uuid NOT NULL REFERENCES "utilisateurs"("id") ON DELETE CASCADE,
  "cle_hash" text NOT NULL,
  -- Navigateur / modèle lu dans l'en-tête, pour que le gérant reconnaisse le téléphone.
  "libelle" text,
  -- ACTIF      le téléphone du compte ;
  -- EN_ATTENTE changement de téléphone demandé, à valider par le gérant ;
  -- REMPLACE   ancien téléphone, remplacé par un autre ;
  -- REFUSE     demande refusée par le gérant.
  "statut" text NOT NULL,
  "cree_le" timestamp with time zone DEFAULT now() NOT NULL,
  "decide_par" uuid REFERENCES "utilisateurs"("id"),
  "decide_le" timestamp with time zone,
  CONSTRAINT "appareils_pointage_statut_check"
    CHECK ("statut" IN ('ACTIF','EN_ATTENTE','REMPLACE','REFUSE'))
);--> statement-breakpoint
-- Un seul téléphone actif par compte, une seule demande en cours par compte.
CREATE UNIQUE INDEX IF NOT EXISTS "appareils_pointage_actif_key"
  ON "appareils_pointage" ("utilisateur_id") WHERE "statut" = 'ACTIF';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "appareils_pointage_attente_key"
  ON "appareils_pointage" ("utilisateur_id") WHERE "statut" = 'EN_ATTENTE';--> statement-breakpoint
-- Un téléphone actif ne sert qu'à UN compte.
CREATE UNIQUE INDEX IF NOT EXISTS "appareils_pointage_cle_actif_key"
  ON "appareils_pointage" ("cle_hash") WHERE "statut" = 'ACTIF';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Selfie pris au pointage (JPEG réduit par le téléphone, ~50 Ko)
-- ---------------------------------------------------------------------------
-- Gardé en base (pas sur disque) : il suit les sauvegardes et le dossier
-- portable sans chemin Windows à gérer. Purgé au-delà de 60 jours.
-- Clé = (appareil, numero) de l'événement, et non son id : une arrivée en
-- attente est rejouée (supprimée puis réinsérée) à l'ouverture du shift.
CREATE TABLE IF NOT EXISTS "photos_pointage" (
  "appareil" text NOT NULL,
  "numero" bigint NOT NULL,
  "jpeg" bytea NOT NULL,
  "cree_le" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "photos_pointage_pkey" PRIMARY KEY ("appareil", "numero")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_photos_pointage_cree_le" ON "photos_pointage" ("cree_le");
