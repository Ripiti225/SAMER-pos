-- ============================================================================
-- PROMO-13 — Bilan d'un lot de codes promo (console du siège, écran « Bilan »)
--
-- Une seule lecture renvoie tout l'écran : tunnel imprimés → gardés →
-- utilisés, CA et remise des commandes encaissées avec un code du lot, panier
-- moyen, délai médian « gardé → utilisé », jour par jour, canaux, conflits
-- (codes encaissés deux fois) et la liste des utilisations pour l'export CSV,
-- SANS numéro de client.
--
-- Les jours sont ceux d'Abidjan (UTC toute l'année, écrit en clair quand même).
-- Les commandes annulées ne comptent ni dans le CA ni dans la remise, comme
-- dans promo_lots_stats. Un conflit « traité » reste visible, grisé, mais ne
-- compte plus dans l'alerte de la liste des lots.
--
-- Fonctions réservées au service_role (fonction `promo`, rôles vérifiés là).
-- Idempotente.
-- ============================================================================

CREATE OR REPLACE FUNCTION promo_lot_bilan(p_restaurant_id UUID, p_lot_id UUID)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public
AS $$
  WITH lot AS (
    SELECT * FROM promo_lots WHERE restaurant_id = p_restaurant_id AND id = p_lot_id
  ),
  codes AS (
    SELECT c.* FROM promo_codes c JOIN lot l ON c.restaurant_id = l.restaurant_id AND c.lot_id = l.id
  ),
  utilises AS (
    SELECT c.code, c.utilise_le, c.utilise_canal, c.active_le,
           cmd.id AS commande_id, cmd.numero_ticket, cmd.total, cmd.code_promo_montant,
           (cmd.id IS NOT NULL AND cmd.statut IS DISTINCT FROM 'ANNULEE') AS compte
      FROM codes c
      LEFT JOIN commandes cmd ON cmd.restaurant_id = c.restaurant_id AND cmd.id = c.utilise_commande_id
     WHERE c.statut = 'UTILISE'
  ),
  bornes AS (
    SELECT least(l.valide_du, (SELECT min(active_le) FROM codes)) AS debut,
           least(l.valide_au, now()) AS fin
      FROM lot l
  ),
  jours AS (
    SELECT d::date AS jour
      FROM bornes b,
           generate_series((b.debut AT TIME ZONE 'Africa/Abidjan')::date,
                           (b.fin AT TIME ZONE 'Africa/Abidjan')::date, interval '1 day') d
  ),
  conflits AS (
    SELECT pc.id, pc.resolu, pc.detecte_le, c.code,
           jsonb_build_object('numero_ticket', a.numero_ticket, 'le', a.created_at, 'canal', a.code_promo_canal,
                              'total', a.total, 'caissier', ua.nom_complet) AS a,
           jsonb_build_object('numero_ticket', b.numero_ticket, 'le', b.created_at, 'canal', b.code_promo_canal,
                              'total', b.total, 'caissier', ub.nom_complet) AS b,
           coalesce(nullif(b.code_promo_montant, 0), ev.montant, 0) AS remise_en_trop
      FROM promo_conflits pc
      JOIN codes c ON c.restaurant_id = pc.restaurant_id AND c.id = pc.code_id
      LEFT JOIN commandes a ON a.restaurant_id = pc.restaurant_id AND a.id = pc.commande_id_a
      LEFT JOIN utilisateurs ua ON ua.id = a.caissier_id
      LEFT JOIN commandes b ON b.restaurant_id = pc.restaurant_id AND b.id = pc.commande_id_b
      LEFT JOIN utilisateurs ub ON ub.id = b.caissier_id
      LEFT JOIN LATERAL (
        SELECT e.montant FROM promo_utilisations e
         WHERE e.restaurant_id = pc.restaurant_id AND e.code_id = pc.code_id
           AND e.commande_id = pc.commande_id_b AND e.evenement = 'UTILISE'
         ORDER BY e.created_at LIMIT 1
      ) ev ON true
  )
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM lot) THEN NULL ELSE jsonb_build_object(
    'imprimes',  (SELECT quantite FROM lot),
    'gardes',    (SELECT count(*) FROM codes WHERE telephone IS NOT NULL),
    'reserves',  (SELECT count(*) FROM codes WHERE statut = 'RESERVE'),
    'utilises',  (SELECT count(*) FROM utilises),
    'commandes', (SELECT count(*) FROM utilises WHERE compte),
    'ca',        (SELECT coalesce(sum(total), 0) FROM utilises WHERE compte),
    'remise',    (SELECT coalesce(sum(code_promo_montant), 0) FROM utilises WHERE compte),
    'panier_moyen', (SELECT round(avg(total)) FROM utilises WHERE compte),
    'delai_median_heures', (
      SELECT round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM utilise_le - active_le) / 3600))::numeric, 1)
        FROM utilises WHERE active_le IS NOT NULL AND utilise_le >= active_le),
    'jours', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'jour', j.jour,
               'gardes', (SELECT count(*) FROM codes c WHERE (c.active_le AT TIME ZONE 'Africa/Abidjan')::date = j.jour),
               'utilises', (SELECT count(*) FROM utilises u WHERE (u.utilise_le AT TIME ZONE 'Africa/Abidjan')::date = j.jour))
             ORDER BY j.jour)
        FROM jours j), '[]'::jsonb),
    'canaux', (
      SELECT jsonb_agg(jsonb_build_object(
               'canal', k.canal,
               'utilises', (SELECT count(*) FROM utilises u WHERE u.utilise_canal = k.canal),
               'ca', (SELECT coalesce(sum(total), 0) FROM utilises u WHERE u.utilise_canal = k.canal AND u.compte))
             ORDER BY k.ordre)
        FROM (VALUES ('SUR_PLACE', 1), ('TELEPHONE', 2), ('SITE', 3)) AS k(canal, ordre)),
    'conflits', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', id, 'code', code, 'resolu', resolu, 'detecte_le', detecte_le,
                                          'a', a, 'b', b, 'remise_en_trop', remise_en_trop)
             ORDER BY resolu, detecte_le)
        FROM conflits), '[]'::jsonb),
    'utilisations', coalesce((
      SELECT jsonb_agg(jsonb_build_object('code', code, 'le', utilise_le, 'canal', utilise_canal,
                                          'numero_ticket', numero_ticket, 'total', total,
                                          'remise', code_promo_montant, 'annulee', commande_id IS NOT NULL AND NOT compte)
             ORDER BY utilise_le)
        FROM utilises), '[]'::jsonb)
  ) END;
