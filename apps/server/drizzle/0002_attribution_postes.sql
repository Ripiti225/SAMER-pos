-- ============================================================================
-- CORRECTION 4 (retours terrain) — Attribution automatique par poste
-- ============================================================================

-- Correspondance poste de cuisine ↔ catégorie d'articles :
-- ex. Pizzas → PIZZAIOLO, Boissons → COMPTOIRISTE, le reste → CUISINIER.
CREATE TABLE mapping_poste_categorie (
  poste_cuisine  poste_cuisine NOT NULL,
  categorie_id   UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (poste_cuisine, categorie_id)
);

-- Attribution d'un plat préparé aux employés du poste correspondant qui sont
-- en poste (pointés) au moment de la préparation. Collective si plusieurs.
-- Vide si personne du poste n'est pointé — n'empêche jamais le service.
ALTER TABLE commande_items ADD COLUMN attribue_a UUID[] NOT NULL DEFAULT '{}';
