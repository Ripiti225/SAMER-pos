-- Recettes d'inventaire — choix du propriétaire du 2026-10-26 (QCM).
--
-- 1. Brochettes : UN seul produit « Brochette ». Les ventes ne disent pas si
--    une brochette est au poulet ou à la viande : tout ce qui rentre est
--    « Brochette », tout ce qui sort aussi. a10 devient « Brochette », a11
--    (Brochette viande) est désactivé et son stock rejoint a10.
-- 2. Darina : 1 sachet = 8 Pots Fresco (et non plus 9). Les deux restent
--    comptés.
-- 3. Liaisons des plats qui n'affichaient aucun stock en cuisine.
--
-- Le catalogue d'inventaire vit sur chaque site (le siège n'a pas d'écran pour
-- le modifier) : d'où une migration, comme pour le reste. Idempotente, et
-- prudente : elle ne touche jamais une recette posée à la main.

-- ---------------------------------------------------------------------------
-- 1. Brochette unique
-- ---------------------------------------------------------------------------
-- Le stock de Brochette viande rejoint Brochette, à chaque endroit où il est lu :
-- le dernier inventaire validé (stock reporté au shift suivant)…
UPDATE "inventaire_lignes" l10
SET "stock_compte" = COALESCE(l10."stock_compte", 0) + COALESCE(l11."stock_compte", 0)
FROM "inventaire_lignes" l11, "produits_inventaire" p10, "produits_inventaire" p11
WHERE p10."code" = 'a10' AND p11."code" = 'a11' AND p11."actif"
  AND l10."produit_id" = p10."id" AND l11."produit_id" = p11."id"
  AND l10."inventaire_id" = l11."inventaire_id"
  AND l11."stock_compte" IS NOT NULL
  AND l10."inventaire_id" = (
    SELECT "id" FROM "inventaires_service" WHERE "valide" ORDER BY "valide_le" DESC LIMIT 1
  );--> statement-breakpoint

-- … et l'inventaire du shift en cours, s'il est ouvert : stock de départ et
-- réceptions déjà saisies.
UPDATE "inventaire_lignes" l10
SET "stock_initial" = l10."stock_initial" + l11."stock_initial"
FROM "inventaire_lignes" l11, "produits_inventaire" p10, "produits_inventaire" p11, "inventaires_service" i
WHERE p10."code" = 'a10' AND p11."code" = 'a11' AND p11."actif"
  AND l10."produit_id" = p10."id" AND l11."produit_id" = p11."id"
  AND l10."inventaire_id" = l11."inventaire_id"
  AND i."id" = l10."inventaire_id" AND NOT i."valide";--> statement-breakpoint

UPDATE "entrees_stock" e
SET "produit_id" = p10."id"
FROM "produits_inventaire" p10, "produits_inventaire" p11, "inventaires_service" i
WHERE p10."code" = 'a10' AND p11."code" = 'a11' AND p11."actif"
  AND e."produit_id" = p11."id"
  AND i."id" = e."inventaire_id" AND NOT i."valide";--> statement-breakpoint

-- Les plats qui consommaient Brochette viande consomment Brochette.
INSERT INTO "inventaire_consommations" ("produit_id", "article_id", "quantite")
SELECT p10."id", ic."article_id", ic."quantite"
FROM "inventaire_consommations" ic
JOIN "produits_inventaire" p11 ON p11."id" = ic."produit_id" AND p11."code" = 'a11'
CROSS JOIN (SELECT "id" FROM "produits_inventaire" WHERE "code" = 'a10') p10
ON CONFLICT ("produit_id", "article_id") DO NOTHING;--> statement-breakpoint

DELETE FROM "inventaire_consommations"
WHERE "produit_id" IN (SELECT "id" FROM "produits_inventaire" WHERE "code" = 'a11');--> statement-breakpoint

UPDATE "produits_inventaire" SET "nom" = 'Brochette' WHERE "code" = 'a10' AND "nom" = 'Brochette poulet';--> statement-breakpoint
UPDATE "produits_inventaire" SET "actif" = false WHERE "code" = 'a11';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Darina : 1 sachet couvre 8 Pots Fresco (9 jusqu'ici)
-- ---------------------------------------------------------------------------
-- Seulement si le ratio est encore celui posé par défaut : un réglage fait à
-- la main sur un site reste le sien. NULL compte comme « par défaut » : la
-- 0021 a créé le Darina SANS ratio, le 9 du 26/09 n'est allé que dans le seed
-- des bases neuves — un site migré retirait donc 1 sachet par pot vendu.
UPDATE "produits_inventaire" SET "ratio" = 8 WHERE "code" = 'b7' AND ("ratio" IS NULL OR "ratio" = 9);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Liaisons décidées au QCM
-- ---------------------------------------------------------------------------
-- Nom d'article comparé sans accents ni majuscules (les cartes sont saisies à
-- la main). Un plat qui a DÉJÀ une recette n'est pas touché : c'est un choix
-- du manager. Seule exception, la Brochette Frites, qui porte déjà ses frites :
-- on ajoute la brochette si elle n'y est pas.
WITH regles("nom", "code", "quantite", "meme_si_recette") AS (VALUES
  ('boisson', 'b4', 1, false),
  ('cody''s energie', 'b4', 1, false),
  ('cody''s malta', 'b5', 1, false),
  ('bavaria (bouteille)', 'b5', 1, false),
  ('the infusion', 'b8', 1, false),
  ('assiette chicken', 'p2', 1, false),
  ('assiette chicken', 'pl3', 1, false),
  ('assiette hamburger', 'pl4', 1, false),
  ('assiette hamburger', 'p2', 1, false),
  ('assiette chawarma', 'p1', 2, false),
  ('brochette frites', 'a10', 1, true)
),
cartes AS (
  SELECT "id",
    lower(translate(btrim("nom"), 'ÉÈÊËÀÂÄÎÏÔÖÛÙÜÇéèêëàâäîïôöûùüç’', 'EEEEAAAIIOOUUUCeeeeaaaiioouuuc''')) AS "nom",
    EXISTS (SELECT 1 FROM "inventaire_consommations" ic WHERE ic."article_id" = a."id") AS "a_recette"
  FROM "articles" a
  WHERE "actif"
)
INSERT INTO "inventaire_consommations" ("produit_id", "article_id", "quantite")
SELECT p."id", c."id", r."quantite"
FROM regles r
JOIN cartes c ON c."nom" = r."nom"
JOIN "produits_inventaire" p ON p."code" = r."code" AND p."actif"
WHERE r."meme_si_recette" OR NOT c."a_recette"
ON CONFLICT ("produit_id", "article_id") DO NOTHING;
