-- ════════════════════════════════════════════════════════════════════════════
--  LIVRAISONS PARTENAIRES — contact client et suivi par caissier
--
--  POURQUOI — une course Yango ou Glovo montait au cloud sans rien qui permette
--  de la rattacher à un client. `ref_partenaire` existait depuis le début mais
--  aucun écran ne le demandait, et le numéro du client n'était nulle part. Un
--  litige (« cette commande n'est jamais arrivée ») se réglait de mémoire.
--
--  Le POS demande désormais les deux dans une modale qui s'ouvre au lancement en
--  cuisine. Le caissier peut fermer sans rien mettre : c'est justement pour ça
--  qu'on compte les commandes ET les contacts. L'écart entre les deux — « 5
--  courses, 4 contacts » — est le nombre de livraisons intraçables, et c'est LE
--  chiffre à surveiller, par caissier.
--
--  ATTENTION : `contact_client` ne vaudra que pour les commandes À VENIR. Les
--  lignes déjà montées ne sont pas republiées, elles resteront à NULL.
--
--  À lancer dans pos-samer-cloud. Rejouable sans risque.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.commandes
  ADD COLUMN IF NOT EXISTS contact_client TEXT;

-- Livraisons partenaires par caissier. Trois décomptes sur la même ligne :
--   nb       courses payées du partenaire
--   contacts celles qui portent le téléphone du client
--   refs     celles qui portent le n° de commande du partenaire
--
-- Le nom vient du caissier de la commande. `utilisateurs_site` en repli et
-- l'uuid en dernier recours : une course d'un caissier parti du restaurant doit
-- rester visible, c'est même le cas où on la cherche.
CREATE OR REPLACE FUNCTION siege_livraisons_caissier(p_debut TIMESTAMPTZ, p_fin TIMESTAMPTZ)
RETURNS TABLE (
  restaurant_id UUID,
  caissier      TEXT,
  partenaire    TEXT,
  nb            BIGINT,
  contacts      BIGINT,
  refs          BIGINT,
  ca            BIGINT
)
LANGUAGE sql STABLE AS $$
  SELECT c.restaurant_id,
         COALESCE(u.nom_complet, c.caissier_id::TEXT, 'Inconnu'),
         c.partenaire,
         count(*),
         count(*) FILTER (WHERE NULLIF(btrim(c.contact_client), '') IS NOT NULL),
         count(*) FILTER (WHERE NULLIF(btrim(c.ref_partenaire), '') IS NOT NULL),
         COALESCE(sum(c.total), 0)::BIGINT
  FROM commandes c
  LEFT JOIN utilisateurs_site u
    ON u.id = c.caissier_id AND u.restaurant_id = c.restaurant_id
  WHERE c.created_at >= p_debut AND c.created_at < p_fin
    AND c.statut = 'PAYEE'
    AND c.type = 'LIVRAISON'
    AND c.partenaire IS NOT NULL
  GROUP BY 1, 2, 3;
$$;
