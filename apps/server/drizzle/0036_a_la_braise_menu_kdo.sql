-- Ajustements demandés uniquement pour À la Braise.
-- Cette migration complète aussi une base déjà en service, sur laquelle le
-- profil complet ne peut plus être réimporté dès qu'une commande existe.
DO $$
DECLARE
  zone_rc UUID;
  categorie_barbecues UUID;
  categorie_kedjenou UUID;
  categorie_assiettes UUID;
  article_demi_lapin UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM restaurant
    WHERE marque = 'A_LA_BRAISE'
       OR code IN ('ALA_BRAISE', 'A_LA_BRAISE_CHEZ_MAPAU')
       OR lower(nom) LIKE '%braise%'
  ) THEN
    RETURN;
  END IF;

  -- Les menus du jour restent commandables jusqu'à minuit.
  UPDATE categories
  SET heure_debut = '10:00', heure_fin = '00:00'
  WHERE nom LIKE 'Sauces%';

  -- Placali et Cabato sont maintenant servis de minuit à 16 h.
  UPDATE categories
  SET heure_debut = '00:00', heure_fin = '16:00'
  WHERE nom = 'Placali et Cabato';

  -- Comme dans les autres restaurants, KDO est une table virtuelle de la zone RC.
  SELECT id INTO zone_rc
  FROM zones
  WHERE upper(trim(nom)) = 'RC'
  ORDER BY ordre, nom
  LIMIT 1;

  IF zone_rc IS NULL THEN
    SELECT id INTO zone_rc FROM zones ORDER BY ordre, nom LIMIT 1;
  END IF;

  IF zone_rc IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM tables_salle WHERE zone_id = zone_rc AND numero = 'KDO') THEN
      UPDATE tables_salle
      SET partenaire = 'KDO'
      WHERE zone_id = zone_rc AND numero = 'KDO';
    ELSIF EXISTS (SELECT 1 FROM tables_salle WHERE partenaire = 'KDO') THEN
      UPDATE tables_salle
      SET zone_id = zone_rc, numero = 'KDO'
      WHERE partenaire = 'KDO';
    ELSE
      INSERT INTO tables_salle (zone_id, numero, partenaire)
      VALUES (zone_rc, 'KDO', 'KDO');
    END IF;
  END IF;

  -- Ajout au barbecue, avec le même visuel que l'autre produit lapin.
  SELECT id INTO categorie_barbecues
  FROM categories
  WHERE nom = 'Barbecues'
  LIMIT 1;

  IF categorie_barbecues IS NOT NULL THEN
    UPDATE articles
    SET prix_base = 10000, actif = TRUE
    WHERE nom = 'Lapin braisé';

    SELECT id INTO article_demi_lapin
    FROM articles
    WHERE nom = 'Demi lapin braisé'
    LIMIT 1;

    IF article_demi_lapin IS NULL THEN
      INSERT INTO articles (categorie_id, nom, prix_base, image_url, disponible, actif)
      VALUES (
        categorie_barbecues,
        'Demi lapin braisé',
        6000,
        '/catalogue/a-la-braise/lapin-braise.webp',
        TRUE,
        TRUE
      )
      RETURNING id INTO article_demi_lapin;

      INSERT INTO disponibilite_locale (article_id, disponible)
      VALUES (article_demi_lapin, TRUE)
      ON CONFLICT (article_id) DO NOTHING;
    ELSE
      UPDATE articles
      SET categorie_id = categorie_barbecues,
          prix_base = 6000,
          image_url = COALESCE(image_url, '/catalogue/a-la-braise/lapin-braise.webp'),
          actif = TRUE
      WHERE id = article_demi_lapin;
    END IF;
  END IF;

  -- Le lapin entier en kedjenou passe à 10 000 F.
  UPDATE articles
  SET prix_base = 10000, actif = TRUE
  WHERE nom = 'Kedjenou de lapin — entier';

  -- Nouveaux plats demandés dans la rubrique Kedjenou. La soupe existante
  -- est déplacée depuis Assiettes afin de ne pas créer un doublon de produit.
  SELECT id INTO categorie_kedjenou
  FROM categories
  WHERE nom = 'Kedjenou'
  LIMIT 1;

  IF categorie_kedjenou IS NOT NULL THEN
    UPDATE articles
    SET categorie_id = categorie_kedjenou, prix_base = 7000, actif = TRUE
    WHERE nom = 'Soupe de machoiron';
    IF NOT FOUND THEN
      INSERT INTO articles (categorie_id, nom, prix_base, disponible, actif)
      VALUES (categorie_kedjenou, 'Soupe de machoiron', 7000, TRUE, TRUE);
    END IF;

    UPDATE articles
    SET categorie_id = categorie_kedjenou, prix_base = 2000, actif = TRUE
    WHERE nom = 'Salade classique';
    IF NOT FOUND THEN
      INSERT INTO articles (categorie_id, nom, prix_base, disponible, actif)
      VALUES (categorie_kedjenou, 'Salade classique', 2000, TRUE, TRUE);
    END IF;

    UPDATE articles
    SET categorie_id = categorie_kedjenou, prix_base = 3000, actif = TRUE
    WHERE nom = 'Salade composée';
    IF NOT FOUND THEN
      INSERT INTO articles (categorie_id, nom, prix_base, disponible, actif)
      VALUES (categorie_kedjenou, 'Salade composée', 3000, TRUE, TRUE);
    END IF;
  END IF;

  -- Les spaghetti sont ajoutés aux Assiettes, uniquement sur ce site.
  SELECT id INTO categorie_assiettes
  FROM categories
  WHERE nom = 'Assiettes'
  LIMIT 1;

  IF categorie_assiettes IS NOT NULL THEN
    UPDATE articles
    SET categorie_id = categorie_assiettes, prix_base = 3000, actif = TRUE
    WHERE nom = 'Spaghetti bolognaise';
    IF NOT FOUND THEN
      INSERT INTO articles (categorie_id, nom, prix_base, disponible, actif)
      VALUES (categorie_assiettes, 'Spaghetti bolognaise', 3000, TRUE, TRUE);
    END IF;
  END IF;

  INSERT INTO disponibilite_locale (article_id, disponible)
  SELECT id, TRUE
  FROM articles
  WHERE nom IN ('Soupe de machoiron', 'Salade classique', 'Salade composée', 'Spaghetti bolognaise')
  ON CONFLICT (article_id) DO NOTHING;
END $$;
