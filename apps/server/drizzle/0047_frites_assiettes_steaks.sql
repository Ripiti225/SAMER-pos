-- Plats servis avec des frites (décision du propriétaire, 2026-10-26).
--
-- Une recette doit porter TOUT ce que le plat retire du stock : l'Assiette
-- Hamburger, c'est pain burger + viande burger + frites. Ces plats ne
-- retiraient pas leurs frites, d'où un manquant de sachets chaque soir. On
-- ajoute 1 portion de frites à chacun, même s'ils ont déjà une recette — sauf
-- si les frites y sont déjà. Les sandwichs Crispy et Escalope ne changent pas
-- (confirmé : pas de frites, et ils ne retirent que le fromage). Idempotente.
INSERT INTO "inventaire_consommations" ("produit_id", "article_id", "quantite")
SELECT p."id", a."id", 1
FROM "articles" a
JOIN "produits_inventaire" p ON p."code" = 'fr1' AND p."actif"
WHERE a."actif"
  AND lower(translate(btrim(a."nom"), 'ÉÈÊËÀÂÄÎÏÔÖÛÙÜÇéèêëàâäîïôöûùüç', 'EEEEAAAIIOOUUUCeeeeaaaiioouuuc'))
      ~ '^(assiette (chawarma|chicken|hamburger|viande mixte)|steak (creme fraiche|petits pois|spaghetti)|(demi )?poulet saute (a la creme|aux legumes))$'
ON CONFLICT ("produit_id", "article_id") DO NOTHING;
