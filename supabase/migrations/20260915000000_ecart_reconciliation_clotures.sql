-- L'anomalie réelle d'une clôture est l'écart de RÉCONCILIATION du rapport Z.
-- `services_caisse.ecart` reste l'écart espèces brut : utile pour comprendre
-- le tiroir, mais il peut être entièrement compensé par une correction Wave,
-- Orange Money, etc. et ne doit alors créer aucun litige.

DROP FUNCTION IF EXISTS siege_clotures(TIMESTAMPTZ, TIMESTAMPTZ);

CREATE FUNCTION siege_clotures(p_debut TIMESTAMPTZ, p_fin TIMESTAMPTZ)
RETURNS TABLE (
  restaurant_id       UUID,
  service_id          UUID,
  caissier_id         UUID,
  ouvert_le           TIMESTAMPTZ,
  cloture_le          TIMESTAMPTZ,
  statut              TEXT,
  fond_de_caisse      INTEGER,
  especes_comptees    INTEGER,
  especes_theorique   INTEGER,
  ecart               INTEGER,
  ecart_reconciliation BIGINT
)
LANGUAGE sql
STABLE
AS $$
  SELECT s.restaurant_id, s.id, s.caissier_id, s.ouvert_le, s.cloture_le, s.statut,
         s.fond_de_caisse, s.especes_comptees, s.especes_theorique, s.ecart,
         COALESCE((s.rapport_z->>'diff')::BIGINT, s.ecart::BIGINT)
  FROM services_caisse s
  WHERE s.ouvert_le >= p_debut AND s.ouvert_le < p_fin
  ORDER BY s.ouvert_le DESC;
$$;

-- Le tableau de bord et son classement par caissier suivent exactement la
-- même définition. Le repli sur `s.ecart` ne concerne que les très anciens
-- rapports, antérieurs au champ `diff`.
CREATE OR REPLACE FUNCTION siege_ecarts_caissier(p_debut TIMESTAMPTZ, p_fin TIMESTAMPTZ)
RETURNS TABLE (restaurant_id UUID, caissier TEXT, ecart BIGINT, nb_services BIGINT)
LANGUAGE sql
STABLE
AS $$
  SELECT s.restaurant_id,
         COALESCE(s.rapport_z->>'caissier', u.nom_complet, s.caissier_id::TEXT, 'Inconnu'),
         COALESCE(sum(COALESCE((s.rapport_z->>'diff')::BIGINT, s.ecart::BIGINT)), 0)::BIGINT,
         count(*)
  FROM services_caisse s
  LEFT JOIN utilisateurs_site u
    ON u.id = s.caissier_id AND u.restaurant_id = s.restaurant_id
  WHERE s.ouvert_le >= p_debut AND s.ouvert_le < p_fin AND s.statut = 'CLOTURE'
  GROUP BY 1, 2;
$$;
