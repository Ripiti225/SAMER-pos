-- ============================================================================
-- PROMO-10 — Le cloud tire le statut des codes des événements remontés par les
-- caisses (promo_utilisations, via l'outbox et sync-push).
--
-- Une caisse valide et consomme un code HORS LIGNE ; elle envoie ensuite ce
-- qu'elle a fait : RESERVE (code vérifié pour une commande ouverte), LIBERE
-- (commande annulée ou code retiré), UTILISE (encaissement). Ce déclencheur
-- applique chaque événement au code, à sa PREMIÈRE arrivée seulement :
-- sync-push rejoue un lot par UPSERT, et un rejeu ne doit rien refaire.
--
-- Règles :
--   * UTILISE l'emporte sur tout, même sur un lot annulé : la vente a eu lieu ;
--   * déjà UTILISE par une AUTRE commande (deux caisses pendant une coupure) :
--     le premier encaissement garde le code, le second devient un conflit,
--     visible au siège ; sa commande reste valide ;
--   * RESERVE ne prend qu'un code DISPONIBLE ; LIBERE ne libère que la
--     réservation de cette même commande (pas celle d'une commande du site).
-- Idempotente.
-- ============================================================================

CREATE OR REPLACE FUNCTION promo_appliquer_evenement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v promo_codes%ROWTYPE;
BEGIN
  SELECT * INTO v FROM promo_codes
   WHERE restaurant_id = NEW.restaurant_id AND id = NEW.code_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NEW;  -- code inconnu du cloud : l'événement reste, pour l'historique
  END IF;

  IF NEW.evenement = 'UTILISE' THEN
    IF v.statut = 'UTILISE' THEN
      IF v.utilise_commande_id IS DISTINCT FROM NEW.commande_id THEN
        INSERT INTO promo_conflits (restaurant_id, code_id, commande_id_a, commande_id_b)
        VALUES (NEW.restaurant_id, NEW.code_id, v.utilise_commande_id, NEW.commande_id)
        ON CONFLICT (code_id, commande_id_b) DO NOTHING;
      END IF;
    ELSE
      UPDATE promo_codes
         SET statut = 'UTILISE',
             utilise_le = NEW.created_at,
             utilise_commande_id = NEW.commande_id,
             utilise_canal = coalesce(NEW.canal, 'SUR_PLACE'),
             reserve_le = NULL, reserve_source = NULL, reserve_ref = NULL
       WHERE restaurant_id = NEW.restaurant_id AND id = NEW.code_id;
    END IF;

  ELSIF NEW.evenement = 'RESERVE' THEN
    UPDATE promo_codes
       SET statut = 'RESERVE', reserve_le = NEW.created_at, reserve_source = 'POS', reserve_ref = NEW.commande_id::text
     WHERE restaurant_id = NEW.restaurant_id AND id = NEW.code_id AND statut = 'DISPONIBLE';

  ELSIF NEW.evenement = 'LIBERE' THEN
    UPDATE promo_codes
       SET statut = 'DISPONIBLE', reserve_le = NULL, reserve_source = NULL, reserve_ref = NULL
     WHERE restaurant_id = NEW.restaurant_id AND id = NEW.code_id
       AND statut = 'RESERVE' AND reserve_source = 'POS' AND reserve_ref = NEW.commande_id::text;
  END IF;

  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION promo_appliquer_evenement() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_promo_evenement ON promo_utilisations;
CREATE TRIGGER trg_promo_evenement
  AFTER INSERT ON promo_utilisations
  FOR EACH ROW EXECUTE FUNCTION promo_appliquer_evenement();
