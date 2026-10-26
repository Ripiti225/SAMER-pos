-- Glaces servies en cornet (décision du propriétaire, 2026-10-26).
--
-- « Glace (2 Boules) » et « Glace Spéciale » sortent avec un cornet : la
-- recette retire désormais 1 Cornet (g4) en plus de leurs boules. Le Milkshake
-- n'en prend pas. Idempotente ; une liaison déjà posée n'est pas doublée.
INSERT INTO "inventaire_consommations" ("produit_id", "article_id", "quantite")
SELECT p."id", a."id", 1
FROM "articles" a
JOIN "produits_inventaire" p ON p."code" = 'g4' AND p."actif"
WHERE a."actif"
  AND lower(translate(btrim(a."nom"), 'ÉÈÊËÀÂÄÎÏÔÖÛÙÜÇéèêëàâäîïôöûùüç', 'EEEEAAAIIOOUUUCeeeeaaaiioouuuc'))
      IN ('glace (2 boules)', 'glace speciale')
ON CONFLICT ("produit_id", "article_id") DO NOTHING;
