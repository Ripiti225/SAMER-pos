-- ════════════════════════════════════════════════════════════════════════════
--  Pont cloud POS → SamerTrackly
--
--  Le point de shift du caissier n'est plus saisi à la main : il est construit
--  à partir du service de caisse clôturé et déposé dans SamerTrackly.
--
--  Spéc : samtrackly/docs/superpowers/specs/2026-08-17-pos-samer-vers-samtrackly-design.md
--
--  POURQUOI ICI ET PAS SUR LES MINI-PC
--  Un seul déploiement couvre les 7 sites, y compris ceux qui ne sont pas
--  encore enrôlés — ils seront pris automatiquement le jour où ils le seront.
--  Et la clé SamerTrackly reste un secret de fonction : elle ne part pas sur
--  sept machines Windows en restaurant.
--
--  CE FICHIER NE BASCULE AUCUN SITE. Le transfert écrit dans SamerTrackly, mais
--  c'est `restaurants.source_point` CÔTÉ SamerTrackly qui décide si les
--  caissières y saisissent encore. Les deux sont indépendants, volontairement :
--  on veut voir des shifts arriver AVANT de couper la saisie manuelle.
-- ════════════════════════════════════════════════════════════════════════════


-- ── 0. Reprise par site — LA SÉCURITÉ LA PLUS IMPORTANTE DE CE FICHIER ──────
--
-- Ce cloud garde TOUT l'historique des services clôturés. Sans date de départ,
-- le premier passage du pont déverserait des semaines de shifts sur des
-- journées qui ont déjà leurs shifts saisis à la main dans SamerTrackly. Et
-- `pos_service_id` n'y peut rien : un shift manuel et un shift POS décrivant la
-- même période sont deux lignes différentes. La journée serait comptée DEUX
-- FOIS — précisément ce qu'on veut éviter.
--
-- ⚠ SENS DU DÉFAUT : un site absent de cette table ne transfère RIEN.
-- Tant qu'on n'a pas décidé de sa reprise, il reste muet. Ajouter un site ici
-- est un geste délibéré, pas une conséquence d'un déploiement.
CREATE TABLE IF NOT EXISTS samtrackly_pont_config (
  restaurant_id     UUID PRIMARY KEY,
  -- Le restaurant SamerTrackly qui reçoit. Lu ici plutôt que dans `restaurants`
  -- parce que la forme de cette table varie d'un cloud à l'autre.
  samtrackly_id     UUID NOT NULL,
  -- La première JOURNÉE D'EXPLOITATION prise en charge par le POS — donc la
  -- première dont plus aucun shift n'est saisi à la main. Ce n'est pas le jour
  -- où le POS a été installé : les deux peuvent être séparés de semaines.
  --
  -- ⚠ UNE DATE, PAS UN HORODATAGE, et c'est délibéré. Le shift du soir se
  -- clôture après minuit : à Angré 7E, le 16h→00h du 16/08 se clôture le 17 à
  -- 00:00. Une limite posée à une heure précise du 17 l'aurait laissé passer,
  -- et on aurait recréé un shift du 16 — journée déjà saisie à la main et déjà
  -- VALIDÉE par le gérant. La journée d'exploitation est la seule unité qui
  -- corresponde à la façon dont le groupe compte.
  transferer_depuis DATE NOT NULL,
  -- Interrupteur d'arrêt : couper un site sans perdre sa configuration.
  actif             BOOLEAN NOT NULL DEFAULT TRUE,
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE samtrackly_pont_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE samtrackly_pont_config FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE samtrackly_pont_config IS
  'Quels sites transfèrent vers SamerTrackly, et depuis quand. Absent = ne transfère rien.';

-- ⚠ À REMPLIR À LA MAIN, UN SITE À LA FOIS.
--
-- ANGRÉ 7E — journée de reprise : 2026-08-17.
--   Le 16/08 est saisi à la main (3 shifts) et son point est VALIDÉ : il ne doit
--   pas bouger. Le 17/08, le shift 00h→08h a été supprimé à la main par le boss
--   pour être remplacé par celui du POS : cette journée doit donc remonter en
--   entier, shift de nuit compris.
--
--   INSERT INTO samtrackly_pont_config
--     (restaurant_id, samtrackly_id, transferer_depuis, note)
--   VALUES (
--     '<UUID du site dans CE cloud>',
--     '2f09688d-a4b9-4b14-8c45-943543953379',   -- Samer Angré 7E
--     '2026-08-17',
--     'Reprise POS le 17/08. Le 16/08 reste saisi à la main, point validé.'
--   )
--   ON CONFLICT (restaurant_id) DO UPDATE
--     SET samtrackly_id = EXCLUDED.samtrackly_id,
--         transferer_depuis = EXCLUDED.transferer_depuis,
--         actif = TRUE;
--
-- AVANT DE POSER CETTE JOURNÉE, regarder ce qui existe déjà côté SamerTrackly :
--
--   SELECT date, heure_debut, heure_fin, caissier_nom, vente_shift
--     FROM points_shifts
--    WHERE restaurant_id = '<uuid samtrackly>' ORDER BY date DESC LIMIT 10;
--
--   SELECT date, valide FROM points
--    WHERE restaurant_id = '<uuid samtrackly>' ORDER BY date DESC LIMIT 5;
--
-- La journée de reprise doit être STRICTEMENT POSTÉRIEURE à la dernière journée
-- saisie à la main — et jamais une journée dont le point est déjà validé.


-- ── 1. Journal des transferts ───────────────────────────────────────────────
--
-- Une ligne par service de caisse. Elle sert à trois choses : ne pas
-- retransférer, garder la trace de ce qui a été écrit, et rendre visible ce qui
-- échoue — un pont muet qui échoue est pire que pas de pont du tout.
--
-- Table SÉPARÉE de `services_caisse` volontairement : cette dernière est
-- réécrite par UPSERT à chaque montée du site, et on ne veut pas qu'une
-- resynchro puisse effacer la mémoire d'un transfert déjà fait.
CREATE TABLE IF NOT EXISTS samtrackly_transferts (
  service_id      UUID PRIMARY KEY,
  restaurant_id   UUID NOT NULL,
  -- NULL tant que le transfert n'a pas abouti. C'est le seul marqueur de succès.
  transfere_le    TIMESTAMPTZ,
  -- Ce qui a été écrit chez SamerTrackly, pour pouvoir remonter la piste.
  point_id        UUID,
  journee         DATE,
  vente_shift     INTEGER,
  nb_depenses     INTEGER,
  nb_presences    INTEGER,
  -- Les personnes que le pont n'a PAS pu inscrire en présence, parce que leur
  -- fiche RH n'existait pas encore côté SamerTrackly (employé créé directement
  -- sur la caisse, `externe_id` vide). Tableau d'ids d'utilisateurs POS.
  --
  -- Sans cette trace, leur journée de travail et leur paie disparaissaient en
  -- silence : le service était marqué transféré et n'était jamais rejoué. Avec
  -- elle, le pont sait quoi reprendre le jour où la fiche est créée.
  presences_ignorees JSONB,
  -- Diagnostic quand ça coince. `tentatives` monte à chaque passage raté :
  -- au-delà de quelques unités, quelque chose demande un humain.
  tentatives      INTEGER NOT NULL DEFAULT 0,
  derniere_erreur TEXT,
  derniere_tentative TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Colonne ajoutée après coup : le fichier doit rester rejouable sur un cloud où
-- la table a déjà été créée sans elle.
ALTER TABLE samtrackly_transferts
  ADD COLUMN IF NOT EXISTS presences_ignorees JSONB;

-- Les services encore à transférer, c'est-à-dire ceux dont `transfere_le` est
-- NULL. Index partiel : il ne porte que la file d'attente, pas l'historique.
CREATE INDEX IF NOT EXISTS idx_transferts_en_attente
  ON samtrackly_transferts (derniere_tentative NULLS FIRST)
  WHERE transfere_le IS NULL;

CREATE INDEX IF NOT EXISTS idx_transferts_restaurant
  ON samtrackly_transferts (restaurant_id, journee);

COMMENT ON TABLE samtrackly_transferts IS
  'Un service de caisse transféré (ou en échec) vers SamerTrackly. transfere_le NULL = à faire.';

-- RLS forcée sans politique, comme toutes les tables de ce cloud : seul le
-- service_role (donc les Edge Functions) y touche.
ALTER TABLE samtrackly_transferts ENABLE ROW LEVEL SECURITY;
ALTER TABLE samtrackly_transferts FORCE ROW LEVEL SECURITY;


-- ── 2. Vue de suivi ─────────────────────────────────────────────────────────
--
-- Ce que le siège regarde pour savoir si le pont respire, par site. Un
-- restaurant dont `en_attente` grimpe et dont `dernier_transfert` date, c'est
-- un pont cassé — et donc des points de shift qui manquent chez SamerTrackly.
--
-- ⚠ Cette vue ne joint PAS la table `restaurants`, volontairement. Les clouds
-- déployés n'ont pas tous la même forme pour cette table : celle de
-- `20260817000000_siege_console.sql` a `restaurant_id`, mais un cloud où une
-- table `restaurants` existait déjà a gardé l'ancienne — `CREATE TABLE IF NOT
-- EXISTS` ne modifie rien. La vue tombait alors sur « column r.restaurant_id
-- does not exist » et TOUTE la migration s'arrêtait là, cron compris.
-- Un outil de surveillance ne doit pas dépendre de la forme d'une table qu'il
-- ne contrôle pas. Pour afficher le nom du site, joindre `restaurants` au
-- moment de la lecture, avec la clé propre à ce cloud.
CREATE OR REPLACE VIEW v_pont_samtrackly AS
SELECT
  t.restaurant_id,
  COUNT(*) FILTER (WHERE t.transfere_le IS NOT NULL)                    AS transferes,
  COUNT(*) FILTER (WHERE t.transfere_le IS NULL)                        AS en_attente,
  COUNT(*) FILTER (WHERE t.transfere_le IS NULL AND t.tentatives >= 3)  AS bloques,
  COUNT(*) FILTER (WHERE t.presences_ignorees IS NOT NULL
                     AND jsonb_array_length(t.presences_ignorees) > 0)  AS shifts_presences_manquantes,
  MAX(t.transfere_le)                                                   AS dernier_transfert,
  MAX(t.journee)                                                        AS derniere_journee,
  MAX(t.derniere_erreur) FILTER (WHERE t.transfere_le IS NULL)          AS derniere_erreur
FROM samtrackly_transferts t
GROUP BY t.restaurant_id;

COMMENT ON VIEW v_pont_samtrackly IS
  'Santé du pont vers SamerTrackly, par site. en_attente qui grimpe = points de shift manquants.';


-- ── 2 bis. Rejouer un transfert ─────────────────────────────────────────────
--
-- Tout ce que le pont écrit chez SamerTrackly est idempotent : le shift retombe
-- sur `pos_service_id`, les dépenses sur leur UUID du POS, les présences sur le
-- trio (point_id, caissier_id, travailleur_id). **Rejouer un transfert ne crée
-- donc aucun doublon** — il réécrit les mêmes lignes, et ajoute celles qui
-- n'avaient pas pu l'être.
--
-- C'est ce qui rend le rattrapage possible : remettre `transfere_le` à NULL
-- suffit, le cron reprend le service au passage suivant (5 min).
--
-- CAS D'USAGE PRINCIPAL — un extra a travaillé, sa fiche RH n'existait pas, sa
-- présence et sa paie ont été écartées. Le jour où le siège crée sa fiche et
-- que la caisse la relie (`externe_id`), on rejoue les shifts concernés.
-- ⚠ Renvoie le NOMBRE de services remis en file.
-- Première version : `RETURNS INTEGER ... RETURNING 1`. Une fonction SQL qui
-- renvoie un scalaire ne rend que la PREMIÈRE ligne : elle affichait donc « 1 »
-- que l'on rejoue 1 service ou 40, et « NULL » si aucun n'existait. Constaté le
-- 2026-08-20 en rejouant 10 services : le retour disait 1. Un outil de
-- réparation qui ment sur ce qu'il a réparé n'est pas un outil de réparation.
CREATE OR REPLACE FUNCTION rejouer_transferts(p_service_ids UUID[])
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  v_n INTEGER;
BEGIN
  UPDATE samtrackly_transferts
     SET transfere_le = NULL, tentatives = 0, derniere_erreur = NULL
   WHERE service_id = ANY(p_service_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

COMMENT ON FUNCTION rejouer_transferts IS
  'Remet des services en file. Sans danger : toutes les écritures du pont sont idempotentes.';

-- Les shifts où il manque au moins une présence, à rejouer une fois les fiches
-- RH créées :
--
--   SELECT service_id, journee, presences_ignorees
--     FROM samtrackly_transferts
--    WHERE jsonb_array_length(COALESCE(presences_ignorees, '[]'::jsonb)) > 0
--    ORDER BY journee DESC;
--
--   SELECT rejouer_transferts(ARRAY(
--     SELECT service_id FROM samtrackly_transferts
--      WHERE jsonb_array_length(COALESCE(presences_ignorees, '[]'::jsonb)) > 0
--   ));


-- ── 3. Déclenchement toutes les 5 minutes ───────────────────────────────────
--
-- Indépendant de la synchro des sites : même si un mini-PC tombe ou qu'une
-- montée échoue, le pont repasse et rattrape. Un shift arrive donc chez
-- SamerTrackly au plus tard 5 minutes après sa montée dans ce cloud.
--
-- pg_cron et pg_net sont fournis par Supabase ; `CREATE EXTENSION` est
-- idempotent.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Rejouable : on retire la planification précédente avant de la reposer.
-- `unschedule` lève si le nom n'existe pas, d'où le bloc.
DO $$
BEGIN
  PERFORM cron.unschedule('pont-samtrackly');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- ⚠ POURQUOI LE VAULT ET PAS `ALTER DATABASE ... SET`
-- Le cron a besoin de deux valeurs pour s'appeler lui-même : l'URL des
-- fonctions et un jeton. La méthode `ALTER DATABASE postgres SET app.settings.*`
-- que l'on trouve dans beaucoup de tutoriels **échoue sur Supabase** :
--   ERROR 42501: permission denied to set parameter "app.settings.url_fonctions"
-- Le rôle de l'éditeur SQL n'est pas superutilisateur. Et c'est aussi bien : ce
-- réglage aurait stocké une clé service_role en CLAIR, lisible par toute session.
--
-- Le Vault est la méthode de la plateforme, et la clé y est chiffrée au repos.
--
-- ⚠ À FAIRE UNE FOIS, À LA MAIN, AVANT QUE LE CRON SERVE À QUELQUE CHOSE :
--
--   1. Déployer la fonction :
--        supabase functions deploy samtrackly-points
--
--   2. Poser les secrets de la FONCTION (la clé SamerTrackly ne vit QUE là) :
--        supabase secrets set SAMTRACKLY_URL=https://wlwotzxnzowbkbfcpnyi.supabase.co
--        supabase secrets set SAMTRACKLY_KEY=<clé service_role SamerTrackly>
--
--   3. Poser les deux secrets du CRON, dans CE cloud (rejouable) :
--
--        DELETE FROM vault.secrets WHERE name IN ('pont_url', 'pont_cle');
--        SELECT vault.create_secret(
--          'https://<REF-DU-CLOUD-POS>.functions.supabase.co', 'pont_url',
--          'Base des Edge Functions, pour que le cron appelle le pont');
--        SELECT vault.create_secret(
--          '<clé service_role de CE cloud POS>', 'pont_cle',
--          'Jeton présenté par le cron au pont SamerTrackly');
--
--      Vérifier sans révéler les valeurs :
--        SELECT name, created_at FROM vault.secrets ORDER BY name;
--
--   4. Vérifier l'ensemble : scripts/diagnostic-pont-samtrackly.sql
SELECT cron.schedule(
  'pont-samtrackly',
  '*/5 * * * *',
  $cron$
  SELECT net.http_post(
    url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pont_url')
               || '/samtrackly-points',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' ||
        (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pont_cle')
    ),
    body    := '{"origine":"cron"}'::jsonb,
    timeout_milliseconds := 55000
  );
  $cron$
);


-- ── 4. Vérification ─────────────────────────────────────────────────────────
--
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'pont-samtrackly';
--   SELECT * FROM v_pont_samtrackly ORDER BY nom;
--
-- Et côté SamerTrackly, la requête de feu vert (section 6 de
-- supabase_pos_bascule.sql) doit commencer à voir des shifts arriver du POS.
-- Tant qu'elle affiche shifts_du_pos = 0, aucun site ne doit être basculé.
