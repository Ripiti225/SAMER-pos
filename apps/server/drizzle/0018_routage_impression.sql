-- Routage d'impression par produit + code court de commande (SP215).
-- Migration DELTA (le schéma existait déjà ; drizzle-kit n'avait pas de snapshot
-- des migrations 0000-0017 écrites à la main, d'où la régénération manuelle ici).

CREATE TYPE "public"."poste_impression" AS ENUM('CAISSE', 'CUISINE', 'BAR');--> statement-breakpoint

ALTER TABLE "commandes" ADD COLUMN "code_commande" text;--> statement-breakpoint

CREATE TABLE "routage_categorie" (
	"categorie_id" uuid PRIMARY KEY NOT NULL,
	"poste" "poste_impression" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routage_article" (
	"article_id" uuid PRIMARY KEY NOT NULL,
	"poste" "poste_impression" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "routage_categorie" ADD CONSTRAINT "routage_categorie_categorie_id_categories_id_fk" FOREIGN KEY ("categorie_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routage_article" ADD CONSTRAINT "routage_article_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "uniq_code_commande_service" ON "commandes" USING btree ("service_id","code_commande") WHERE "commandes"."code_commande" IS NOT NULL;
