-- ============================================================================
-- PROMO-06 — Onglet « Codes promo cartes » de la console du siège.
--
-- `promo_relances` rend en plus le pourcentage du lot : le message WhatsApp
-- proposé à la relance dit « ton −20 % », il ne doit pas le supposer.
-- Changer le type de retour impose DROP puis CREATE (pas de REPLACE).
-- Idempotente.
-- ============================================================================

DROP FUNCTION IF EXISTS promo_relances(UUID, TIMESTAMPTZ);

CREATE FUNCTION promo_relances(p_restaurant_id UUID DEFAULT NULL, p_jusqua TIMESTAMPTZ DEFAULT NULL)
RETURNS TABLE (
  restaurant_id UUID, lot_id UUID, libelle TEXT, pourcentage INTEGER, code TEXT,
  telephone TEXT, active_le TIMESTAMPTZ, valide_au TIMESTAMPTZ
)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT c.restaurant_id, c.lot_id, l.libelle, l.pourcentage, c.code, c.telephone, c.active_le, l.valide_au
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

REVOKE ALL ON FUNCTION promo_relances(UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION promo_relances(UUID, TIMESTAMPTZ) TO service_role;
