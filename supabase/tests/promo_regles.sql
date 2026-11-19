-- ============================================================================
-- PROMO-05 — Tests SQL des codes promo cartes (brief § 3, règles R1 à R13).
--
-- Ce que la BASE garantit : contraintes, un seul gagnant quand deux appels se
-- disputent un code, tirage et annulation des lots, compteurs, relances,
-- descente vers les caisses, droits. Les règles appliquées par la fonction
-- `promo` (restaurant, dates, panier, recherche par numéro…) ont leurs tests
-- dans supabase/functions/_shared/promo.test.ts. Correspondance : docs/PROMO_CARTES.md.
--
-- SANS TRACE : tout se passe dans un seul bloc qui se termine TOUJOURS par une
-- erreur volontaire — c'est elle qui annule tout ce que le test a écrit.
-- Lire le message :
--   « PROMO TESTS OK — n vérifications … »  → tout passe ;
--   « PROMO ÉCHEC — … »                     → la règle cassée est nommée.
-- Se lance tel quel dans l'éditeur SQL du projet pos-samer-cloud, autant de
-- fois qu'on veut, en production comprise.
-- ============================================================================

DO $$
DECLARE
  n          INTEGER := 0;          -- vérifications réussies
  sautes     TEXT[]  := '{}';
  v_resto    UUID;
  v_autre    UUID;
  v_lot      UUID;
  v_lot2     UUID;
  v_ids      UUID[];
  v_code     TEXT;
  v_lignes   INTEGER;
  v_entier   INTEGER;
  v_version  BIGINT;
  v_cat      UUID;
  v_stats    RECORD;
  A CONSTANT TEXT := '+2250700112201';
  B CONSTANT TEXT := '+2250500112202';
