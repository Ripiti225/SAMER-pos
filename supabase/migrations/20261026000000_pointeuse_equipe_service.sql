-- Pointeuse Hikvision (2026-10-26) : l'équipe d'un service porte désormais,
-- sur le site, l'heure de SORTIE pointée, les absences du shift et l'origine
-- de l'arrivée. Elles remontent pour que SamerTrackly reçoive les heures
-- RÉELLES de chacun (et non plus celles du shift) et que le siège voie les
-- absences, que SamerTrackly n'a pas de colonne pour recevoir.
--
-- ⚠ À appliquer AVANT de déployer sync-push : sa liste blanche nomme ces
-- colonnes, et une colonne absente ici ferait échouer l'upsert — donc geler
-- la remontée du site, ventes comprises.
ALTER TABLE equipe_service ADD COLUMN IF NOT EXISTS depart_le        TIMESTAMPTZ;
ALTER TABLE equipe_service ADD COLUMN IF NOT EXISTS secondes_absence INTEGER;
-- POINTEUSE / CAISSE (secours PIN manager) / OUVERTURE (ancien fonctionnement)
ALTER TABLE equipe_service ADD COLUMN IF NOT EXISTS source           TEXT;
