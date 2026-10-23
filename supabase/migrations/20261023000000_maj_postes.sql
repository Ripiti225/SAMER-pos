-- ════════════════════════════════════════════════════════════════════════════
--  MISE À JOUR À DISTANCE DES POSTES — lot L1 (cloud)
--
--  Plan : docs/PLAN_MAJ_A_DISTANCE.md § 4 ; contrat site ↔ cloud :
--  docs/MAJ_CONTRAT.md. Les paquets eux-mêmes (archive en morceaux, manifeste
--  signé) vivent dans le bucket PRIVÉ `paquets-pos` ; ces tables n'en gardent
--  que la description, le cycle de vie et ce que les sites en ont fait.
--
--  Principe de sécurité, rappelé ici parce que tout en découle : le cloud ne
--  fait PAS foi. Un paquet n'est installé que si sa signature Ed25519 est
--  valide pour la clé publique embarquée dans le lanceur du site. Le cloud
--  revérifie la signature à l'enregistrement (fonction `siege`, action
--  `maj_enregistrer`) pour refuser tôt un paquet abîmé, mais un cloud ou un
--  compte siège compromis ne peut, au pire, que CIBLER une version déjà signée
--  par le propriétaire — jamais en fabriquer une.
--
--  Cinq ajouts :
--    1. `maj_versions`      — une ligne par version publiée (paquet APP) ;
--    2. `maj_dependances`   — une ligne par paquet DEPENDANCES (node_modules),
--                             identifié par l'empreinte du pnpm-lock.yaml ;
--    3. `maj_reglages_site` — type de site, heure, anneau, pause, épinglage,
--                             jetons « installer maintenant » / « réessayer » ;
--    4. `maj_rapports`      — l'historique de ce que chaque site a fait ;
--    5. colonnes `maj_*` de `sites_sante` (bloc `sante.maj` du battement).
--  Plus : le niveau « propriétaire » des comptes du siège, et le bucket.
--
--  À lancer dans pos-samer-cloud. Rejouable sans risque.
-- ════════════════════════════════════════════════════════════════════════════


