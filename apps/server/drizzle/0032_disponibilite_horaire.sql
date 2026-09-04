ALTER TABLE categories
  ADD COLUMN heure_debut TIME,
  ADD COLUMN heure_fin TIME,
  ADD COLUMN disponibilite_forcee BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN jour_semaine SMALLINT CHECK (jour_semaine BETWEEN 1 AND 7),
  ADD CONSTRAINT categories_horaires_coherents
    CHECK ((heure_debut IS NULL) = (heure_fin IS NULL));
