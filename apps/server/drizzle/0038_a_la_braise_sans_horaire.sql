-- À la Braise : plus aucune plage horaire sur les catégories.
--
-- Sur place, une catégorie hors de sa plage refusait la vente (« La catégorie
-- … n'est pas disponible à cette heure ») et remettre le plat « disponible »
-- dans Réglages › Plats du jour ne changeait rien : seul le bouton
-- « Réactiver exceptionnellement » rouvrait la catégorie, ce que personne ne
-- trouvait au comptoir. Décision du restaurant : on supprime les horaires.
--
-- Ce qui reste : les JOURS (`jour_semaine`, qui met la sauce du jour en tête
-- de carte) et la disponibilité article par article. Les autres marques
-- gardent leurs horaires — cette migration ne touche qu'À la Braise.
DO $$
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

  -- `disponibilite_forcee` repart à FALSE : sans horaire, une dérogation
  -- posée un soir n'a plus de sens et masquerait le vrai réglage.
  UPDATE categories
  SET heure_debut = NULL,
      heure_fin = NULL,
      disponibilite_forcee = FALSE
  WHERE heure_debut IS NOT NULL
     OR heure_fin IS NOT NULL
     OR disponibilite_forcee;
END $$;
