-- L'explication que le caissier saisit sous un écart réconcilié (bouton
-- « Terminer » du ticket Z) remonte au cloud depuis le 2026-08-27, mais la
-- console du siège ne la lisait nulle part : l'écran Clôtures montrait un
-- écart rouge sans dire ce que la caissière en avait dit.
--
-- `siege_clotures` rend donc aussi le nom du caissier, son explication et
-- l'heure à laquelle il a validé son ticket (`remis_le`). Un écart sans
-- explication ET sans `remis_le`, c'est un caissier qui n'a pas encore
-- terminé — pas un caissier qui a refusé de s'expliquer.
--
-- Le type de retour change : DROP puis CREATE, comme la migration précédente.

DROP FUNCTION IF EXISTS siege_clotures(TIMESTAMPTZ, TIMESTAMPTZ);

CREATE FUNCTION siege_clotures(p_debut TIMESTAMPTZ, p_fin TIMESTAMPTZ)
RETURNS TABLE (
  restaurant_id        UUID,
  service_id           UUID,
  caissier_id          UUID,
  caissier             TEXT,
  ouvert_le            TIMESTAMPTZ,
  cloture_le           TIMESTAMPTZ,
  statut               TEXT,
  fond_de_caisse       INTEGER,
  especes_comptees     INTEGER,
  especes_theorique    INTEGER,
  ecart                INTEGER,
  ecart_reconciliation BIGINT,
  explication_ecart    TEXT,
  remis_le             TIMESTAMPTZ
)
LANGUAGE sql
STABLE
AS $$
  SELECT s.restaurant_id, s.id, s.caissier_id,
         COALESCE(s.rapport_z->>'caissier', u.nom_complet),
         s.ouvert_le, s.cloture_le, s.statut,
         s.fond_de_caisse, s.especes_comptees, s.especes_theorique, s.ecart,
         COALESCE((s.rapport_z->>'diff')::BIGINT, s.ecart::BIGINT),
         s.explication_ecart, s.remis_le
  FROM services_caisse s
  LEFT JOIN utilisateurs_site u
    ON u.id = s.caissier_id AND u.restaurant_id = s.restaurant_id
  WHERE s.ouvert_le >= p_debut AND s.ouvert_le < p_fin
  ORDER BY s.ouvert_le DESC;
$$;
