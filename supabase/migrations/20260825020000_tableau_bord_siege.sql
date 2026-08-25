-- ════════════════════════════════════════════════════════════════════════════
--  TABLEAU DE BORD DU SIÈGE — référentiel de salle + agrégations
--
--  Deux choses :
--
--  1. `zones` et `tables_salle` deviennent des tables de MONTÉE. Sans elles, le
--     cloud reçoit `commandes.table_id` — un uuid qu'il ne sait traduire avec
--     rien — et le siège ne peut pas dire quelle table travaille le plus.
--     Ce sont des tables de montée : PAS de colonne `version`, pas de trigger.
--     Le siège les LIT, il ne les écrit jamais ; le plan de salle appartient au
--     restaurant.
--
--  2. Les agrégations du tableau de bord, en SQL et non dans l'Edge Function.
--     Un mois de ventes sur 7 restaurants fait ~10 000 lignes de `commandes` :
--     les remonter dans Deno pour les additionner en JavaScript serait lent et
--     exposé à la troncature de PostgREST. Agréger ici rend quelques dizaines
--     de lignes. C'est déjà le choix fait pour `siege_ventes` le 2026-08-17.
--
--  À lancer dans pos-samer-cloud. Rejouable sans risque.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. Référentiel de salle ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.zones (
  id            UUID NOT NULL,
  restaurant_id UUID NOT NULL,
  nom           TEXT,
  couleur       TEXT,
  ordre         SMALLINT,
  PRIMARY KEY (restaurant_id, id)
);

CREATE TABLE IF NOT EXISTS public.tables_salle (
  id            UUID NOT NULL,
  restaurant_id UUID NOT NULL,
  zone_id       UUID,
  numero        TEXT,
  partenaire    TEXT,
  actif         BOOLEAN,
  PRIMARY KEY (restaurant_id, id)
);

-- `statut`, `qr_token` et `ouverte_par` NE montent PAS : le statut est un état
-- de salle qui change toutes les minutes (il ferait monter la table à chaque
-- service), et le jeton QR est un secret propre au site.

CREATE INDEX IF NOT EXISTS idx_cloud_tables_salle ON public.tables_salle (restaurant_id, zone_id);

ALTER TABLE public.zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zones FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tables_salle ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tables_salle FORCE ROW LEVEL SECURITY;

-- Repas offerts (Kdo) : ils sont comptés dans `total` avec statut PAYEE, donc
-- ils gonflent le CA sans être identifiables. Les colonnes existent en local
-- depuis toujours, elles n'étaient simplement pas dans la liste blanche.
-- ATTENTION : ne vaudra que pour les commandes À VENIR — les lignes déjà
-- montées ne sont pas republiées, elles resteront à NULL.
ALTER TABLE public.commandes
  ADD COLUMN IF NOT EXISTS offert       BOOLEAN,
  ADD COLUMN IF NOT EXISTS motif_offert TEXT;

COMMENT ON COLUMN public.commandes.offert IS
  'Repas offert (Kdo). NULL pour les commandes montées avant le 2026-08-25.';


-- ── 2. Agrégations du tableau de bord ───────────────────────────────────────
--
-- Toutes en LANGUAGE sql STABLE, comme siege_ventes : le planificateur peut les
-- inliner, et elles ne modifient rien.