-- ── 1. Versions publiées ────────────────────────────────────────────────────
--
-- Cycle de vie : BROUILLON (enregistrée, servie à personne) → PILOTE (servie à
-- l'anneau pilote, Angré 7E) → GENERALE (servie à tous). RETIREE à tout moment :
-- plus jamais servie, même à un site épinglé dessus. On ne revient jamais à un
-- numéro inférieur : republier l'ancien code se fait sous un NOUVEAU numéro.
CREATE TABLE IF NOT EXISTS public.maj_versions (
  -- AAAAMMJJnn (2026102401) : le seul champ qu'on compare.
  numero              BIGINT PRIMARY KEY CHECK (numero > 0),
  -- AAAA.MM.JJ-n, pour les humains.
  version             TEXT NOT NULL UNIQUE,
  commit_git          TEXT NOT NULL,
  statut              TEXT NOT NULL DEFAULT 'BROUILLON'
                      CHECK (statut IN ('BROUILLON', 'PILOTE', 'GENERALE', 'RETIREE')),

  -- Texte EXACT de manifeste.json (les octets signés) et sa signature base64.
  -- Recopiés ici pour que `consulter` les rende sans relire le stockage ; le
  -- bucket en garde la copie de référence (contrat § 1).
  manifeste           TEXT NOT NULL,
  signature           TEXT NOT NULL,
  -- Empreinte courte de la clé publique qui a vérifié la signature
  -- (`actuelle` ou `suivante` pendant une rotation).
  cle_empreinte       TEXT,

  -- [{ nom, taille, sha256 }] — copie du manifeste, pour signer les URL sans
  -- reparser le manifeste à chaque consultation.
  morceaux            JSONB NOT NULL,
  taille_octets       BIGINT NOT NULL,
  dependances_empreinte TEXT NOT NULL,
  lanceur_min         INTEGER NOT NULL,
  migrations          JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes               TEXT NOT NULL DEFAULT '',

  publie_le           TIMESTAMPTZ NOT NULL DEFAULT now(),
  publie_par          TEXT,
  publie_par_id       UUID,
  pilote_le           TIMESTAMPTZ,
  generale_le         TIMESTAMPTZ,
  retiree_le          TIMESTAMPTZ,
  retiree_motif       TEXT,
  -- Morceaux effacés du bucket (rétention : 3 dernières versions, plan § 2).
  -- La ligne reste : l'historique des sites y fait référence.
  fichiers_purges_le  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_maj_versions_statut ON public.maj_versions (statut, numero DESC);

COMMENT ON TABLE public.maj_versions IS
  'Versions publiées de l''application des postes (paquets APP signés). Écrite par la fonction `siege` (maj_*), lue par la fonction `maj` (clé de site). RLS forcée sans politique.';


-- ── 2. Paquets de dépendances ───────────────────────────────────────────────
--
-- Rares : un nouveau paquet seulement quand le pnpm-lock.yaml change. Une
-- version APP dit de quelle empreinte elle a besoin ; un site dont
-- `node_modules/.empreinte-deps` est déjà la bonne ne télécharge rien.
CREATE TABLE IF NOT EXISTS public.maj_dependances (
  empreinte       TEXT PRIMARY KEY CHECK (empreinte ~ '^[0-9a-f]{64}$'),
  manifeste       TEXT NOT NULL,
  signature       TEXT NOT NULL,
  cle_empreinte   TEXT,
  morceaux        JSONB NOT NULL,
  taille_octets   BIGINT NOT NULL,
  publie_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
  publie_par      TEXT,
  publie_par_id   UUID,
  fichiers_purges_le TIMESTAMPTZ
);

COMMENT ON TABLE public.maj_dependances IS
  'Paquets DEPENDANCES (node_modules) signés, par empreinte SHA-256 du pnpm-lock.yaml. RLS forcée sans politique.';


-- ── 3. Réglages par site ────────────────────────────────────────────────────
--
-- Une ligne par site. Absente : la fonction `maj` sert les défauts (24h/24,
-- 06:00, anneau général) — un site enrôlé demain n'attend pas qu'on le règle.
CREATE TABLE IF NOT EXISTS public.maj_reglages_site (
  restaurant_id         UUID PRIMARY KEY,
  -- Règle du 21/10/2026 : FERME_LA_NUIT installe au démarrage suivant (filet
  -- à `heure_filet`), H24 installe à `heure_installation` même en service.
  type_site             TEXT NOT NULL DEFAULT 'H24' CHECK (type_site IN ('FERME_LA_NUIT', 'H24')),
  heure_installation    TEXT NOT NULL DEFAULT '06:00' CHECK (heure_installation ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  heure_filet           TEXT NOT NULL DEFAULT '05:00' CHECK (heure_filet ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  anneau                TEXT NOT NULL DEFAULT 'GENERAL' CHECK (anneau IN ('PILOTE', 'GENERAL')),
  -- Pause : le site garde sa version, quoi qu'on publie (travaux, inventaire…).
  pause                 BOOLEAN NOT NULL DEFAULT false,
  -- Épinglage : ce site vise CETTE version et pas la plus récente. Jamais une
  -- version RETIREE ; jamais un retour à un numéro inférieur (le site refuse).
  version_epinglee      BIGINT,
  -- Jetons opaques : le site agit une fois par jeton (il retient le dernier
  -- traité). Un nouveau clic = un nouveau jeton.
  installer_maintenant  TEXT,
  installer_maintenant_le TIMESTAMPTZ,
  reessayer             TEXT,
  reessayer_le          TIMESTAMPTZ,
  maj_le                TIMESTAMPTZ NOT NULL DEFAULT now(),
  maj_par               TEXT
);

COMMENT ON TABLE public.maj_reglages_site IS
  'Réglages de mise à jour par site (console du siège, action maj_reglages_site). RLS forcée sans politique.';


-- ── 4. Comptes rendus des sites ─────────────────────────────────────────────
--
-- Un historique, pas un état : « TÉLÉCHARGEMENT, PRÊT, AVERTI, REPORTÉ,
-- DÉBUT, INSTALLÉ » raconte une installation, et un ECHEC_RETOUR_ARRIERE au
-- milieu dit où chercher. Quelques lignes par site et par version : la table
-- reste petite.
CREATE TABLE IF NOT EXISTS public.maj_rapports (
  id             BIGSERIAL PRIMARY KEY,
  restaurant_id  UUID NOT NULL,
  numero         BIGINT,
  evenement      TEXT NOT NULL CHECK (evenement IN (
                   'TELECHARGEMENT', 'PRET', 'AVERTI', 'REPORTE', 'DEBUT', 'INSTALLE',
                   'ECHEC_RETOUR_ARRIERE', 'REFUSEE', 'BLOQUE', 'ESPACE_INSUFFISANT',
                   'LANCEUR_TROP_ANCIEN', 'SIGNATURE_INVALIDE', 'ERREUR')),
  -- Objet libre ≤ 8 Ko (tronqué par la fonction `maj`).
  detail         JSONB NOT NULL DEFAULT '{}'::jsonb,
  recu_le        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_maj_rapports_site ON public.maj_rapports (restaurant_id, recu_le DESC);
CREATE INDEX IF NOT EXISTS idx_maj_rapports_date ON public.maj_rapports (recu_le DESC);

COMMENT ON TABLE public.maj_rapports IS
  'Comptes rendus de mise à jour envoyés par les sites (fonction `maj`, action `rapporter`). RLS forcée sans politique.';


-- ── RLS : même régime que tout le cloud ─────────────────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['maj_versions', 'maj_dependances', 'maj_reglages_site', 'maj_rapports']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;


-- ── Pré-remplissage des réglages (décisions du 21/10/2026) ──────────────────
--
-- Par CODE de site (`sites_autorises.code`) : le restaurant_id d'un poste est
-- régénéré à sa configuration, le code est ce qui reste stable. Un site pas
-- encore enrôlé n'a pas de ligne — il prendra les défauts, et on le réglera
-- dans la console. ON CONFLICT DO NOTHING : rejouer la migration n'écrase
-- jamais un réglage changé depuis au siège.
--
--   FERME_LA_NUIT (installation au démarrage, filet 05:00) :
--     AL_KAYAN_KMS, SAMER_LAVAGE, SAMER_OASIS
--   H24 à 06:00 :
--     SAMER_PALMERAIE, AL_KAYAN_YOP, SAMER_MAROC, SAMER_ANGRE_7E, ALA_BRAISE
--   Anneau PILOTE : SAMER_ANGRE_7E (pilote de 48 h, décision du 23/10).
INSERT INTO public.maj_reglages_site (restaurant_id, type_site, heure_installation, heure_filet, anneau, maj_par)
SELECT s.restaurant_id,
       CASE WHEN upper(s.code) IN ('AL_KAYAN_KMS', 'SAMER_LAVAGE', 'SAMER_OASIS') THEN 'FERME_LA_NUIT' ELSE 'H24' END,
       '06:00',
       '05:00',
       CASE WHEN upper(s.code) = 'SAMER_ANGRE_7E' THEN 'PILOTE' ELSE 'GENERAL' END,
       'migration 20261023000000'
  FROM public.sites_autorises s
 WHERE upper(s.code) IN ('AL_KAYAN_KMS', 'SAMER_LAVAGE', 'SAMER_OASIS',
                         'SAMER_PALMERAIE', 'AL_KAYAN_YOP', 'SAMER_MAROC', 'SAMER_ANGRE_7E', 'ALA_BRAISE')
ON CONFLICT (restaurant_id) DO NOTHING;


-- ── 5. Battement de cœur : bloc `sante.maj` (contrat § 3) ───────────────────
--
-- Écrites par `sync-pull` dans un second temps, à part du battement de base :
-- tant que cette migration n'est pas passée, le battement de base continue
-- d'arriver (l'écriture des colonnes maj_* échoue seule, sans conséquence).
ALTER TABLE public.sites_sante
  ADD COLUMN IF NOT EXISTS maj_etat                TEXT,
  ADD COLUMN IF NOT EXISTS maj_numero_installe     BIGINT,
  ADD COLUMN IF NOT EXISTS maj_numero_prete        BIGINT,
  ADD COLUMN IF NOT EXISTS maj_installation_prevue TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS maj_report_jusqua       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS maj_derniere_erreur     TEXT,
  ADD COLUMN IF NOT EXISTS maj_espace_libre_mo     INTEGER,
  ADD COLUMN IF NOT EXISTS maj_taille_pgdata_mo    INTEGER,
  -- Sentinelle Grenam : exécutables de 533 504 octets ou `g*.exe` cachés
  -- trouvés par le site. Tout chiffre > 0 est une alerte rouge au siège.
  ADD COLUMN IF NOT EXISTS maj_suspects_grenam     INTEGER,
  -- Écrites par la fonction `maj` à chaque consultation (toutes les 15 min).
  ADD COLUMN IF NOT EXISTS maj_lanceur_numero      INTEGER,
  ADD COLUMN IF NOT EXISTS maj_consulte_le         TIMESTAMPTZ;

COMMENT ON COLUMN public.sites_sante.maj_etat IS
  'A_JOUR | TELECHARGEMENT | PRETE | REPORTEE | INSTALLATION | ECHEC | REFUSEE — déclaré par le site (contrat MAJ § 3).';

-- Le type de retour change : CREATE OR REPLACE ne le permet pas.
DROP FUNCTION IF EXISTS public.siege_sante_sites();

CREATE FUNCTION public.siege_sante_sites()
RETURNS TABLE (
  restaurant_id            UUID,
  code                     TEXT,
  actif                    BOOLEAN,
  dernier_push             TIMESTAMPTZ,
  dernier_pull             TIMESTAMPTZ,
  rejets_24h               BIGINT,
  battement_le             TIMESTAMPTZ,
  version_code             TEXT,
  commit_git               TEXT,
  lignes_en_attente        INTEGER,
  plus_ancienne_en_attente TIMESTAMPTZ,
  dernier_acquittement     TIMESTAMPTZ,
  derniere_descente        TIMESTAMPTZ,
  derniere_erreur          TEXT,
  heure_site               TIMESTAMPTZ,
  maj_etat                 TEXT,
  maj_numero_installe      BIGINT,
  maj_numero_prete         BIGINT,
  maj_installation_prevue  TIMESTAMPTZ,
  maj_report_jusqua        TIMESTAMPTZ,
  maj_derniere_erreur      TEXT,
  maj_espace_libre_mo      INTEGER,
  maj_taille_pgdata_mo     INTEGER,
  maj_suspects_grenam      INTEGER,
  maj_lanceur_numero       INTEGER,
  maj_consulte_le          TIMESTAMPTZ
)
LANGUAGE sql STABLE AS $$
  SELECT s.restaurant_id, s.code, s.actif,
         push.recu_le, pull.recu_le,
         (SELECT count(*) FROM sync_rejets r
           WHERE r.restaurant_id = s.restaurant_id
             AND r.created_at > now() - interval '24 hours'),
         h.recu_le, h.version_code, h.commit_git,
         h.lignes_en_attente, h.plus_ancienne_en_attente,
         h.dernier_acquittement, h.derniere_descente, h.derniere_erreur, h.heure_site,
         h.maj_etat, h.maj_numero_installe, h.maj_numero_prete, h.maj_installation_prevue,
         h.maj_report_jusqua, h.maj_derniere_erreur, h.maj_espace_libre_mo, h.maj_taille_pgdata_mo,
         h.maj_suspects_grenam, h.maj_lanceur_numero, h.maj_consulte_le
  FROM sites_autorises s
  LEFT JOIN LATERAL (
    SELECT j.recu_le FROM sync_journal j
     WHERE j.restaurant_id = s.restaurant_id AND j.type = 'PUSH'
     ORDER BY j.recu_le DESC LIMIT 1
  ) push ON true
  LEFT JOIN LATERAL (
    SELECT j.recu_le FROM sync_journal j
     WHERE j.restaurant_id = s.restaurant_id AND j.type = 'PULL'
     ORDER BY j.recu_le DESC LIMIT 1
  ) pull ON true
  LEFT JOIN sites_sante h ON h.restaurant_id = s.restaurant_id;
$$;


-- ── 6. Le propriétaire, au-dessus d'ADMIN ───────────────────────────────────
--
-- Publier, promouvoir et retirer une version sont réservés au PROPRIÉTAIRE
-- (décision du 23/10/2026, § 7.6 du plan). Les niveaux existants (ADMIN,
-- LECTURE) disent ce qu'un compte voit et écrit dans les données ; être le
-- propriétaire est une autre question, d'où un drapeau à part plutôt qu'un
-- troisième niveau qui obligerait à revoir chaque `exigeAdmin` de la fonction
-- `siege`. Un compte propriétaire doit AUSSI être ADMIN (vérifié par
-- `exigeProprietaire`). Personne ne l'est par défaut : voir « APRÈS CETTE
-- MIGRATION ».
ALTER TABLE public.siege_utilisateurs
  ADD COLUMN IF NOT EXISTS proprietaire BOOLEAN NOT NULL DEFAULT false;


-- ── 7. Bucket privé des paquets ─────────────────────────────────────────────
--
-- Créé ici plutôt qu'à la volée (comme `photos`) : il est PRIVÉ, et un oubli
-- de l'option `public: false` à la création exposerait les paquets. Les sites
-- n'y lisent qu'à travers des URL signées d'une heure (fonction `maj`) ; le
-- poste de publication n'y écrit qu'à travers des URL de téléversement signées
-- (fonction `siege`). Limite par objet : 50 Mo (morceaux de 40 Mo).
-- Sauté sans erreur hors Supabase (base de test sans schéma `storage`).
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit)
    VALUES ('paquets-pos', 'paquets-pos', false, 52428800)
    ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 52428800;
  END IF;
END $$;


-- ════════════════════════════════════════════════════════════════════════════
--  APRÈS CETTE MIGRATION
--
--  1. Désigner le propriétaire (remplacer l'adresse) :
--       UPDATE siege_utilisateurs SET proprietaire = true, niveau = 'ADMIN'
--        WHERE user_id = (SELECT id FROM auth.users WHERE email = 'proprietaire@exemple.ci');
--  2. Secret de la fonction `siege` : MAJ_CLE_PUBLIQUE = forme courte (base64
--     des 32 octets) imprimée par `scripts/maj/generer-cle.mjs`. Facultatif
--     pendant une rotation : MAJ_CLE_PUBLIQUE_SUIVANTE.
--  3. Déployer `maj`, `sync-pull` et `siege`, puis la console.
--
--  Vérifications :
--    SELECT s.code, r.* FROM maj_reglages_site r
--      JOIN sites_autorises s USING (restaurant_id) ORDER BY s.code;
--    SELECT id, public, file_size_limit FROM storage.buckets WHERE id = 'paquets-pos';
--    SELECT code, maj_etat, maj_numero_installe FROM siege_sante_sites();
-- ════════════════════════════════════════════════════════════════════════════
