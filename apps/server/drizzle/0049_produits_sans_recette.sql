-- Les 4 produits d'inventaire qu'aucun plat ne faisait sortir (décisions du
-- propriétaire, 2026-10-26). Comptés à chaque clôture sans jamais baisser
-- avec les ventes, ils ressortaient en manquant tous les soirs.
--
--   p3  Pain fahita            tous les sandwichs, sauf Burger et Chicken Burger
--   f3  Pizza spéciale (130g)  la « Pizza Spéciale » (restaurants de Yop)
--   f6  Mini pizza (20g)       la « Mini Pizza »
--   po6 Cuisses de poulet      plus compté (désactivé)
--
-- Idempotente. Une liaison déjà posée n'est pas doublée ; un sandwich qui a
-- déjà un pain dans sa recette n'en reçoit pas un second.

-- Pain fahita : catégorie « Sandwiches » (ou « Sandwichs »), hors burgers.
INSERT INTO "inventaire_consommations" ("produit_id", "article_id", "quantite")
SELECT p."id", a."id", 1
FROM "articles" a
JOIN "categories" c ON c."id" = a."categorie_id"
JOIN "produits_inventaire" p ON p."code" = 'p3' AND p."actif"
WHERE a."actif"
  AND lower(btrim(c."nom")) IN ('sandwiches', 'sandwichs', 'sandwich')
  AND lower(btrim(a."nom")) NOT IN ('burger', 'chicken burger')
  AND NOT EXISTS (
    SELECT 1 FROM "inventaire_consommations" ic
    JOIN "produits_inventaire" pain ON pain."id" = ic."produit_id" AND pain."categorie" = 'PAIN'
    WHERE ic."article_id" = a."id"
  )
ON CONFLICT ("produit_id", "article_id") DO NOTHING;--> statement-breakpoint

-- Pizza Spéciale → 130 g, Mini Pizza → 20 g (le ratio du produit convertit).
INSERT INTO "inventaire_consommations" ("produit_id", "article_id", "quantite")
SELECT p."id", a."id", 1
FROM "articles" a
JOIN "produits_inventaire" p ON p."actif" AND (
  (p."code" = 'f3' AND lower(translate(btrim(a."nom"), 'Éé', 'Ee')) LIKE 'pizza speciale%')
  OR (p."code" = 'f6' AND lower(btrim(a."nom")) LIKE 'mini pizza%')
)
WHERE a."actif"
ON CONFLICT ("produit_id", "article_id") DO NOTHING;--> statement-breakpoint

-- Cuisses de poulet : plus comptées.
UPDATE "produits_inventaire" SET "actif" = false WHERE "code" = 'po6';
