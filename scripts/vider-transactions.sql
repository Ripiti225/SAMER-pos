-- ===========================================================================
--  VIDER LES TRANSACTIONS D'UN POSTE — en gardant les réglages et les comptes
--
--  Usage : remettre un poste à zéro commercialement (fin de tests, reprise
--  d'un site) SANS le reconfigurer. À ne pas confondre avec
--  `preparer-base-master.sql`, qui va bien plus loin : celui-là efface AUSSI
--  l'équipe, l'identité du restaurant et les noms d'imprimante, parce qu'il
--  fabrique une image neutre pour tous les sites.
--
--  EFFACÉ   : commandes, lignes, paiements, notes partagées, notations,
--             appels de table, points de fidélité, services de caisse et leur
--             équipe, séquences de caisse, inventaires de service, entrées de
--             stock, dépenses, file de synchro, journal d'audit, et les trois
--             compteurs repartent à 1.
--
--  CONSERVÉ : comptes et rôles, sessions, TOUS les paramètres locaux
--             (imprimantes, entête/pied de ticket, clé de site, calibration),
--             l'identité du restaurant, le catalogue, le plan de salle, les
--             produits d'inventaire et leurs recettes, et les CLIENTS de
--             fidélité (leurs points repartent de zéro, la fiche client reste).
--
--  À lancer APP FERMÉE (PosSamer.exe quitté), APRÈS une sauvegarde :
--    pg_dump -d postgres://postgres@localhost:5432/pos_samer -F c -f sauvegarde.dump
--  Puis :
--    psql -d postgres://postgres@localhost:5432/pos_samer -v ON_ERROR_STOP=1 -f vider-transactions.sql
--
--  ⚠️ CE QUI EST DÉJÀ PARTI AU CLOUD N'EST PAS EFFACÉ. Ce script ne touche que
--     la base locale. Les ventes déjà montées chez SamerTrackly y restent ;
--     vider `sync_outbox` empêche seulement de remonter ce qu'on vient
--     d'effacer ici — sans quoi le site pousserait des lignes fantômes.
-- ===========================================================================

-- ---------------------------------------------------------------------------
--  GARDE-FOU : base LOCALE uniquement. Sur le CLOUD, ces DELETE videraient
--  les ventes de TOUS les restaurants d'un coup. Le refus vient AVANT tout
--  DELETE — même raison qu'en tête de `preparer-base-master.sql`, où le
--  lancement par erreur dans l'éditeur SQL Supabase du 2026-08-18 n'avait été
--  sans effet que par chance.
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
  OR to_regclass('public.commandes')    IS NULL
  OR to_regclass('public.sync_outbox')  IS NULL THEN
    RAISE EXCEPTION
      'REFUS : ce n''est pas une base POS locale complète (tables manquantes). '
      'Base : %', current_database();
  END IF;
END
$garde$;

BEGIN;

-- 1) Fidélité EN PREMIER. `points_fidelite` référence `commandes` ET
--    `notes_split` : tant qu'elle porte des lignes, la suppression de l'une ou
--    de l'autre échoue et c'est TOUT le script qui est annulé.
--    (`preparer-base-master.sql` la place après `notes_split` : corrigé le
--    2026-09-10, même piège que celui déjà noté chez lui pour `commandes`.)
--    Les FICHES clients, elles, restent : ce ne sont pas des transactions.
DELETE FROM points_fidelite;

-- 2) Ventes. L'ordre respecte les clés étrangères.
--    `note_split_items` n'est pas listée : elle est en ON DELETE CASCADE sur
--    `notes_split`, donc emportée à la ligne suivante.
DELETE FROM paiements;
DELETE FROM notes_split;
DELETE FROM commande_items;
DELETE FROM notations;
DELETE FROM appels_table;
DELETE FROM commandes;

-- 3) Service de caisse et ce qui en dépend. `entrees_stock`,
--    `inventaire_lignes`, `inventaires_service`, `depenses` et `equipe_service`
--    sont en CASCADE sur `services_caisse` : on les écrit quand même, pour ne
--    pas dépendre d'une cascade qu'un futur changement retirerait en silence.
--
--    NE PAS TOUCHER : `produits_inventaire` (le catalogue de ce qu'on compte)
--    et `inventaire_consommations` (les recettes). Ce sont des RÉGLAGES ;
--    les effacer casserait le calcul d'écart d'inventaire.
DELETE FROM entrees_stock;
DELETE FROM inventaire_lignes;
DELETE FROM inventaires_service;
DELETE FROM depenses;
DELETE FROM equipe_service;
DELETE FROM services_caisse;
DELETE FROM sequences_caisse;

-- 4) File de synchro : sans ça, le poste remonterait au cloud des lignes dont
--    l'original vient d'être effacé ici.
DELETE FROM sync_outbox;
DELETE FROM actions_recues;
DELETE FROM sync_etat;

-- 5) Journal d'audit : protégé par le trigger append-only `audit_immutable`,
--    désactivé le temps de la purge puis REMIS — il fait partie des garanties
--    du cahier des charges.
ALTER TABLE audit_log DISABLE TRIGGER audit_immutable;
DELETE FROM audit_log;
ALTER TABLE audit_log ENABLE TRIGGER audit_immutable;

-- 6) Compteurs : les DELETE ne touchent pas les séquences. Sans ce bloc, le
--    premier ticket après la purge reprendrait le numéro d'avant.
ALTER SEQUENCE seq_numero_ticket   RESTART WITH 1;
ALTER SEQUENCE audit_log_seq_seq   RESTART WITH 1;
ALTER SEQUENCE sync_outbox_seq_seq RESTART WITH 1;

COMMIT;

-- Contrôle : la première ligne doit être à 0 partout, la seconde inchangée.
SELECT
  (SELECT COUNT(*) FROM commandes)          AS commandes,
  (SELECT COUNT(*) FROM paiements)          AS paiements,
  (SELECT COUNT(*) FROM services_caisse)    AS shifts,
  (SELECT COUNT(*) FROM inventaires_service) AS inventaires,
  (SELECT COUNT(*) FROM depenses)           AS depenses,
  (SELECT COUNT(*) FROM sync_outbox)        AS outbox,
  (SELECT COUNT(*) FROM audit_log)          AS audit;

SELECT
  (SELECT COUNT(*) FROM utilisateurs)             AS comptes,
  (SELECT COUNT(*) FROM parametres_locaux)        AS reglages,
  (SELECT COUNT(*) FROM articles)                 AS articles,
  (SELECT COUNT(*) FROM tables_salle)             AS tables,
  (SELECT COUNT(*) FROM produits_inventaire)      AS produits,
  (SELECT COUNT(*) FROM inventaire_consommations) AS recettes,
  (SELECT COUNT(*) FROM clients_fidelite)         AS clients,
  (SELECT code FROM restaurant)                   AS identite;
