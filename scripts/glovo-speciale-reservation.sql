-- Réserve la catégorie « Glovo spéciale » aux commandes Glovo (2026-08-17).
-- Nécessite la migration 0023 (colonne `categories.partenaires`).
-- Idempotent.
SET client_encoding TO 'UTF8';

UPDATE categories
   SET partenaires = ARRAY['GLOVO']
 WHERE nom = 'Glovo spéciale';

-- Contrôle : seule « Glovo spéciale » doit être restreinte.
SELECT nom, ordre, actif, partenaires
  FROM categories
 WHERE partenaires IS NOT NULL
 ORDER BY nom;
