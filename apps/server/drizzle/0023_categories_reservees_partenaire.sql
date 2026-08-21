-- Catégories réservées à un partenaire de livraison (2026-08-17).
--
-- Besoin : « Glovo spéciale » regroupe trois plats vendus UNIQUEMENT via Glovo.
-- Sans restriction, la catégorie apparaîtrait dans le menu de la caisse, sur la
-- tablette serveur et sur la page client au QR — un client sur place pourrait
-- commander un plat qui n'existe pas pour lui, et le caissier le lui vendrait.
--
-- `partenaires` NULL ou vide = catégorie normale, visible partout (c'est le cas
-- des 15 catégories existantes, d'où l'absence de valeur par défaut : on ne veut
-- pas d'un tableau vide qui aurait l'air d'un réglage volontaire).
-- Sinon : la catégorie n'apparaît QUE sur une commande dont le `partenaire`
-- figure dans la liste. Codes attendus : YANGO, GLOVO, SAMER_DELLY.
--
-- Un tableau plutôt qu'une colonne simple : « spécial livraison » (Yango ET
-- Glovo) est le cas suivant qui arrivera, et il ne coûte rien ici.
ALTER TABLE categories ADD COLUMN IF NOT EXISTS partenaires TEXT[];

-- Index partiel : seules les catégories restreintes sont indexées — elles sont
-- une poignée face aux catégories normales.
CREATE INDEX IF NOT EXISTS idx_categories_partenaires
  ON categories USING GIN (partenaires)
  WHERE partenaires IS NOT NULL;
