-- ===========================================================================
--  PRÉPARATION DE LA BASE MASTER AVANT COPIE SUR LES 7 RESTAURANTS
--
--  Le dossier portable est dupliqué tel quel (data/pgdata compris) : tout ce
--  qui reste ici se retrouve sur CHAQUE site. Ce script retire donc l'identité
--  et l'activité du restaurant sur lequel le master a été utilisé (Angré 7E),
--  et ne garde que ce qui est réutilisable partout.
--
--  CONSERVÉ  : catalogue (catégories, articles, options, suppléments, combos,
--              prix par canal, promotions), plan de salle (zones, tables),
--              routage d'impression, rôles & permissions, calibration
--              d'impression (largeur 42 colonnes, logo en mode bandes).
--  EFFACÉ    : ventes et tout l'historique, file de synchro, journal d'audit,
--              équipe (sauf le propriétaire), identité du restaurant, NOMS
--              d'imprimante et pied de ticket (propres au poste / à la marque).
--
--  À lancer APP FERMÉE (PosSamer.exe quitté), après une sauvegarde :
--    pg_dump -d postgres://postgres@localhost:5432/pos_samer -F c -f sauvegarde.dump
--  Puis :
--    psql -d postgres://postgres@localhost:5432/pos_samer -f preparer-base-master.sql
-- ===========================================================================

-- ---------------------------------------------------------------------------
--  GARDE-FOU : base LOCALE uniquement.
--
--  Ce script purge les ventes, l'équipe et l'identité. Sur la base CLOUD, il
--  ferait la même chose pour les 7 restaurants À LA FOIS. Le 2026-08-18 il a
--  été lancé par erreur dans l'éditeur SQL Supabase ; il s'est arrêté seul sur
--  `appels_table` (table locale absente du cloud), donc sans rien effacer — la
--  transaction n'a jamais atteint son COMMIT. On ne compte pas sur ce hasard
--  une deuxième fois : ici le refus est explicite et vient AVANT tout DELETE.
-- ---------------------------------------------------------------------------
DO $garde$
BEGIN
  IF to_regclass('public.sites_autorises') IS NOT NULL THEN
    RAISE EXCEPTION
      'REFUS : cette base est le CLOUD (table sites_autorises présente). '
      'Ce script ne se lance que sur la base locale d''un poste. Base : %',
      current_database();
  END IF;
  IF to_regclass('public.restaurant')   IS NULL
  OR to_regclass('public.appels_table') IS NULL
  OR to_regclass('public.sync_outbox')  IS NULL THEN
    RAISE EXCEPTION
      'REFUS : ce n''est pas une base POS locale complète (tables manquantes). '
      'Base : %', current_database();
  END IF;
END
$garde$;

BEGIN;

-- 1) Activité commerciale. L'ordre respecte les clés étrangères.
DELETE FROM paiements;
DELETE FROM notes_split;
DELETE FROM commande_items;
DELETE FROM appels_table;
DELETE FROM notations;
-- `points_fidelite` référence `commandes` : elle doit partir AVANT. Cette ligne
-- vivait au bloc 2 et n'avait jamais bloqué — la base de test n'avait aucun
-- point de fidélité. Constaté le 2026-08-18 sur une base qui en avait : le
-- script échouait alors en entier (violation de clé étrangère), donc sans effet.
DELETE FROM points_fidelite;
DELETE FROM commandes;
DELETE FROM equipe_service;
DELETE FROM services_caisse;
DELETE FROM sequences_caisse;

-- 2) Fidélité : les clients appartiennent au restaurant qui les a inscrits.
--    `points_fidelite` est déjà partie au bloc 1 (elle dépend de `commandes`) ;
--    `clients_fidelite` doit venir APRÈS `commandes`, qui la référence par
--    `commandes.client_fidelite_id`.
DELETE FROM clients_fidelite;

-- 2bis) Inventaire de service et dépenses. Ces tables sont arrivées APRÈS la
--    première version de ce script, mais elles étaient déjà couvertes sans
--    qu'on l'ait écrit : `inventaires_service` et `depenses` sont en
--    ON DELETE CASCADE sur `services_caisse`, donc le DELETE du bloc 1 les
--    emporte (vérifié le 2026-08-17 : ces quatre DELETE suppriment 0 ligne sur
--    une base fraîchement purgée par le bloc 1).
--
--    On les écrit quand même, pour deux raisons : la couverture ne doit pas
--    dépendre d'une cascade qu'un futur changement de clé étrangère pourrait
--    retirer en silence, et le bloc de contrôle final vérifie désormais ces
--    compteurs explicitement.
--
--    ATTENTION à ne PAS toucher :
--      * `produits_inventaire`      = catalogue des produits à compter
--      * `inventaire_consommations` = recettes (ce qu'un plat consomme)
--    Ce sont des RÉGLAGES, réutilisables partout. Les effacer casserait le
--    calcul d'écart d'inventaire sur les 7 restaurants.
DELETE FROM entrees_stock;
DELETE FROM inventaire_lignes;
DELETE FROM inventaires_service;
DELETE FROM depenses;

-- 3) File de synchro et état associé. Sans ça, l'activité du 7E remonterait au
--    cloud sous l'identité du nouveau site dès son enrôlement.
DELETE FROM sync_outbox;
DELETE FROM actions_recues;
DELETE FROM sync_etat;

