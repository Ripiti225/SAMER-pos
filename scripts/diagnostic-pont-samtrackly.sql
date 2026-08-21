-- ════════════════════════════════════════════════════════════════════════════
--  DIAGNOSTIC — pourquoi les shifts n'arrivent pas dans SamerTrackly
--
--  À exécuter dans le SQL Editor du CLOUD POS (pas SamerTrackly).
--  Ne modifie AUCUNE donnée : il crée une fonction de lecture et l'appelle.
--
--  Le résultat sort en LIGNES, pas en messages : l'éditeur SQL de Supabase
--  n'affiche pas les `RAISE NOTICE`, il se contente de « Success, no rows
--  returned » — un diagnostic invisible ne diagnostique rien.
--
--  Lis la colonne `verdict` : la première ligne « ✗ BLOQUE » est la cause.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION diagnostic_pont_samtrackly()
RETURNS TABLE (etape TEXT, verdict TEXT, detail TEXT)
LANGUAGE plpgsql AS $fn$
DECLARE
  v_n     BIGINT;
  v_n2    BIGINT;
  v_txt   TEXT;
  v_rec   RECORD;
  v_stop  BOOLEAN := FALSE;
BEGIN
  -- ── 1. La migration est-elle passée ? ────────────────────────────────────
  FOREACH v_txt IN ARRAY ARRAY['samtrackly_pont_config', 'samtrackly_transferts', 'services_caisse']
  LOOP
    IF to_regclass('public.' || v_txt) IS NULL THEN
      RETURN QUERY SELECT '1. tables'::TEXT, '✗ BLOQUE'::TEXT,
        format('table %s ABSENTE — relance 20260817140000_pont_samtrackly.sql et regarde si elle lève une erreur', v_txt);
      v_stop := TRUE;
    ELSE
      RETURN QUERY SELECT '1. tables'::TEXT, 'ok'::TEXT, format('%s présente', v_txt);
    END IF;
  END LOOP;
  IF v_stop THEN RETURN; END IF;

  -- ── 2. Y a-t-il quelque chose à transférer ? ──────────────────────────────
  EXECUTE 'SELECT COUNT(*) FROM services_caisse' INTO v_n;
  EXECUTE $q$SELECT COUNT(*) FROM services_caisse WHERE statut = 'CLOTURE'$q$ INTO v_n2;

  IF v_n2 = 0 THEN
    RETURN QUERY SELECT '2. services'::TEXT, '✗ BLOQUE'::TEXT,
      format('%s service(s) montés, AUCUN clôturé. Le pont n''a rien à transférer : '
          || 'le mini-PC a-t-il vidé son sync_outbox ? le shift a-t-il été clôturé par « J''ai fini » ?', v_n);
    RETURN;
  END IF;

  RETURN QUERY SELECT '2. services'::TEXT, 'ok'::TEXT,
    format('%s service(s) montés, dont %s clôturé(s)', v_n, v_n2);

  FOR v_rec IN EXECUTE $q$
    SELECT restaurant_id::TEXT AS site, statut, COUNT(*) AS n,
           MIN(ouvert_le)::date AS du, MAX(ouvert_le)::date AS au
      FROM services_caisse GROUP BY restaurant_id, statut ORDER BY statut, COUNT(*) DESC
  $q$ LOOP
    RETURN QUERY SELECT '2. services'::TEXT, 'info'::TEXT,
      format('site %s · %s · %s service(s) · journées du %s au %s',
             v_rec.site, v_rec.statut, v_rec.n, v_rec.du, v_rec.au);
  END LOOP;

  -- ── 3. La reprise est-elle configurée ? ───────────────────────────────────
  EXECUTE 'SELECT COUNT(*) FROM samtrackly_pont_config' INTO v_n;
  IF v_n = 0 THEN
    RETURN QUERY SELECT '3. reprise'::TEXT, '✗ BLOQUE'::TEXT,
      'samtrackly_pont_config est VIDE : aucun site ne transfère. C''est volontaire — '
      || 'sans journée de reprise, le pont déverserait l''historique sur des journées déjà saisies à la main.';
    RETURN QUERY SELECT '3. reprise'::TEXT, 'à faire'::TEXT,
      'INSERT INTO samtrackly_pont_config (restaurant_id, samtrackly_id, transferer_depuis, note) '
      || 'VALUES (''<UUID du site, voir étape 2>'', ''2f09688d-a4b9-4b14-8c45-943543953379'', '
      || '''2026-08-17'', ''Reprise POS le 17/08 - Angre 7E'');';
    RETURN;
  END IF;

  FOR v_rec IN EXECUTE $q$
    SELECT c.restaurant_id::TEXT AS site, c.samtrackly_id::TEXT AS st,
           c.transferer_depuis, c.actif,
           (SELECT COUNT(*) FROM services_caisse s
             WHERE s.restaurant_id = c.restaurant_id AND s.statut = 'CLOTURE'
               AND s.ouvert_le::date >= c.transferer_depuis) AS eligibles
      FROM samtrackly_pont_config c
  $q$ LOOP
    RETURN QUERY SELECT '3. reprise'::TEXT,
      (CASE WHEN v_rec.eligibles = 0 THEN '⚠ vide' WHEN v_rec.actif THEN 'ok' ELSE '⚠ inactif' END)::TEXT,
      format('site %s → ST %s · depuis %s · actif=%s · %s service(s) éligible(s)%s',
             v_rec.site, v_rec.st, v_rec.transferer_depuis, v_rec.actif, v_rec.eligibles,
             CASE WHEN v_rec.eligibles = 0
                  THEN ' — la journée de reprise est postérieure à tous les shifts clôturés' ELSE '' END);
  END LOOP;

  -- ── 4. Le cron est-il en place, et appelable ? ────────────────────────────
  IF to_regclass('cron.job') IS NULL THEN
    RETURN QUERY SELECT '4. cron'::TEXT, '✗ BLOQUE'::TEXT, 'extension pg_cron absente';
    RETURN;
  END IF;

  EXECUTE $q$SELECT COUNT(*) FROM cron.job WHERE jobname = 'pont-samtrackly'$q$ INTO v_n;
  IF v_n = 0 THEN
    RETURN QUERY SELECT '4. cron'::TEXT, '✗ BLOQUE'::TEXT,
      'tâche « pont-samtrackly » absente : la section 3 de la migration ne s''est pas exécutée';
    RETURN;
  END IF;

  FOR v_rec IN EXECUTE $q$SELECT schedule, active FROM cron.job WHERE jobname = 'pont-samtrackly'$q$
  LOOP
    RETURN QUERY SELECT '4. cron'::TEXT, (CASE WHEN v_rec.active THEN 'ok' ELSE '✗ BLOQUE' END)::TEXT,
      format('tâche présente · %s · active=%s', v_rec.schedule, v_rec.active);
  END LOOP;

  -- Les deux secrets du cron vivent dans le Vault. `ALTER DATABASE ... SET` est
  -- refusé sur Supabase (42501) et aurait laissé la clé en clair de toute façon.
  IF to_regclass('vault.decrypted_secrets') IS NULL THEN
    RETURN QUERY SELECT '4. cron'::TEXT, '✗ BLOQUE'::TEXT,
      'extension supabase_vault absente : CREATE EXTENSION IF NOT EXISTS supabase_vault;';
    RETURN;
  END IF;

  FOREACH v_txt IN ARRAY ARRAY['pont_url', 'pont_cle']
  LOOP
    EXECUTE format(
      $q$SELECT COALESCE(length(decrypted_secret), 0) FROM vault.decrypted_secrets WHERE name = %L$q$,
      v_txt) INTO v_n;
    IF v_n IS NULL OR v_n = 0 THEN
      RETURN QUERY SELECT '4. cron'::TEXT, '✗ BLOQUE'::TEXT,
        format('secret « %s » absent du Vault — le cron appelle dans le vide toutes les 5 min, '
            || 'en silence. Pose-le : SELECT vault.create_secret(''<valeur>'', ''%s'');', v_txt, v_txt);
      v_stop := TRUE;
    ELSE
      RETURN QUERY SELECT '4. cron'::TEXT, 'ok'::TEXT,
        format('secret « %s » présent (%s caractères)', v_txt, v_n);
    END IF;
  END LOOP;

  -- Une clé service_role est un JWT (deux points) ou commence par sb_secret_.
  -- Un fragment collé à la main donnerait un 401 qu'on chercherait ailleurs.
  EXECUTE $q$SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pont_cle'$q$ INTO v_txt;
  IF v_txt IS NOT NULL AND v_txt <> ''
     AND NOT (v_txt LIKE 'sb_secret_%' OR length(v_txt) - length(replace(v_txt, '.', '')) = 2) THEN
    RETURN QUERY SELECT '4. cron'::TEXT, '⚠ suspect'::TEXT,
      'la clé « pont_cle » n''a ni deux points (JWT) ni le préfixe sb_secret_ : '
      || 'vérifie qu''elle a été copiée en ENTIER depuis Settings → API.';
  END IF;

  IF v_stop THEN RETURN; END IF;

  -- ── 5. Qu'a répondu le cron ? ─────────────────────────────────────────────
  IF to_regclass('cron.job_run_details') IS NULL THEN
    RETURN QUERY SELECT '5. passages'::TEXT, 'info'::TEXT, 'historique du cron indisponible sur ce projet';
  ELSE
    EXECUTE $q$SELECT COUNT(*) FROM cron.job_run_details d
                 JOIN cron.job j ON j.jobid = d.jobid
                WHERE j.jobname = 'pont-samtrackly'$q$ INTO v_n;
    IF v_n = 0 THEN
      RETURN QUERY SELECT '5. passages'::TEXT, '⚠ jamais'::TEXT,
        'le cron n''a jamais tourné — attends 5 min, ou déclenche à la main (dernière ligne)';
    ELSE
      FOR v_rec IN EXECUTE $q$
        SELECT d.start_time, d.status, COALESCE(d.return_message, '') AS msg
          FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
         WHERE j.jobname = 'pont-samtrackly' ORDER BY d.start_time DESC LIMIT 5
      $q$ LOOP
        RETURN QUERY SELECT '5. passages'::TEXT,
          (CASE WHEN v_rec.status = 'succeeded' THEN 'ok' ELSE '✗ ' || v_rec.status END)::TEXT,
          format('%s · %s', v_rec.start_time, left(v_rec.msg, 200));
      END LOOP;
    END IF;
  END IF;

  -- ── 6. Le pont a-t-il essayé, et échoué ? ─────────────────────────────────
  EXECUTE 'SELECT COUNT(*) FROM samtrackly_transferts' INTO v_n;
  IF v_n = 0 THEN
    RETURN QUERY SELECT '6. transferts'::TEXT, '⚠ aucun'::TEXT,
      'aucune tentative enregistrée : la fonction n''a jamais été atteinte, ou elle n''a trouvé '
      || 'aucun service éligible (voir étape 3). Vérifie le déploiement : supabase functions list';
  ELSE
    FOR v_rec IN EXECUTE $q$
      SELECT COUNT(*) FILTER (WHERE transfere_le IS NOT NULL) AS ok,
             COUNT(*) FILTER (WHERE transfere_le IS NULL)     AS ko,
             COALESCE(MAX(derniere_erreur) FILTER (WHERE transfere_le IS NULL), '') AS err
        FROM samtrackly_transferts
    $q$ LOOP
      RETURN QUERY SELECT '6. transferts'::TEXT,
        (CASE WHEN v_rec.ko > 0 THEN '✗ échecs' ELSE 'ok' END)::TEXT,
        format('%s réussi(s), %s en échec%s', v_rec.ok, v_rec.ko,
               CASE WHEN v_rec.err <> '' THEN ' · dernière erreur : ' || v_rec.err ELSE '' END);
    END LOOP;
  END IF;

  RETURN QUERY SELECT '7. manuel'::TEXT, 'commande'::TEXT,
    'SELECT net.http_post('
    || 'url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''pont_url'') '
    || '|| ''/samtrackly-points'', '
    || 'headers := jsonb_build_object(''Content-Type'', ''application/json'', ''Authorization'', '
    || '''Bearer '' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = ''pont_cle'')), '
    || 'body := ''{}''::jsonb);';
END $fn$;

-- ── Le rapport ──────────────────────────────────────────────────────────────
SELECT * FROM diagnostic_pont_samtrackly();
