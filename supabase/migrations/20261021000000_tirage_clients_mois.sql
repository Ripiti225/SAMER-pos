-- ════════════════════════════════════════════════════════════════════════════
--  MEILLEURS CLIENTS DU MOIS ET TIRAGE AU SORT — console du siège
--
--  Programme de fidélité : chaque mois, dans chaque restaurant, un gagnant est
--  tiré au sort parmi les 20 clients qui y ont le plus dépensé. Chances égales
--  entre les 20 : le classement ne sert qu'à désigner les participants.
--
--  Deux choses ici :
--
--  1. `siege_clients_mois` — ce que chaque client fidélité a dépensé dans UN
--     restaurant sur UNE période. Agrégé en SQL, comme tout le tableau de bord :
--     un mois d'un restaurant fait plusieurs milliers de commandes, on ne les
--     rapatrie pas dans Deno.
--
--  2. `tirages_clients` — le procès-verbal du tirage. Infalsifiable :
--       * UN SEUL tirage par restaurant et par mois (contrainte d'unicité) :
--         on ne peut pas relancer jusqu'à tomber sur le gagnant voulu ;
--       * append-only (trigger) : ni modification ni suppression, même avec la
--         clé service_role — elle contourne la RLS, pas les triggers ;
--       * la liste des participants est FIGÉE dans la ligne : une vente montée
--         en retard après le tirage ne change pas, a posteriori, qui jouait.
--
--  Le tirage lui-même (l'aléa) se fait dans l'Edge Function `siege`, jamais
--  dans le navigateur.
--
--  À lancer dans pos-samer-cloud, PUIS redéployer la fonction `siege`.
--  Rejouable sans risque.
-- ════════════════════════════════════════════════════════════════════════════


-- ── 1. Dépense de chaque client sur la période ──────────────────────────────
--
-- À qui revient une vente ? Même règle que le crédit des points sur le site
-- (apps/server/src/modules/paiements/routes.ts), pour que « le client qui a le
-- plus dépensé » soit aussi celui qui a gagné le plus de points :
--
--   * une commande payée PAR SOUS-NOTES (le cas normal depuis le paiement par
--     articles : même un paiement simple ouvre une note couvrant tout le
--     ticket) → chaque note PAYEE revient au client de LA NOTE, pour son
--     montant. Une note sans client ne revient à personne — en paiement
--     partagé, le client fidélité de la table ne prend pas la part des autres ;
--   * une commande SANS sous-note (tickets d'avant le paiement par articles)
--     → le cloud ne connaît pas `commandes.client_fidelite_id` (la colonne ne
--     monte pas). Le client est retrouvé par la ligne de points GAGNÉS sur la
--     commande (`points_fidelite`, points > 0, sans note) : c'est exactement
--     la trace qu'a laissée le crédit de la vente.
--
-- Exclusions :
--   * statut autre que PAYEE (annulées, en cours) ;
--   * Kdo (`offert`) : un repas offert n'est pas un achat — le site ne crédite
--     d'ailleurs aucun point dessus. NULL (commandes montées avant le
--     2026-08-25) = pas offert ;
--   * livraisons YANGO / GLOVO : réglées chez le partenaire, pas au restaurant
--     (cf. PARTENAIRES_EXTERNES dans packages/shared). Samer Delly, livraison
--     propre du restaurant, encaisse au comptoir : elle compte.
--
-- Un client sans téléphone au cloud (fiche pas encore montée) est écarté : on
-- ne pourrait pas l'appeler s'il gagnait.
--
-- Le CLASSEMENT final (départage des ex aequo, limite à 20) est fait par
-- l'Edge Function (`_shared/siege-tirage.ts`, testé). D'où `rank()` et non
-- `row_number()` : tous les ex aequo du 20e rang reviennent, et c'est le code
-- testé qui les départage — pas l'ordre physique des lignes.
CREATE OR REPLACE FUNCTION siege_clients_mois(
  p_restaurant_id UUID,
  p_debut         TIMESTAMPTZ,
  p_fin           TIMESTAMPTZ,
  p_limite        INTEGER DEFAULT 20
)
RETURNS TABLE (
  client_id  UUID,
  telephone  TEXT,
  nom        TEXT,
  montant    BIGINT,
  nb_visites BIGINT
)
LANGUAGE sql STABLE AS $$
  WITH cmd AS (
    SELECT c.id, c.total
    FROM commandes c
    WHERE c.restaurant_id = p_restaurant_id
      AND c.created_at >= p_debut AND c.created_at < p_fin
      AND c.statut = 'PAYEE'
      AND c.offert IS NOT TRUE
      AND (c.partenaire IS NULL OR c.partenaire NOT IN ('YANGO', 'GLOVO'))
  ),
  parts AS (
    -- Paiement par sous-notes : la part de chaque note revient à SON client.
    SELECT n.client_fidelite_id AS client_id, n.commande_id, COALESCE(n.montant, 0)::BIGINT AS montant
    FROM notes_split n
    JOIN cmd ON cmd.id = n.commande_id
    WHERE n.restaurant_id = p_restaurant_id
      AND n.statut = 'PAYEE'
      AND n.client_fidelite_id IS NOT NULL

    UNION ALL

    -- Commande sans sous-note : le client est celui qui a gagné les points.
    SELECT credit.client_id, cmd.id, COALESCE(cmd.total, 0)::BIGINT
    FROM cmd
    JOIN LATERAL (
      SELECT p.client_id
      FROM points_fidelite p
      WHERE p.restaurant_id = p_restaurant_id
        AND p.commande_id = cmd.id
        AND p.note_id IS NULL
        AND p.points > 0
        AND p.client_id IS NOT NULL
      ORDER BY p.created_at
      LIMIT 1
    ) credit ON true
    WHERE NOT EXISTS (
      SELECT 1 FROM notes_split n
      WHERE n.restaurant_id = p_restaurant_id
        AND n.commande_id = cmd.id
        AND n.statut <> 'ANNULEE'
    )
  ),
  totaux AS (
    -- Une visite = une commande : deux notes du même client sur la même table
    -- ne font qu'une visite.
    SELECT parts.client_id, sum(parts.montant)::BIGINT AS montant, count(DISTINCT parts.commande_id) AS nb_visites
    FROM parts
    GROUP BY parts.client_id
  ),
  classes AS (
    SELECT t.client_id, cf.telephone, cf.nom, t.montant, t.nb_visites,
           rank() OVER (ORDER BY t.montant DESC) AS rang
    FROM totaux t
    JOIN clients_fidelite cf
      ON cf.restaurant_id = p_restaurant_id AND cf.id = t.client_id
    WHERE t.montant > 0
      AND NULLIF(btrim(cf.telephone), '') IS NOT NULL
  )
  SELECT client_id, btrim(telephone), NULLIF(btrim(nom), ''), montant, nb_visites
  FROM classes
  WHERE rang <= p_limite
  ORDER BY montant DESC;
$$;

COMMENT ON FUNCTION siege_clients_mois(UUID, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) IS
  'Dépense des clients fidélité d''un restaurant sur une période (commandes PAYEE, hors Kdo et hors Yango/Glovo). Rend les ex aequo du dernier rang : le départage est fait par la fonction `siege`.';


-- ── 2. Procès-verbal des tirages ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tirages_clients (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id      UUID NOT NULL,
  -- Premier jour du mois concerné (2026-10-01 pour « octobre 2026 »).
  mois               DATE NOT NULL CHECK (mois = date_trunc('month', mois)::date),
  tire_le            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Qui a lancé le tirage : le compte du siège, et son NOM tel qu'il était ce
  -- jour-là (un compte peut être renommé ou supprimé, le PV ne doit pas bouger).
  tire_par           UUID NOT NULL,
  tire_par_nom       TEXT NOT NULL,
  -- Les participants, figés au moment du tirage, dans l'ordre du classement :
  -- [{ rang, client_id, telephone, nom, montant, nb_visites }, …]
  participants       JSONB NOT NULL
                     CHECK (jsonb_typeof(participants) = 'array'
                            AND jsonb_array_length(participants) BETWEEN 1 AND 20),
  gagnant_client_id  UUID NOT NULL,
  gagnant_rang       SMALLINT NOT NULL CHECK (gagnant_rang >= 1),
  -- Le gagnant est FORCÉMENT l'un des participants listés.
  CONSTRAINT tirages_clients_gagnant_participant
    CHECK (participants @> jsonb_build_array(jsonb_build_object('client_id', gagnant_client_id))),
  -- Un seul tirage par restaurant et par mois : pas de « on relance ».
  CONSTRAINT tirages_clients_un_par_mois UNIQUE (restaurant_id, mois)
);

CREATE INDEX IF NOT EXISTS idx_tirages_clients_mois ON public.tirages_clients (mois DESC);

-- Append-only : un tirage ne se corrige pas, ne s'efface pas. Même schéma que
-- le trigger de `audit_log` côté site.
CREATE OR REPLACE FUNCTION tirages_clients_immuable()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Un tirage au sort enregistré ne peut être ni modifié ni supprimé';
END;
$$;

DROP TRIGGER IF EXISTS trg_tirages_clients_immuable ON public.tirages_clients;
CREATE TRIGGER trg_tirages_clients_immuable
  BEFORE UPDATE OR DELETE ON public.tirages_clients
  FOR EACH ROW EXECUTE FUNCTION tirages_clients_immuable();

DROP TRIGGER IF EXISTS trg_tirages_clients_immuable_truncate ON public.tirages_clients;
CREATE TRIGGER trg_tirages_clients_immuable_truncate
  BEFORE TRUNCATE ON public.tirages_clients
  FOR EACH STATEMENT EXECUTE FUNCTION tirages_clients_immuable();

-- RLS forcée sans politique, comme tout le cloud : seule la fonction `siege`
-- (service_role) lit et écrit ici.
ALTER TABLE public.tirages_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tirages_clients FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.tirages_clients IS
  'Tirages au sort des meilleurs clients du mois, un par restaurant et par mois. Append-only. Écrite par la fonction `siege` (compte ADMIN), qui fait le tirage côté serveur.';


-- ── Vérification ────────────────────────────────────────────────────────────
--
--   SELECT * FROM siege_clients_mois('<restaurant_id>', '2026-10-01', '2026-11-01');
--
--   SELECT restaurant_id, mois, tire_le, tire_par_nom, gagnant_rang,
--          jsonb_array_length(participants)
--     FROM tirages_clients ORDER BY mois DESC, restaurant_id;
--
--  Doit échouer (append-only) :
--   UPDATE tirages_clients SET gagnant_rang = 1;