-- 4) Journal d'audit : protégé par le trigger append-only `audit_immutable`,
--    que l'on désactive le temps de la purge puis que l'on REMET (il fait
--    partie des garanties du cahier des charges).
ALTER TABLE audit_log DISABLE TRIGGER audit_immutable;
DELETE FROM audit_log;
ALTER TABLE audit_log ENABLE TRIGGER audit_immutable;

-- 5) Sessions ouvertes et équipe : chaque restaurant crée la sienne. Seuls les
--    comptes PROPRIETAIRE sont conservés — SAMER Zreik (le patron) et Admin
--    Willy (l'administrateur qui installe et dépanne) — pour pouvoir se
--    connecter et configurer le site. Le filtre porte sur le RÔLE, donc les
--    deux passent : ne le remplacez pas par un LIMIT 1.
DELETE FROM sessions;
DELETE FROM utilisateurs
 WHERE role_id NOT IN (SELECT id FROM roles WHERE nom = 'PROPRIETAIRE');

-- 6) Identité : remise à neutre. `enroler-site.ts` refuse un poste encore en
--    A_CONFIGURER, ce qui FORCE le passage par Réglages → Restaurant sur chaque
--    site — et c'est ce passage qui régénère un `restaurant.id` unique.
UPDATE restaurant
   SET code = 'A_CONFIGURER',
       nom = 'Restaurant à configurer',
       marque = 'SAMER';

-- 7) Paramètres propres au site précédent. La CALIBRATION d'impression reste
--    (42 colonnes, logo en bandes) : même modèle de matériel partout. En
--    revanche les NOMS d'imprimante sont ceux du poste où le master a servi
--    (ex. « WOOSIM WSP-CP383 », « KITCHEN ») et n'existent sur aucun autre PC :
--    les laisser donnerait une caisse qui se croit configurée et n'imprime
--    rien. Vidés → repli console jusqu'à Réglages → Imprimantes (étape 5 de
--    l'installation). Le pied de ticket parle de « chez Samer » : il est vidé
--    lui aussi, sans quoi un site Al Kayan imprimerait le nom de l'autre marque.
DELETE FROM parametres_locaux
 WHERE cle IN ('samtrackly_restaurant_id', 'kds_jeton_appareil', 'cle_site', 'supabase_sync_url');
UPDATE parametres_locaux SET valeur = '""'
 WHERE cle IN ('ticket_entete', 'ticket_pied',
               'imprimante_thermique_queue', 'imprimante_poste_caisse',
               'imprimante_poste_cuisine', 'imprimante_poste_bar');

-- 8) Compteurs. Les DELETE ci-dessus ne touchent PAS les séquences : sans ce
--    bloc, le premier ticket de CHAQUE restaurant reprend le compteur du poste
--    de test (constaté le 2026-08-13 : `seq_numero_ticket` à 13, donc un
--    premier ticket n° 14 sur les 7 sites). Le cahier des charges veut une
--    séquence continue partant de 1.
ALTER SEQUENCE seq_numero_ticket   RESTART WITH 1;
ALTER SEQUENCE audit_log_seq_seq   RESTART WITH 1;
ALTER SEQUENCE sync_outbox_seq_seq RESTART WITH 1;

COMMIT;

-- Contrôle final : tout doit être à 0 sauf le catalogue, la salle et 1 employé.
SELECT
  (SELECT COUNT(*) FROM commandes)     AS commandes,
  (SELECT COUNT(*) FROM paiements)     AS paiements,
  (SELECT COUNT(*) FROM services_caisse) AS shifts,
  (SELECT COUNT(*) FROM inventaires_service) AS inventaires,
  (SELECT COUNT(*) FROM depenses)      AS depenses,
  (SELECT COUNT(*) FROM sync_outbox)   AS outbox,
  (SELECT COUNT(*) FROM audit_log)     AS audit,
  (SELECT COUNT(*) FROM utilisateurs)  AS employes,
  (SELECT COUNT(*) FROM articles)      AS articles,
  (SELECT COUNT(*) FROM tables_salle)  AS tables,
  (SELECT COUNT(*) FROM produits_inventaire) AS produits,
  (SELECT COUNT(*) FROM inventaire_consommations) AS recettes,
  (SELECT code FROM restaurant)        AS identite;

-- Contrôle des compteurs : `last_value` doit être NULL (séquence jamais
-- appelée depuis le RESTART), donc le prochain ticket émis portera le n° 1.
SELECT sequencename, last_value
  FROM pg_sequences
 WHERE sequencename IN ('seq_numero_ticket', 'audit_log_seq_seq', 'sync_outbox_seq_seq')
 ORDER BY sequencename;
