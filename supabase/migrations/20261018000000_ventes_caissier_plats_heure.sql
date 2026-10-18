-- Deux lectures de plus pour le tableau de bord du siège :
--
-- 1. Ce que chaque caissier a vendu sur la période. Même périmètre que
--    `siege_ventes` (commandes PAYEE, datées par `created_at`) : la somme des
--    caissiers d'un restaurant est donc, au franc près, son chiffre d'affaires.
--    La vente est rattachée au caissier du SERVICE (celui du ticket Z), et à
--    `commandes.caissier_id` seulement pour une commande sans service connu.
--
-- 2. Ce qui a été vendu pendant chaque heure, pour l'infobulle des heures de
--    pic. Une ligne par (restaurant, heure) portant ses plats en JSONB : à plat,
--    sept restaurants × dix-huit heures × cinquante plats dépasseraient la
--    limite de lignes de PostgREST et tronqueraient l'infobulle sans le dire.
--    Mêmes règles que `siege_top_plats` et même découpage horaire que
--    `siege_ventes_heure` : le survol d'une barre dit ce que la barre compte.

CREATE OR REPLACE FUNCTION siege_ventes_caissier(p_debut TIMESTAMPTZ, p_fin TIMESTAMPTZ)
RETURNS TABLE (
  restaurant_id UUID,
  caissier_id   UUID,
  caissier      TEXT,
  nb_commandes  BIGINT,
  ca            BIGINT,
  nb_services   BIGINT
)
LANGUAGE sql STABLE AS $$
  SELECT c.restaurant_id,
         COALESCE(s.caissier_id, c.caissier_id),
         COALESCE(max(u.nom_complet), 'Caissier inconnu'),
         count(*),
         COALESCE(sum(c.total), 0)::BIGINT,
         count(DISTINCT c.service_id)
  FROM commandes c
  LEFT JOIN services_caisse s
    ON s.id = c.service_id AND s.restaurant_id = c.restaurant_id
  LEFT JOIN utilisateurs_site u
    ON u.id = COALESCE(s.caissier_id, c.caissier_id) AND u.restaurant_id = c.restaurant_id
  WHERE c.created_at >= p_debut AND c.created_at < p_fin AND c.statut = 'PAYEE'
  GROUP BY 1, 2;
$$;

CREATE OR REPLACE FUNCTION siege_plats_heure(p_debut TIMESTAMPTZ, p_fin TIMESTAMPTZ)
RETURNS TABLE (restaurant_id UUID, heure SMALLINT, plats JSONB)
LANGUAGE sql STABLE AS $$
  SELECT x.restaurant_id, x.heure,
         jsonb_agg(
           jsonb_build_object('nom', x.nom, 'quantite', x.quantite, 'total', x.total)
           ORDER BY x.quantite DESC, x.nom
         )
  FROM (
    SELECT c.restaurant_id,
           EXTRACT(HOUR FROM c.created_at AT TIME ZONE 'Africa/Abidjan')::SMALLINT AS heure,
           ci.nom_snapshot AS nom,
           COALESCE(sum(ci.quantite), 0)::BIGINT AS quantite,
           COALESCE(sum(ci.prix_unitaire * ci.quantite), 0)::BIGINT AS total
    FROM commande_items ci
    JOIN commandes c
      ON c.id = ci.commande_id AND c.restaurant_id = ci.restaurant_id
    WHERE c.created_at >= p_debut AND c.created_at < p_fin
      AND c.statut = 'PAYEE'
      AND COALESCE(ci.statut_cuisine, '') <> 'ANNULE'
      AND ci.nom_snapshot IS NOT NULL
    GROUP BY 1, 2, 3
  ) x
  GROUP BY 1, 2;
$$;
