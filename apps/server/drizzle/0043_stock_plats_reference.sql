-- Stock en cuisine sous la photo des plats (2026-10-22).
--
-- Le produit d'inventaire qui sert de « stock de référence » à un plat est
-- DÉDUIT automatiquement de ses recettes d'inventaire (produit fini, fromage,
-- poulet, sinon ingrédient principal). Cette table ne porte QUE les exceptions
-- posées à la main dans Réglages › Stock en cuisine :
--   PRODUIT  ce produit précis, quoi que dise la déduction ;
--   AUCUN    ne rien afficher sous ce plat.
-- Pas de ligne = automatique. Ainsi une recette corrigée plus tard est suivie
-- d'elle-même, sauf là où quelqu'un a dit expressément autre chose.
--
-- Table LOCALE : chaque site a ses propres recettes et ses propres choix.
-- Jamais publiée (pas d'outbox), jamais écrasée par une descente du siège.
-- ON DELETE CASCADE des deux côtés : un plat ou un produit supprimé ramène
-- simplement le plat en automatique, sans référence orpheline.
CREATE TABLE IF NOT EXISTS "stock_plats_reference" (
  "article_id" uuid PRIMARY KEY REFERENCES "articles"("id") ON DELETE CASCADE,
  "mode"       text NOT NULL,
  "produit_id" uuid REFERENCES "produits_inventaire"("id") ON DELETE CASCADE,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "stock_plats_reference_mode_check" CHECK (
    ("mode" = 'PRODUIT' AND "produit_id" IS NOT NULL)
    OR ("mode" = 'AUCUN' AND "produit_id" IS NULL)
  )
);