-- Heures de pic. Le fuseau est appliqué ICI : Abidjan est à UTC+0 toute
-- l'année, mais l'écrire rend la règle explicite et survit à un déplacement.
CREATE OR REPLACE FUNCTION siege_ventes_heure(p_debut TIMESTAMPTZ, p_fin TIMESTAMPTZ)
RETURNS TABLE (restaurant_id UUID, heure SMALLINT, nb BIGINT, ca BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT c.restaurant_id,
         EXTRACT(HOUR FROM c.created_at AT TIME ZONE 'Africa/Abidjan')::SMALLINT,
         count(*),
         COALESCE(sum(c.total), 0)::BIGINT
  FROM commandes c
  WHERE c.created_at >= p_debut AND c.created_at < p_fin AND c.statut = 'PAYEE'
  GROUP BY 1, 2;
$$;

-- Top des plats. `nom_snapshot` est le libellé FIGÉ au moment de la vente :
-- aucun uuid à résoudre, donc aucune dépendance au catalogue cloud (qui peut
-- être vide sur un site dont le catalogue a été importé en local).
-- `statut_cuisine <> 'ANNULE'` reprend la règle de apps/server/.../rapports.
CREATE OR REPLACE FUNCTION siege_top_plats(p_debut TIMESTAMPTZ, p_fin TIMESTAMPTZ)
RETURNS TABLE (restaurant_id UUID, nom TEXT, quantite BIGINT, total BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT c.restaurant_id,
         ci.nom_snapshot,
         COALESCE(sum(ci.quantite), 0)::BIGINT,
         COALESCE(sum(ci.prix_unitaire * ci.quantite), 0)::BIGINT
  FROM commande_items ci
  JOIN commandes c
    ON c.id = ci.commande_id AND c.restaurant_id = ci.restaurant_id
  WHERE c.created_at >= p_debut AND c.created_at < p_fin
    AND c.statut = 'PAYEE'
    AND COALESCE(ci.statut_cuisine, '') <> 'ANNULE'
    AND ci.nom_snapshot IS NOT NULL
  GROUP BY 1, 2;
$$;

CREATE OR REPLACE FUNCTION siege_par_mode(p_debut TIMESTAMPTZ, p_fin TIMESTAMPTZ)
RETURNS TABLE (restaurant_id UUID, mode TEXT, montant BIGINT, nb BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT p.restaurant_id, p.mode, COALESCE(sum(p.montant), 0)::BIGINT, count(*)
  FROM paiements p
  WHERE p.created_at >= p_debut AND p.created_at < p_fin
  GROUP BY 1, 2;
$$;

CREATE OR REPLACE FUNCTION siege_par_type(p_debut TIMESTAMPTZ, p_fin TIMESTAMPTZ)
RETURNS TABLE (restaurant_id UUID, type TEXT, partenaire TEXT, nb BIGINT, total BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT c.restaurant_id, c.type, c.partenaire, count(*), COALESCE(sum(c.total), 0)::BIGINT
  FROM commandes c
  WHERE c.created_at >= p_debut AND c.created_at < p_fin AND c.statut = 'PAYEE'
  GROUP BY 1, 2, 3;
$$;

-- Tables les plus utilisées. LEFT JOIN : une table supprimée du plan de salle
-- garde ses ventes passées, on ne les fait pas disparaître du total parce que
-- son libellé manque.
CREATE OR REPLACE FUNCTION siege_tables(p_debut TIMESTAMPTZ, p_fin TIMESTAMPTZ)
RETURNS TABLE (restaurant_id UUID, table_id UUID, numero TEXT, zone TEXT, nb BIGINT, total BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT c.restaurant_id,
         c.table_id,
         t.numero,
         z.nom,
         count(*),
         COALESCE(sum(c.total), 0)::BIGINT
  FROM commandes c
  LEFT JOIN tables_salle t ON t.id = c.table_id AND t.restaurant_id = c.restaurant_id
  LEFT JOIN zones z        ON z.id = t.zone_id  AND z.restaurant_id = c.restaurant_id
  WHERE c.created_at >= p_debut AND c.created_at < p_fin
    AND c.statut = 'PAYEE' AND c.table_id IS NOT NULL
  GROUP BY 1, 2, 3, 4;
$$;

-- RETOURS : plats DÉJÀ LANCÉS en cuisine qui ne seront pas vendus.
-- Les DEUX branches sont obligatoires (règle CLAUDE.md) : ne compter que la
-- ligne annulée laisserait la fraude la plus simple ouverte — encaisser, puis
-- supprimer la table entière au lieu de l'article.
CREATE OR REPLACE FUNCTION siege_retours(p_debut TIMESTAMPTZ, p_fin TIMESTAMPTZ)
RETURNS TABLE (restaurant_id UUID, nom TEXT, quantite BIGINT, montant BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT c.restaurant_id,
         ci.nom_snapshot,
         COALESCE(sum(ci.quantite), 0)::BIGINT,
         COALESCE(sum(ci.prix_unitaire * ci.quantite), 0)::BIGINT
  FROM commande_items ci
  JOIN commandes c
    ON c.id = ci.commande_id AND c.restaurant_id = ci.restaurant_id
  WHERE c.created_at >= p_debut AND c.created_at < p_fin
    AND ci.envoye_le IS NOT NULL
    AND (ci.statut_cuisine = 'ANNULE' OR c.statut = 'ANNULEE')
  GROUP BY 1, 2;
$$;

-- `supprime` exclu : l'outbox n'a pas d'opération DELETE, une dépense effacée
-- sur le site est republiée avec ce marqueur. L'inclure gonflerait les charges
-- du restaurant pour toujours.
CREATE OR REPLACE FUNCTION siege_depenses(p_debut TIMESTAMPTZ, p_fin TIMESTAMPTZ)
RETURNS TABLE (restaurant_id UUID, categorie TEXT, montant BIGINT, nb BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT d.restaurant_id, d.categorie, COALESCE(sum(d.montant), 0)::BIGINT, count(*)
  FROM depenses d
  WHERE d.created_at >= p_debut AND d.created_at < p_fin
    AND COALESCE(d.supprime, false) = false
  GROUP BY 1, 2;
$$;

-- Écarts par caissier. Le nom vient du rapport Z figé, qui le porte en clair ;
-- `utilisateurs_site` en repli, et l'uuid en dernier recours — un shift dont le
-- caissier a quitté le restaurant doit rester visible.
CREATE OR REPLACE FUNCTION siege_ecarts_caissier(p_debut TIMESTAMPTZ, p_fin TIMESTAMPTZ)
RETURNS TABLE (restaurant_id UUID, caissier TEXT, ecart BIGINT, nb_services BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT s.restaurant_id,
         COALESCE(s.rapport_z->>'caissier', u.nom_complet, s.caissier_id::TEXT, 'Inconnu'),
         COALESCE(sum(s.ecart), 0)::BIGINT,
         count(*)
  FROM services_caisse s
  LEFT JOIN utilisateurs_site u
    ON u.id = s.caissier_id AND u.restaurant_id = s.restaurant_id
  WHERE s.ouvert_le >= p_debut AND s.ouvert_le < p_fin AND s.statut = 'CLOTURE'
  GROUP BY 1, 2;
$$;

-- Heures travaillées. MÊME RÈGLE que le ticket Z de la console, à la lettre :
-- arrivée = l'heure du clic sur « Pointer » ; fin = l'heure de PAIE pour qui est
-- payé à la journée, l'heure de clôture du service sinon. Aucune seconde règle
-- ne doit exister — deux écrans qui comptent les heures différemment, c'est une
-- dispute de paie garantie.
CREATE OR REPLACE FUNCTION siege_equipe_periode(p_debut TIMESTAMPTZ, p_fin TIMESTAMPTZ)
RETURNS TABLE (
  restaurant_id UUID,
  utilisateur_id UUID,
  nom TEXT,
  poste TEXT,
  nb_services BIGINT,
  minutes BIGINT,
  salaire BIGINT
)
LANGUAGE sql STABLE AS $$
  WITH paie AS (
    SELECT d.restaurant_id, d.service_id, d.agent_id,
           sum(d.montant)::BIGINT AS montant,
           max(d.created_at)      AS paye_le
    FROM depenses d
    WHERE d.categorie = 'SALAIRES'
      AND COALESCE(d.supprime, false) = false
      AND d.agent_id IS NOT NULL
    GROUP BY 1, 2, 3
  )
  SELECT e.restaurant_id,
         e.utilisateur_id,
         COALESCE(u.nom_complet, 'Nom inconnu'),
         COALESCE(e.poste_jour, u.poste),
         count(*),
         COALESCE(sum(
           GREATEST(0, EXTRACT(EPOCH FROM
             COALESCE(pa.paye_le, s.cloture_le) - e.pointe_le) / 60)
         ), 0)::BIGINT,
         COALESCE(sum(pa.montant), 0)::BIGINT
  FROM equipe_service e
  JOIN services_caisse s
    ON s.id = e.service_id AND s.restaurant_id = e.restaurant_id
  LEFT JOIN utilisateurs_site u
    ON u.id = e.utilisateur_id AND u.restaurant_id = e.restaurant_id
  LEFT JOIN paie pa
    ON pa.service_id = e.service_id
   AND pa.agent_id = e.utilisateur_id
   AND pa.restaurant_id = e.restaurant_id
  WHERE s.ouvert_le >= p_debut AND s.ouvert_le < p_fin
    AND e.pointe_le IS NOT NULL
  GROUP BY 1, 2, 3, 4;
$$;

CREATE OR REPLACE FUNCTION siege_remises(p_debut TIMESTAMPTZ, p_fin TIMESTAMPTZ)
RETURNS TABLE (restaurant_id UUID, numero_ticket INTEGER, montant BIGINT, motif TEXT, created_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  SELECT c.restaurant_id, c.numero_ticket, c.remise_montant::BIGINT, c.remise_motif, c.created_at
  FROM commandes c
  WHERE c.created_at >= p_debut AND c.created_at < p_fin
    AND COALESCE(c.remise_montant, 0) > 0
  ORDER BY c.created_at DESC
  LIMIT 200;
$$;

CREATE OR REPLACE FUNCTION siege_annulations(p_debut TIMESTAMPTZ, p_fin TIMESTAMPTZ)
RETURNS TABLE (restaurant_id UUID, numero_ticket INTEGER, total BIGINT, created_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
  SELECT c.restaurant_id, c.numero_ticket, COALESCE(c.total, 0)::BIGINT, c.created_at
  FROM commandes c
  WHERE c.created_at >= p_debut AND c.created_at < p_fin AND c.statut = 'ANNULEE'
  ORDER BY c.created_at DESC
  LIMIT 200;
$$;

-- Inventaire : INFORMATION MANAGER. Le manquant n'entre ni dans la vente, ni
-- dans l'écart de caisse, et n'est jamais une retenue — la console le redit.
CREATE OR REPLACE FUNCTION siege_inventaire(p_debut TIMESTAMPTZ, p_fin TIMESTAMPTZ)
RETURNS TABLE (restaurant_id UUID, nb_inventaires BIGINT, montant_manquant BIGINT, nb_debloques BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT i.restaurant_id,
         count(*),
         COALESCE(sum(i.montant_manquant), 0)::BIGINT,
         count(*) FILTER (WHERE i.debloque_par IS NOT NULL)
  FROM inventaires_service i
  WHERE i.created_at >= p_debut AND i.created_at < p_fin
  GROUP BY 1;
$$;


-- ── Vérification ────────────────────────────────────────────────────────────
--
--   SELECT * FROM siege_ventes_heure(now() - interval '7 days', now());
--   SELECT * FROM siege_tables(now() - interval '7 days', now());
--
--  `siege_tables` renvoie `numero` NULL tant que `pnpm salle:republier` n'a pas
--  été lancé sur le site : le référentiel de salle ne monte pas tout seul,
--  l'outbox n'enregistre que les CHANGEMENTS et un plan de salle ne bouge
--  presque jamais. Voir docs/DEPLOIEMENT_CLOUD.md, étape 4 bis.
