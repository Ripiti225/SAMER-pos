-- Annulation d'un paiement saisi par erreur (POS, migration locale 0042) —
-- miroir cloud. NON APPLIQUÉE à la livraison : à passer quand on veut, dans
-- n'importe quel ordre par rapport au déploiement des caisses.
--
-- Le POS n'efface ni ne modifie jamais un paiement : il le CONTRE-PASSE par
-- une ligne NÉGATIVE du même mode, sur le même shift. Cette ligne remonte par
-- `sync-push` comme un INSERT ordinaire, avec les colonnes que le cloud a déjà
-- (aucune colonne nouvelle n'est publiée : `contrepasse_de`, `annule_par` et
-- `annulation_motif` restent sur le site, le lien part dans l'audit
-- ANNULATION_PAIEMENT). Les SOMMES du cloud sont donc justes sans rien changer.
--
-- Seul le NOMBRE de paiements par mode du tableau de bord du siège compterait
-- l'annulation comme un paiement de plus : un paiement annulé vaudrait 2 au
-- lieu de 0. Le compte devient net — les lignes négatives retirent l'unité de
-- l'original.
CREATE OR REPLACE FUNCTION siege_par_mode(p_debut TIMESTAMPTZ, p_fin TIMESTAMPTZ)
RETURNS TABLE (restaurant_id UUID, mode TEXT, montant BIGINT, nb BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT p.restaurant_id, p.mode, COALESCE(sum(p.montant), 0)::BIGINT,
         count(*) FILTER (WHERE p.montant > 0) - count(*) FILTER (WHERE p.montant < 0)
  FROM paiements p
  WHERE p.created_at >= p_debut AND p.created_at < p_fin
  GROUP BY 1, 2;
$$;
