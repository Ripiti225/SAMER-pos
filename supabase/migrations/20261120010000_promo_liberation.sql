-- ============================================================================
-- PROMO-04 — Libération des réservations de codes promo cartes (règle R9).
--
-- Une réservation garde un code pour une commande qui n'est pas encore
-- encaissée :
--   * SITE : commande envoyée par WhatsApp, pas encore saisie en caisse
--     → libérée après 2 h ;
--   * POS  : code vérifié en caisse, commande pas encore encaissée
--     → libérée après 30 min.
-- Libérer = repasser DISPONIBLE. Le numéro rattaché à l'activation RESTE :
-- le client garde son −20 % pour sa prochaine commande.
--
-- Un code UTILISE ou ANNULE n'est jamais touché : la condition ne vise que
-- RESERVE, dans le même UPDATE, donc un encaissement qui arrive pendant la
-- libération l'emporte ou attend le verrou de ligne.
--
-- Au passage, les essais du site de plus de 7 jours sont effacés : la limite
-- d'essais ne regarde que les 2 dernières heures.
-- Idempotente.
-- ============================================================================

CREATE OR REPLACE FUNCTION promo_liberer_reservations()
RETURNS INTEGER
LANGUAGE plpgsql VOLATILE
SET search_path = public
AS $$
DECLARE
  v_liberes INTEGER;
BEGIN
  UPDATE promo_codes
     SET statut = 'DISPONIBLE', reserve_le = NULL, reserve_source = NULL, reserve_ref = NULL
   WHERE statut = 'RESERVE'
     AND (   (reserve_source = 'SITE' AND reserve_le < now() - interval '2 hours')
          OR (reserve_source = 'POS'  AND reserve_le < now() - interval '30 minutes'));
  GET DIAGNOSTICS v_liberes = ROW_COUNT;

  DELETE FROM promo_essais WHERE essai_le < now() - interval '7 days';

  RETURN v_liberes;
END $$;

REVOKE ALL ON FUNCTION promo_liberer_reservations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION promo_liberer_reservations() TO service_role;

-- `unschedule` lève si le nom n'existe pas, d'où le bloc.
DO $$
BEGIN
  PERFORM cron.unschedule('promo-liberer-reservations');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule('promo-liberer-reservations', '*/5 * * * *', $cron$SELECT promo_liberer_reservations()$cron$);

-- Vérification :
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'promo-liberer-reservations';
--   SELECT status, return_message, start_time FROM cron.job_run_details
--    WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'promo-liberer-reservations')
--    ORDER BY start_time DESC LIMIT 5;
