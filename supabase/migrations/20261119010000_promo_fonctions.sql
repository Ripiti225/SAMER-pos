-- ============================================================================
-- PROMO-03 — Fonctions SQL des codes promo cartes, appelées par la fonction
-- `promo` (clé de service) et par elle seule.
--
-- Ce qui doit être ATOMIQUE vit ici : un lot et ses N codes naissent ensemble
-- ou pas du tout, et l'annulation d'un lot emporte ses codes dans la même
-- transaction. Les réservations et activations, elles, sont un seul UPDATE
-- conditionnel fait depuis la fonction.
--
-- DROITS : toute fonction du schéma public reçoit EXECUTE pour anon et
-- authenticated à sa création. On les retire explicitement : la clé anonyme
-- est publique (elle vit dans le JavaScript de la console).
-- Idempotente : rejouable sans effet.
-- ============================================================================

-- Un code : préfixe du restaurant + 5 caractères sans ambiguïté.
-- Tirage par rejet (octet < 248 = 8 × 31) pour que chaque caractère ait
-- exactement la même chance : un simple modulo favoriserait les 8 premiers.
CREATE OR REPLACE FUNCTION promo_tirer_code(p_prefixe TEXT)
RETURNS TEXT
LANGUAGE plpgsql VOLATILE
SET search_path = public
AS $$
DECLARE
  alphabet CONSTANT TEXT := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  tirage TEXT := '';
  octet INTEGER;
BEGIN
  WHILE length(tirage) < 5 LOOP
    octet := get_byte(extensions.gen_random_bytes(1), 0);
    IF octet < 248 THEN
      tirage := tirage || substr(alphabet, (octet % 31) + 1, 1);
    END IF;
  END LOOP;
  RETURN p_prefixe || '-' || tirage;
END $$;

-- Crée un lot et ses codes. Une collision avec un code existant (1 chance sur
-- 28 millions par tirage) est simplement retirée.
CREATE OR REPLACE FUNCTION promo_lot_creer(
  p_restaurant_id UUID,
  p_libelle       TEXT,
  p_pourcentage   INTEGER,
  p_valide_du     TIMESTAMPTZ,
  p_valide_au     TIMESTAMPTZ,
  p_quantite      INTEGER,
  p_cree_par      TEXT
)
RETURNS UUID
LANGUAGE plpgsql VOLATILE
SET search_path = public
AS $$
DECLARE
  v_prefixe TEXT;
  v_lot     UUID := gen_random_uuid();
  v_crees   INTEGER := 0;
  v_tirages INTEGER := 0;
BEGIN
  SELECT prefixe_promo INTO v_prefixe
    FROM restaurants WHERE restaurant_id = p_restaurant_id AND actif;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Restaurant inconnu ou inactif';
  END IF;
  IF v_prefixe IS NULL THEN
    RAISE EXCEPTION 'Ce restaurant n’a pas encore de préfixe de code promo';
  END IF;

  INSERT INTO promo_lots (restaurant_id, id, libelle, pourcentage, valide_du, valide_au, quantite, cree_par)
  VALUES (p_restaurant_id, v_lot, p_libelle, p_pourcentage, p_valide_du, p_valide_au, p_quantite, p_cree_par);

  WHILE v_crees < p_quantite LOOP
    v_tirages := v_tirages + 1;
    IF v_tirages > p_quantite * 20 THEN
      RAISE EXCEPTION 'Tirage des codes impossible, réessayez';
    END IF;
    INSERT INTO promo_codes (restaurant_id, lot_id, code)
    VALUES (p_restaurant_id, v_lot, promo_tirer_code(v_prefixe))
    ON CONFLICT (code) DO NOTHING;
    IF FOUND THEN
      v_crees := v_crees + 1;
    END IF;
  END LOOP;

  RETURN v_lot;
END $$;

-- Annule un lot : tous ses codes pas encore utilisés passent ANNULE.
-- Renvoie le nombre de codes annulés ; 0 si le lot l'était déjà.
CREATE OR REPLACE FUNCTION promo_lot_annuler(p_restaurant_id UUID, p_lot_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql VOLATILE
SET search_path = public
AS $$
DECLARE
  v_annules INTEGER;
BEGIN
  UPDATE promo_lots SET annule_le = now()
   WHERE restaurant_id = p_restaurant_id AND id = p_lot_id AND annule_le IS NULL;
  IF NOT FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM promo_lots WHERE restaurant_id = p_restaurant_id AND id = p_lot_id) THEN
      RAISE EXCEPTION 'Lot introuvable';
    END IF;
    RETURN 0;
  END IF;

  UPDATE promo_codes SET statut = 'ANNULE'
   WHERE restaurant_id = p_restaurant_id AND lot_id = p_lot_id
     AND statut IN ('DISPONIBLE', 'RESERVE');
  GET DIAGNOSTICS v_annules = ROW_COUNT;
  RETURN v_annules;