$$;

-- « Marquer traité » : le siège a vérifié le second encaissement avec le
-- restaurant. Renvoie false si le conflit n'existe pas ou était déjà traité.
CREATE OR REPLACE FUNCTION promo_conflit_traiter(p_restaurant_id UUID, p_conflit_id UUID)
RETURNS boolean
LANGUAGE sql
SET search_path = public
AS $$
  WITH maj AS (
    UPDATE promo_conflits SET resolu = true
     WHERE restaurant_id = p_restaurant_id AND id = p_conflit_id AND NOT resolu
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM maj);
$$;

-- Liste des lots : l'alerte ne compte plus les conflits traités.
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
           WHERE c2.restaurant_id = l.restaurant_id AND c2.lot_id = l.id AND NOT pc.resolu)
    FROM promo_lots l
    LEFT JOIN promo_codes c ON c.restaurant_id = l.restaurant_id AND c.lot_id = l.id
    LEFT JOIN commandes cmd ON cmd.restaurant_id = c.restaurant_id AND cmd.id = c.utilise_commande_id
   WHERE p_restaurant_id IS NULL OR l.restaurant_id = p_restaurant_id
   GROUP BY l.restaurant_id, l.id
   ORDER BY l.cree_le DESC;
$$;

REVOKE ALL ON FUNCTION promo_lot_bilan(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION promo_conflit_traiter(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION promo_lots_stats(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION promo_lot_bilan(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION promo_conflit_traiter(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION promo_lots_stats(UUID) TO service_role;