BEGIN
  SELECT restaurant_id INTO v_resto FROM restaurants WHERE code = 'SAMER_PALMERAIE' AND actif;
  SELECT restaurant_id INTO v_autre FROM restaurants WHERE code = 'SAMER_ANGRE_7E' AND actif;
  IF v_resto IS NULL OR v_autre IS NULL THEN
    RAISE EXCEPTION 'PROMO ÉCHEC — préparation : Palmeraie ou Angré 7E introuvable dans restaurants';
  END IF;

  -- ── Lots : tirage ────────────────────────────────────────────────────────
  v_lot := promo_lot_creer(v_resto, 'TEST PROMO-05', 20, now() - interval '1 day', now() + interval '2 days', 10, 'test');
  SELECT count(*), count(DISTINCT code) INTO v_lignes, v_entier FROM promo_codes WHERE lot_id = v_lot;
  IF v_lignes <> 10 OR v_entier <> 10 THEN
    RAISE EXCEPTION 'PROMO ÉCHEC — lot : % codes dont % distincts, 10 attendus', v_lignes, v_entier;
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM promo_codes WHERE lot_id = v_lot
              AND (code NOT LIKE 'PAM-%' OR statut <> 'DISPONIBLE' OR restaurant_id <> v_resto)) THEN
    RAISE EXCEPTION 'PROMO ÉCHEC — lot : un code n’a pas le préfixe PAM, le statut DISPONIBLE ou le bon restaurant';
  END IF;
  n := n + 1;
  SELECT array_agg(id ORDER BY code) INTO v_ids FROM promo_codes WHERE lot_id = v_lot;

  BEGIN
    PERFORM promo_lot_creer(gen_random_uuid(), 'x', 20, now(), now() + interval '1 day', 1, 'test');
    RAISE EXCEPTION 'PROMO ÉCHEC — lot : un restaurant inconnu a reçu des codes';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'PROMO ÉCHEC%' THEN RAISE; END IF;
    n := n + 1;
  END;

  UPDATE restaurants SET prefixe_promo = NULL WHERE restaurant_id = v_autre;
  BEGIN
    PERFORM promo_lot_creer(v_autre, 'x', 20, now(), now() + interval '1 day', 1, 'test');
    RAISE EXCEPTION 'PROMO ÉCHEC — lot : un restaurant sans préfixe a reçu des codes';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'PROMO ÉCHEC%' THEN RAISE; END IF;
    n := n + 1;
  END;

  BEGIN
    INSERT INTO promo_lots (restaurant_id, libelle, valide_du, valide_au, quantite)
    VALUES (v_resto, 'x', now(), now() - interval '1 day', 1);
    RAISE EXCEPTION 'PROMO ÉCHEC — lot : une fin avant le début est acceptée';
  EXCEPTION WHEN check_violation THEN n := n + 1;
  END;
  BEGIN
    INSERT INTO promo_lots (restaurant_id, libelle, valide_du, valide_au, quantite)
    VALUES (v_resto, 'x', now(), now() + interval '1 day', 2001);
    RAISE EXCEPTION 'PROMO ÉCHEC — lot : plus de 2 000 codes acceptés';
  EXCEPTION WHEN check_violation THEN n := n + 1;
  END;

  -- ── Format et unicité des codes ──────────────────────────────────────────
  SELECT code INTO v_code FROM promo_codes WHERE id = v_ids[1];
  BEGIN
    INSERT INTO promo_codes (restaurant_id, lot_id, code) VALUES (v_resto, v_lot, v_code);
    RAISE EXCEPTION 'PROMO ÉCHEC — R1 : un code en double est accepté';
  EXCEPTION WHEN unique_violation THEN n := n + 1;
  END;
  BEGIN
    INSERT INTO promo_codes (restaurant_id, lot_id, code) VALUES (v_resto, v_lot, 'PAM-7K3Q0');
    RAISE EXCEPTION 'PROMO ÉCHEC — format : un code avec un zéro est accepté';
  EXCEPTION WHEN check_violation THEN n := n + 1;
  END;

  -- ── R13 et activation ────────────────────────────────────────────────────
  BEGIN
    UPDATE promo_codes SET telephone = A, active_le = now(), consentement_relance = false WHERE id = v_ids[1];
    RAISE EXCEPTION 'PROMO ÉCHEC — R13 : un numéro est gardé sans consentement';
  EXCEPTION WHEN check_violation THEN n := n + 1;
  END;
  BEGIN
    UPDATE promo_codes SET telephone = '0777303333', active_le = now(), consentement_relance = true WHERE id = v_ids[1];
    RAISE EXCEPTION 'PROMO ÉCHEC — R12 : un numéro hors format +225XXXXXXXXXX est accepté';
  EXCEPTION WHEN check_violation THEN n := n + 1;
  END;
  BEGIN
    UPDATE promo_codes SET telephone = A, consentement_relance = true WHERE id = v_ids[1];
    RAISE EXCEPTION 'PROMO ÉCHEC — activation : un numéro sans date d’activation est accepté';
  EXCEPTION WHEN check_violation THEN n := n + 1;
  END;

  -- R11 : deux numéros activent le même code. La fonction `promo` pose
  -- `telephone IS NULL` dans la condition : le second UPDATE ne trouve plus rien.
  UPDATE promo_codes SET telephone = A, active_le = now(), consentement_relance = true
   WHERE id = v_ids[1] AND telephone IS NULL AND statut IN ('DISPONIBLE', 'RESERVE');
  GET DIAGNOSTICS v_lignes = ROW_COUNT;
  UPDATE promo_codes SET telephone = B, active_le = now(), consentement_relance = true
   WHERE id = v_ids[1] AND telephone IS NULL AND statut IN ('DISPONIBLE', 'RESERVE');
  GET DIAGNOSTICS v_entier = ROW_COUNT;
  IF v_lignes <> 1 OR v_entier <> 0 OR (SELECT telephone FROM promo_codes WHERE id = v_ids[1]) <> A THEN
    RAISE EXCEPTION 'PROMO ÉCHEC — R11 : deux numéros ont pu garder le même code (% puis %)', v_lignes, v_entier;
  END IF;
  n := n + 1;
  IF (SELECT statut FROM promo_codes WHERE id = v_ids[1]) <> 'DISPONIBLE' THEN
    RAISE EXCEPTION 'PROMO ÉCHEC — R11 : garder un code a changé son statut';
  END IF;
  n := n + 1;

  -- ── R1 : réservation et consommation ─────────────────────────────────────
  -- Deux réservations du même code : condition `statut = 'DISPONIBLE'`, une seule gagne.
  UPDATE promo_codes SET statut = 'RESERVE', reserve_le = now(), reserve_source = 'SITE', reserve_ref = 'cmd-1'
   WHERE id = v_ids[2] AND statut = 'DISPONIBLE';
  GET DIAGNOSTICS v_lignes = ROW_COUNT;
  UPDATE promo_codes SET statut = 'RESERVE', reserve_le = now(), reserve_source = 'SITE', reserve_ref = 'cmd-2'
   WHERE id = v_ids[2] AND statut = 'DISPONIBLE';
  GET DIAGNOSTICS v_entier = ROW_COUNT;
  IF v_lignes <> 1 OR v_entier <> 0 OR (SELECT reserve_ref FROM promo_codes WHERE id = v_ids[2]) <> 'cmd-1' THEN
    RAISE EXCEPTION 'PROMO ÉCHEC — R1 : deux réservations du même code ont réussi (% puis %)', v_lignes, v_entier;
  END IF;
  n := n + 1;
  BEGIN
    UPDATE promo_codes SET statut = 'RESERVE', reserve_le = NULL, reserve_source = NULL WHERE id = v_ids[3];
    RAISE EXCEPTION 'PROMO ÉCHEC — R1 : une réservation sans date ni origine est acceptée';
  EXCEPTION WHEN check_violation THEN n := n + 1;
  END;
  BEGIN
    UPDATE promo_codes SET statut = 'UTILISE' WHERE id = v_ids[3];
    RAISE EXCEPTION 'PROMO ÉCHEC — R1 : un code passe UTILISE sans commande ni canal';
  EXCEPTION WHEN check_violation THEN n := n + 1;
  END;
  UPDATE promo_codes SET statut = 'UTILISE', utilise_le = now(), utilise_commande_id = gen_random_uuid(), utilise_canal = 'TELEPHONE'
   WHERE id = v_ids[4];
  n := n + 1;

  -- ── Descente vers les caisses : chaque écriture fait avancer la version ──
  SELECT version INTO v_version FROM promo_codes WHERE id = v_ids[5];
  UPDATE promo_codes SET reserve_ref = NULL WHERE id = v_ids[5];
  IF (SELECT version FROM promo_codes WHERE id = v_ids[5]) <= v_version THEN
    RAISE EXCEPTION 'PROMO ÉCHEC — descente : une modification n’a pas fait avancer la version du code';
  END IF;
  n := n + 1;

  -- ── Relances : numéro gardé, consentement, pas utilisé, encore valable ───
  UPDATE promo_codes SET telephone = B, active_le = now(), consentement_relance = true WHERE id = v_ids[4];  -- utilisé
  UPDATE promo_codes SET telephone = B, active_le = now(), consentement_relance = true WHERE id = v_ids[6];  -- à relancer
  SELECT count(*) INTO v_lignes FROM promo_relances(v_resto, now() + interval '3 days') WHERE lot_id = v_lot;
  IF v_lignes <> 2 THEN   -- v_ids[1] (A) et v_ids[6] (B) ; pas v_ids[4], déjà utilisé
    RAISE EXCEPTION 'PROMO ÉCHEC — relances : % numéros à relancer, 2 attendus', v_lignes;
  END IF;
  n := n + 1;
  SELECT count(*) INTO v_lignes FROM promo_relances(v_resto, now() + interval '1 day') WHERE lot_id = v_lot;
  IF v_lignes <> 0 THEN
    RAISE EXCEPTION 'PROMO ÉCHEC — relances : un code qui expire dans 2 jours sort dans la liste « 1 jour »';
  END IF;
  n := n + 1;

  -- ── Compteurs de la console ──────────────────────────────────────────────
  SELECT * INTO v_stats FROM promo_lots_stats(v_resto) WHERE id = v_lot;
  IF v_stats.quantite <> 10 OR v_stats.actives <> 3 OR v_stats.reserves <> 1 OR v_stats.utilises <> 1 OR v_stats.utilises_telephone <> 1 THEN
    RAISE EXCEPTION 'PROMO ÉCHEC — compteurs : gardés %, réservés %, utilisés % (tél. %) ; 3, 1, 1 (1) attendus',
      v_stats.actives, v_stats.reserves, v_stats.utilises, v_stats.utilises_telephone;
  END IF;
  n := n + 1;

  -- ── R9 : libération des réservations (PROMO-04) ──────────────────────────
  IF to_regprocedure('promo_liberer_reservations()') IS NULL THEN
    sautes := array_append(sautes, 'R9 (PROMO-04 pas encore appliqué)');
  ELSE
    UPDATE promo_codes SET reserve_le = now() - interval '3 hours' WHERE id = v_ids[2];                    -- site, 3 h : libéré
    UPDATE promo_codes SET statut = 'RESERVE', reserve_le = now() - interval '10 minutes', reserve_source = 'POS'
     WHERE id = v_ids[7];                                                                                    -- caisse, 10 min : gardé
    PERFORM promo_liberer_reservations();
    IF (SELECT statut FROM promo_codes WHERE id = v_ids[2]) <> 'DISPONIBLE'
       OR (SELECT statut FROM promo_codes WHERE id = v_ids[7]) <> 'RESERVE'
       OR (SELECT statut FROM promo_codes WHERE id = v_ids[4]) <> 'UTILISE' THEN
      RAISE EXCEPTION 'PROMO ÉCHEC — R9 : la libération a touché le mauvais code';
    END IF;
    n := n + 1;
  END IF;

  -- ── Annulation d'un lot ──────────────────────────────────────────────────
  v_entier := promo_lot_annuler(v_resto, v_lot);
  SELECT count(*) INTO v_lignes FROM promo_codes WHERE lot_id = v_lot AND statut = 'ANNULE';
  IF v_entier <> 9 OR v_lignes <> 9 OR (SELECT statut FROM promo_codes WHERE id = v_ids[4]) <> 'UTILISE' THEN
    RAISE EXCEPTION 'PROMO ÉCHEC — annulation : % codes annulés, 9 attendus, l’utilisé intact', v_entier;
  END IF;
  n := n + 1;
  IF promo_lot_annuler(v_resto, v_lot) <> 0 THEN
    RAISE EXCEPTION 'PROMO ÉCHEC — annulation : annuler deux fois rend des codes';
  END IF;
  n := n + 1;
  SELECT count(*) INTO v_lignes FROM promo_relances(v_resto, NULL) WHERE lot_id = v_lot;
  IF v_lignes <> 0 THEN
    RAISE EXCEPTION 'PROMO ÉCHEC — annulation : un lot annulé reste dans les relances';
  END IF;
  n := n + 1;
  BEGIN
    PERFORM promo_lot_annuler(v_resto, gen_random_uuid());
    RAISE EXCEPTION 'PROMO ÉCHEC — annulation : un lot inconnu est accepté';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'PROMO ÉCHEC%' THEN RAISE; END IF;
    n := n + 1;
  END;

  -- ── R4 : exclusion de catégorie (Chawarma) ───────────────────────────────
  SELECT id INTO v_cat FROM categories WHERE restaurant_id = v_resto LIMIT 1;
  IF v_cat IS NULL THEN
    sautes := array_append(sautes, 'R4 (aucune catégorie à la Palmeraie)');
  ELSE
    INSERT INTO promo_categories_exclues (restaurant_id, id, exclue, modifie_par) VALUES (v_resto, v_cat, true, 'test')
    ON CONFLICT (restaurant_id, id) DO UPDATE SET exclue = true;
    IF (SELECT version FROM promo_categories_exclues WHERE restaurant_id = v_resto AND id = v_cat) <= 0 THEN
      RAISE EXCEPTION 'PROMO ÉCHEC — R4 : l’exclusion ne descendra pas aux caisses (version nulle)';
    END IF;
    n := n + 1;
  END IF;
  BEGIN
    INSERT INTO promo_categories_exclues (restaurant_id, id) VALUES (v_resto, gen_random_uuid());
    RAISE EXCEPTION 'PROMO ÉCHEC — R4 : une catégorie inexistante est exclue';
  EXCEPTION WHEN foreign_key_violation THEN n := n + 1;
  END;

  -- ── Droits : rien n'est ouvert à la clé publique ─────────────────────────
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
              WHERE s.nspname = 'public' AND p.proname LIKE 'promo\_%'
                AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION 'PROMO ÉCHEC — droits : une fonction promo_* est exécutable avec la clé publique';
  END IF;
  n := n + 1;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
              WHERE s.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'promo\_%'
                AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity))
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'promo\_%') THEN
    RAISE EXCEPTION 'PROMO ÉCHEC — droits : une table promo_* n’est pas fermée (RLS absente ou politique ouverte)';
  END IF;
  n := n + 1;

  -- Le seul « succès » possible : une erreur volontaire, qui annule tout.
  RAISE EXCEPTION 'PROMO TESTS OK — % vérifications%', n,
    CASE WHEN cardinality(sautes) = 0 THEN '' ELSE ' ; sautées : ' || array_to_string(sautes, ', ') END
    USING ERRCODE = 'P0002';
END $$;
