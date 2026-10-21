-- ════════════════════════════════════════════════════════════════════════════
--  SANTÉ DES SITES — ce que le siège sait de chaque POS, sans aller sur place
--
--  Ce que le cloud savait DÉJÀ, et qu'on réutilise tel quel :
--    * `sync_journal` : une ligne PUSH à chaque lot de ventes acquitté, une
--      ligne PULL à chaque descente (toutes les 5 min, même à vide). La
--      dernière ligne d'un site = la dernière fois qu'il a parlé au cloud ;
--    * `sync_rejets`  : les lignes que le cloud a refusées ou garées.
--
--  Ce qu'il ne pouvait PAS savoir, et que seul le site connaît :
--    * combien de lignes attendent encore dans son `sync_outbox` — un site
--      qui parle au cloud mais dont les ventes sont refusées a l'air vivant
--      dans le journal, alors qu'aucune vente n'arrive ;
--    * la dernière descente qu'il a réellement APPLIQUÉE (`sync_etat`), qui
--      gouverne la règle des 24 h du paiement en points ;
--    * la version du code qui tourne chez lui — prérequis de toute future
--      mise à jour à distance : on ne met pas à jour ce qu'on ne sait pas lire.
--
--  D'où `sites_sante` : un « battement de cœur » par site, UNE ligne écrasée à
--  chaque descente (fonction `sync-pull`). Une ligne par site, pas un
--  historique : 288 descentes par jour et par site rempliraient la table pour
--  rien, le journal porte déjà la chronologie.
--
--  À lancer dans pos-samer-cloud. Rejouable sans risque.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.sites_sante (
  restaurant_id            UUID PRIMARY KEY,

  -- Heure du CLOUD à la réception. Les autres dates viennent de l'horloge du
  -- mini-PC, qui peut dériver : celle-ci ne ment pas.
  recu_le                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Ce qui s'affiche (commit court, ou numéro posé par POS_VERSION) et le
  -- commit complet, qui servira à comparer avec la version à déployer.
  version_code             TEXT,
  commit_git               TEXT,

  -- `sync_outbox WHERE synced_at IS NULL` au moment du battement, et l'âge de
  -- la plus ancienne : 3 lignes depuis 2 minutes ou depuis 2 jours, ce n'est
  -- pas le même restaurant.
  lignes_en_attente        INTEGER,
  plus_ancienne_en_attente TIMESTAMPTZ,

  -- Horloge du site.
  dernier_acquittement     TIMESTAMPTZ,
  derniere_descente        TIMESTAMPTZ,
  derniere_erreur          TEXT,
  heure_site               TIMESTAMPTZ
);

ALTER TABLE public.sites_sante ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sites_sante FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.sites_sante IS
  'Battement de cœur de chaque site, écrasé à chaque descente (fonction `sync-pull`). Lu par la console du siège (action `sante_sites`). RLS forcée sans politique : service_role uniquement.';
COMMENT ON COLUMN public.sites_sante.derniere_descente IS
  'MAX(sync_etat.synced_at) du site : au-delà de 24 h, le site refuse le paiement en points (fidelite/service.ts, soldeVerifiable).';

-- Retrouver le dernier PUSH d'un site sans parcourir ses centaines de PULL.
CREATE INDEX IF NOT EXISTS idx_sync_journal_site_type
  ON public.sync_journal (restaurant_id, type, recu_le DESC);
CREATE INDEX IF NOT EXISTS idx_cloud_rejets_date
  ON public.sync_rejets (restaurant_id, created_at);


-- ── Lecture du siège : une ligne par site enrôlé ────────────────────────────
--
-- LATERAL + LIMIT 1 plutôt qu'un GROUP BY sur tout le journal : le journal
-- grossit de ~300 lignes par jour et par site, l'index ci-dessus rend chaque
-- recherche instantanée quelle que soit sa taille.
CREATE OR REPLACE FUNCTION siege_sante_sites()
RETURNS TABLE (
  restaurant_id            UUID,
  code                     TEXT,
  actif                    BOOLEAN,
  dernier_push             TIMESTAMPTZ,
  dernier_pull             TIMESTAMPTZ,
  rejets_24h               BIGINT,
  battement_le             TIMESTAMPTZ,
  version_code             TEXT,
  commit_git               TEXT,
  lignes_en_attente        INTEGER,
  plus_ancienne_en_attente TIMESTAMPTZ,
  dernier_acquittement     TIMESTAMPTZ,
  derniere_descente        TIMESTAMPTZ,
  derniere_erreur          TEXT,
  heure_site               TIMESTAMPTZ
)
LANGUAGE sql STABLE AS $$
  SELECT s.restaurant_id, s.code, s.actif,
         push.recu_le, pull.recu_le,
         (SELECT count(*) FROM sync_rejets r
           WHERE r.restaurant_id = s.restaurant_id
             AND r.created_at > now() - interval '24 hours'),
         h.recu_le, h.version_code, h.commit_git,
         h.lignes_en_attente, h.plus_ancienne_en_attente,
         h.dernier_acquittement, h.derniere_descente, h.derniere_erreur, h.heure_site
  FROM sites_autorises s
  LEFT JOIN LATERAL (
    SELECT j.recu_le FROM sync_journal j
     WHERE j.restaurant_id = s.restaurant_id AND j.type = 'PUSH'
     ORDER BY j.recu_le DESC LIMIT 1
  ) push ON true
  LEFT JOIN LATERAL (
    SELECT j.recu_le FROM sync_journal j
     WHERE j.restaurant_id = s.restaurant_id AND j.type = 'PULL'
     ORDER BY j.recu_le DESC LIMIT 1
  ) pull ON true
  LEFT JOIN sites_sante h ON h.restaurant_id = s.restaurant_id;
$$;


-- ── Vérification ────────────────────────────────────────────────────────────
--
--   SELECT code, dernier_push, dernier_pull, lignes_en_attente, version_code
--     FROM siege_sante_sites() ORDER BY code;
--
--  `battement_le` NULL alors que `dernier_pull` est récent : le site tourne un
--  POS antérieur au battement (ou `sync-pull` n'est pas redéployée).
