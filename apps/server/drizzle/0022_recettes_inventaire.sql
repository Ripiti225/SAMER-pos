-- ---------------------------------------------------------------------------
-- 0022 — RECETTES D'INVENTAIRE : ce qu'un article de vente consomme.
--
-- Delta écrit à la main (aucun snapshot drizzle pour 0000-0021 : `generate`
-- redéclarerait tout le schéma — voir docs/ETAT_PROJET.md § Migrations Drizzle).
--
-- POURQUOI
-- --------
-- La migration 0021 reliait un produit de comptage à UN article de vente
-- (`produits_inventaire.article_id`). En confrontant les 52 produits de comptage
-- aux 128 articles du catalogue, le lien s'est révélé **un-à-plusieurs dans les
-- deux sens** : « Pain chawarma » est consommé par les 6 Chawarmas, « Pizza
-- grande (200g) » par les 13 `Pizza … (G)`, « Portions de frites » par la
-- quinzaine d'articles « + Frites » — et un « Poulet Pané + Frites » consomme à
-- lui seul du poulet, des frites ET du pain. Une colonne unique ne peut pas
-- porter ça ; tant qu'elle restait vide, les sorties d'inventaire valaient 0 et
-- le théorique se réduisait à initial + entrées.
--
-- `quantite` = nombre d'unités du produit consommées PAR ARTICLE VENDU (1 pain
-- par chawarma, 1 portion de frites par assiette). Elle ne remplace PAS `ratio`,
-- qui garde exactement le sens qu'il a dans SamerTrackly (grammes de fromage,
-- boules de glace, portions par sachet) : les formules dérivées sont le contrat
-- avec le back-office, pas une interprétation. Les deux se composent —
-- `quantite` dit COMBIEN d'unités sortent, `ratio` les CONVERTIT.
--
-- Table LOCALE, comme tout l'inventaire : ni descente de synchro, ni
-- `sync_outbox` (le cloud n'a pas ces tables).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "inventaire_consommations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "produit_id" uuid NOT NULL REFERENCES "produits_inventaire"("id") ON DELETE CASCADE,
  "article_id" uuid NOT NULL REFERENCES "articles"("id") ON DELETE CASCADE,
  -- Unités du produit consommées par article vendu.
  "quantite" numeric(12,3) DEFAULT 1 NOT NULL,
  CONSTRAINT "inventaire_consommations_quantite_check" CHECK ("quantite" > 0)
);--> statement-breakpoint

-- Une seule ligne par couple : la recette d'un article se corrige, elle ne
-- s'empile pas (l'écran de réglages fait un upsert sur cette clé).
CREATE UNIQUE INDEX IF NOT EXISTS "inventaire_consommations_key"
  ON "inventaire_consommations" ("produit_id", "article_id");--> statement-breakpoint

-- Sens de lecture le plus fréquent : « que consomme cet article ? »
CREATE INDEX IF NOT EXISTS "idx_inventaire_consommations_article"
  ON "inventaire_consommations" ("article_id");--> statement-breakpoint

-- Reprise des liaisons éventuellement posées à la main via l'ancienne colonne.
INSERT INTO "inventaire_consommations" ("produit_id", "article_id", "quantite")
SELECT "id", "article_id", 1 FROM "produits_inventaire" WHERE "article_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- La colonne de la 0021 disparaît : la laisser serait garder un second chemin,
-- faux, vers la même information.
ALTER TABLE "produits_inventaire" DROP COLUMN IF EXISTS "article_id";
