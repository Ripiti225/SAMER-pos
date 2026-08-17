-- Options réutilisables, liables à une CATÉGORIE entière ou à un ARTICLE précis.
-- Migration DELTA écrite à la main : drizzle-kit n'a pas de snapshot des
-- migrations 0000-0019, `generate` redéposerait tout le schéma.
--
-- Ces deux tables sont volontairement LOCALES : elles ne figurent pas dans
-- sync/descente.ts, donc une descente du siège ne les écrase jamais (même
-- principe que disponibilite_locale). La remontée vers le cloud se fera plus
-- tard via sync_outbox, déjà alimentée par les routes d'administration.

CREATE TABLE IF NOT EXISTS "options_catalogue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "nom" text NOT NULL,
  "prix" integer DEFAULT 0 NOT NULL,
  "actif" boolean DEFAULT true NOT NULL,
  "ordre" smallint DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "options_catalogue_prix_check" CHECK ("prix" >= 0),
  CONSTRAINT "options_catalogue_nom_check" CHECK (length(btrim("nom")) > 0)
);--> statement-breakpoint

-- Unicité sur (nom, prix) et non sur le nom seul : la reprise ci-dessous peut
-- légitimement créer « Fromage » à deux prix différents si deux articles le
-- facturaient différemment. Fusionner automatiquement reviendrait à modifier un
-- prix de vente en silence — jamais.
CREATE UNIQUE INDEX IF NOT EXISTS "options_catalogue_nom_prix_idx"
  ON "options_catalogue" (lower(btrim("nom")), "prix");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "options_liaisons" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "option_id" uuid NOT NULL REFERENCES "options_catalogue"("id") ON DELETE CASCADE,
  "categorie_id" uuid REFERENCES "categories"("id") ON DELETE CASCADE,
  "article_id" uuid REFERENCES "articles"("id") ON DELETE CASCADE,
  CONSTRAINT "options_liaisons_cible_check" CHECK (("categorie_id" IS NULL) <> ("article_id" IS NULL))
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "options_liaisons_categorie_idx"
  ON "options_liaisons" ("option_id", "categorie_id") WHERE "categorie_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "options_liaisons_article_idx"
  ON "options_liaisons" ("option_id", "article_id") WHERE "article_id" IS NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Reprise de l'existant. Idempotente (ON CONFLICT DO NOTHING) : rejouable.
-- Les tables supplements / groupes_options / options ne sont PAS supprimées :
-- elles restent alimentées par la descente cloud, et les supprimer ferait
-- échouer une future synchro. Elles ne sont simplement plus lues par l'app.
-- ---------------------------------------------------------------------------

-- Suppléments payants → une option par couple (nom, prix) distinct.
INSERT INTO "options_catalogue" ("nom", "prix")
SELECT DISTINCT btrim(s."nom"), s."prix"
FROM "supplements" s
WHERE length(btrim(s."nom")) > 0
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Choix gratuits (groupes d'options) → options à 0 FCFA.
-- ⚠ La contrainte de groupe (« choisir exactement 1 sauce ») n'existe plus :
-- le nouveau modèle est une liste d'extras à cocher, choix assumé.
INSERT INTO "options_catalogue" ("nom", "prix")
SELECT DISTINCT btrim(o."nom"), 0
FROM "options" o
WHERE length(btrim(o."nom")) > 0
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Liaisons vers l'article qui portait le supplément.
INSERT INTO "options_liaisons" ("option_id", "article_id")
SELECT oc."id", s."article_id"
FROM "supplements" s
JOIN "options_catalogue" oc
  ON lower(btrim(oc."nom")) = lower(btrim(s."nom")) AND oc."prix" = s."prix"
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Liaisons vers l'article qui portait le choix gratuit.
INSERT INTO "options_liaisons" ("option_id", "article_id")
SELECT oc."id", g."article_id"
FROM "options" o
JOIN "groupes_options" g ON g."id" = o."groupe_id"
JOIN "options_catalogue" oc
  ON lower(btrim(oc."nom")) = lower(btrim(o."nom")) AND oc."prix" = 0
ON CONFLICT DO NOTHING;
