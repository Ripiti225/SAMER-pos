-- Escalopes servies avec des frites (décision du propriétaire, 2026-10-26).
--
-- « Assiette Escalope » et « Escalope Crème Fraîche » ne retiraient que
-- l'escalope : leur portion de frites manquait à l'inventaire chaque soir. On
-- ajoute 1 portion de frites à chacune, même si le plat a déjà une recette
-- (l'escalope) — sauf si les frites y sont déjà. Idempotente.
INSERT INTO "inventaire_consommations" ("produit_id", "article_id", "quantite")
SELECT p."id", a."id", 1
FROM "articles" a
JOIN "produits_inventaire" p ON p."code" = 'fr1' AND p."actif"
WHERE a."actif"
  AND lower(translate(btrim(a."nom"), 'ÉÈÊËÀÂÄÎÏÔÖÛÙÜÇéèêëàâäîïôöûùüç', 'EEEEAAAIIOOUUUCeeeeaaaiioouuuc'))
      IN ('assiette escalope', 'escalope creme fraiche')
ON CONFLICT ("produit_id", "article_id") DO NOTHING;
