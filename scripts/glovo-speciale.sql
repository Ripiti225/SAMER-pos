-- ===========================================================================
--  Catégorie « Glovo spéciale » + 3 produits à 3 000 F — master, 2026-08-17
--
--  Demandé par le boss avant la fabrication de la clé : ces trois plats
--  partiront donc sur les 7 restaurants avec l'image.
--
--  Liaisons d'inventaire : Burger spécial → Pain burger, Pizza spéciale →
--  Pizza spéciale (130g). Le Poulet spécial Glovo reste SANS liaison (choix
--  du boss) : il se vendra normalement, mais ne sortira rien du stock.
--
--  Idempotent : réexécutable sans créer de doublon.
-- ===========================================================================
SET client_encoding TO 'UTF8';

BEGIN;

-- 1) La catégorie. `ordre` = 16, à la suite des 15 existantes.
INSERT INTO categories (nom, ordre, actif)
SELECT 'Glovo spéciale', 16, TRUE
 WHERE NOT EXISTS (SELECT 1 FROM categories WHERE nom = 'Glovo spéciale');

-- 2) Routage d'impression. Sans cette ligne, les bons de la nouvelle catégorie
--    ne seraient pas routés : les 14 catégories actives en ont toutes une.
--    CUISINE comme les Pizzas, Sandwiches et Poulet & Poisson — ce sont des
--    plats préparés, pas des boissons servies au comptoir.
INSERT INTO routage_categorie (categorie_id, poste)
SELECT c.id, 'CUISINE'::poste_impression
  FROM categories c
 WHERE c.nom = 'Glovo spéciale'
   AND NOT EXISTS (SELECT 1 FROM routage_categorie r WHERE r.categorie_id = c.id);

-- 3) Les trois plats, à 3 000 F chacun.
INSERT INTO articles (categorie_id, nom, prix_base, actif, disponible)
SELECT c.id, v.nom, 3000, TRUE, TRUE
  FROM categories c
  CROSS JOIN (VALUES
    ('Burger spécial'),
    ('Pizza spéciale'),
    ('Poulet spécial Glovo')
  ) AS v(nom)
 WHERE c.nom = 'Glovo spéciale'
   AND NOT EXISTS (
     SELECT 1 FROM articles a
      WHERE a.nom = v.nom AND a.categorie_id = c.id
   );

-- 4) Recettes d'inventaire. `quantite` = unités du produit par plat vendu ;
--    elle se COMPOSE avec le `ratio` du produit, elle ne le remplace pas :
--    1 × Pizza spéciale (130g) sortira bien 130 g de fromage.
INSERT INTO inventaire_consommations (produit_id, article_id, quantite)
SELECT p.id, a.id, 1
  FROM produits_inventaire p
  JOIN categories c ON c.nom = 'Glovo spéciale'
  JOIN articles a ON a.categorie_id = c.id AND a.nom = 'Burger spécial'
 WHERE p.code = 'p2'
ON CONFLICT (produit_id, article_id) DO NOTHING;

INSERT INTO inventaire_consommations (produit_id, article_id, quantite)
SELECT p.id, a.id, 1
  FROM produits_inventaire p
  JOIN categories c ON c.nom = 'Glovo spéciale'
  JOIN articles a ON a.categorie_id = c.id AND a.nom = 'Pizza spéciale'
 WHERE p.code = 'f3'
ON CONFLICT (produit_id, article_id) DO NOTHING;

COMMIT;

-- ---------------------------------------------------------------------------
-- Contrôle
-- ---------------------------------------------------------------------------
SELECT a.nom AS plat, a.prix_base, r.poste AS impression,
       COALESCE(pi.nom, '(aucune liaison)') AS consomme,
       ic.quantite
  FROM articles a
  JOIN categories c ON c.id = a.categorie_id
  LEFT JOIN routage_categorie r ON r.categorie_id = c.id
  LEFT JOIN inventaire_consommations ic ON ic.article_id = a.id
  LEFT JOIN produits_inventaire pi ON pi.id = ic.produit_id
 WHERE c.nom = 'Glovo spéciale'
 ORDER BY a.nom;
