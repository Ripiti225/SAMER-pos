-- ============================================================================
-- ALLÈGEMENT — retrait du pointage (géoloc/SMS) et de ses paramètres.
-- La présence est désormais gérée par l'« équipe du jour » (equipe_service).
-- ============================================================================

DROP TABLE IF EXISTS codes_pointage;
DROP TABLE IF EXISTS pointages;

-- La permission « Corrections de pointage » disparaît du catalogue.
DELETE FROM role_permissions WHERE permission_cle = 'reglages.pointage';

-- Paramètres devenus inutiles (géoloc + SMS).
DELETE FROM parametres_locaux
WHERE cle IN ('pointage_lat', 'pointage_lng', 'pointage_rayon_metres', 'sms_plafond_mensuel');