END $$;

-- Lots et leurs compteurs, du plus récent au plus ancien. NULL = tout le groupe.
-- Le CA et la remise viennent des commandes encaissées avec un code du lot.
CREATE OR REPLACE FUNCTION promo_lots_stats(p_restaurant_id UUID DEFAULT NULL)
RETURNS TABLE (
  restaurant_id UUID, id UUID, libelle TEXT, pourcentage INTEGER,
  valide_du TIMESTAMPTZ, valide_au TIMESTAMPTZ, quantite INTEGER,
  annule_le TIMESTAMPTZ, cree_par TEXT, cree_le TIMESTAMPTZ,
  actives BIGINT, reserves BIGINT, utilises BIGINT, annules BIGINT,
  utilises_sur_place BIGINT, utilises_telephone BIGINT, utilises_site BIGINT,
  ca BIGINT, remise BIGINT, conflits BIGINT
)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT l.restaurant_id, l.id, l.libelle, l.pourcentage,
         l.valide_du, l.valide_au, l.quantite,
         l.annule_le, l.cree_par, l.cree_le,
         count(*) FILTER (WHERE c.telephone IS NOT NULL),
         count(*) FILTER (WHERE c.statut = 'RESERVE'),
         count(*) FILTER (WHERE c.statut = 'UTILISE'),
         count(*) FILTER (WHERE c.statut = 'ANNULE'),
         count(*) FILTER (WHERE c.statut = 'UTILISE' AND c.utilise_canal = 'SUR_PLACE'),
         count(*) FILTER (WHERE c.statut = 'UTILISE' AND c.utilise_canal = 'TELEPHONE'),
         count(*) FILTER (WHERE c.statut = 'UTILISE' AND c.utilise_canal = 'SITE'),
         coalesce(sum(cmd.total) FILTER (WHERE cmd.statut <> 'ANNULEE'), 0),
         coalesce(sum(cmd.code_promo_montant) FILTER (WHERE cmd.statut <> 'ANNULEE'), 0),
         (SELECT count(*) FROM promo_conflits pc
            JOIN promo_codes c2 ON c2.restaurant_id = pc.restaurant_id AND c2.id = pc.code_id
           WHERE c2.restaurant_id = l.restaurant_id AND c2.lot_id = l.id)
    FROM promo_lots l
    LEFT JOIN promo_codes c ON c.restaurant_id = l.restaurant_id AND c.lot_id = l.id
    LEFT JOIN commandes cmd ON cmd.restaurant_id = c.restaurant_id AND cmd.id = c.utilise_commande_id
   WHERE p_restaurant_id IS NULL OR l.restaurant_id = p_restaurant_id
   GROUP BY l.restaurant_id, l.id
   ORDER BY l.cree_le DESC;
$$;

-- Numéros à relancer : codes gardés avec consentement, pas encore utilisés,
-- encore valables. `p_jusqua` = n'en garder que ceux qui expirent avant
-- (relance « expire dans 3 jours ») ; NULL = tous (« activé, jamais utilisé »).
CREATE OR REPLACE FUNCTION promo_relances(p_restaurant_id UUID DEFAULT NULL, p_jusqua TIMESTAMPTZ DEFAULT NULL)
RETURNS TABLE (
  restaurant_id UUID, lot_id UUID, libelle TEXT, code TEXT,
  telephone TEXT, active_le TIMESTAMPTZ, valide_au TIMESTAMPTZ
)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT c.restaurant_id, c.lot_id, l.libelle, c.code, c.telephone, c.active_le, l.valide_au
    FROM promo_codes c
    JOIN promo_lots l ON l.restaurant_id = c.restaurant_id AND l.id = c.lot_id
   WHERE c.telephone IS NOT NULL
     AND c.consentement_relance
     AND c.statut = 'DISPONIBLE'
     AND l.annule_le IS NULL
     AND l.valide_au >= now()
     AND (p_jusqua IS NULL OR l.valide_au <= p_jusqua)
     AND (p_restaurant_id IS NULL OR c.restaurant_id = p_restaurant_id)
   ORDER BY l.valide_au, c.telephone;
$$;

REVOKE ALL ON FUNCTION promo_tirer_code(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION promo_lot_creer(UUID, TEXT, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION promo_lot_annuler(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION promo_lots_stats(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION promo_relances(UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION promo_tirer_code(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION promo_lot_creer(UUID, TEXT, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION promo_lot_annuler(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION promo_lots_stats(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION promo_relances(UUID, TIMESTAMPTZ) TO service_role;
