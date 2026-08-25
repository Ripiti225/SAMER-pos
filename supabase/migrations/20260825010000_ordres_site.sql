-- ════════════════════════════════════════════════════════════════════════════
--  ORDRES DU SIÈGE — le premier canal cloud → site
--
--  Jusqu'ici rien ne descendait du siège vers un site sinon des DONNÉES :
--  la descente est un UPSERT de catalogue qui « ne touche JAMAIS aux tables de
--  ventes ». Or raser une séquence écrit `sequences_caisse` et
--  `services_caisse` — c'est une ACTION, pas une donnée. D'où cette table :
--  une file d'ordres que chaque site vient chercher, exécute, puis acquitte.
--
--  `actions_recues` (déjà en place côté POS) sert d'anti-doublon : l'uuid de
--  l'ordre y est inséré avant exécution, un rejeu est donc sans effet. C'est le
--  même mécanisme que pour les actions de la tablette serveur.
--
--  À lancer dans pos-samer-cloud. Rejouable sans risque.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.ordres_site (
  id            UUID PRIMARY KEY,
  restaurant_id UUID NOT NULL,

  -- Un seul type aujourd'hui : 'RASER_SEQUENCE'. La colonne existe pour que le
  -- prochain n'exige pas de migration.
  type          TEXT NOT NULL,

  -- Paramètres de l'ordre. Pour RASER_SEQUENCE :
  --   sequence_id : la séquence QUE LE SIÈGE A VUE (garde-fou d'obsolescence) ;
  --   service_ids : les shifts à retenir, ou absent pour « tous les clôturés ».
  params        JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Qui a demandé. Le site n'a pas de compte pour cette personne : on garde son
  -- NOM, qui finira sur le papier remis au gérant et au journal d'audit.
  demandeur     TEXT NOT NULL,
  demandeur_id  UUID,

  statut        TEXT NOT NULL DEFAULT 'EN_ATTENTE'
                CHECK (statut IN ('EN_ATTENTE', 'EXECUTE', 'ECHEC', 'EXPIRE')),

  cree_le       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Au-delà, le site refuse d'exécuter. Un ordre émis pendant que le site est
  -- hors ligne ne doit pas se déclencher trois jours plus tard sur la recette
  -- d'un autre jour : mieux vaut qu'il expire et que le siège le refasse.
  expire_le     TIMESTAMPTZ NOT NULL DEFAULT now() + interval '6 hours',
  execute_le    TIMESTAMPTZ,

  -- Ce que le site répond : le rapport de séquence, ou le motif du refus.
  resultat      JSONB,
  erreur        TEXT
);

-- Le site ne demande que ses ordres en attente, dans l'ordre d'arrivée.
CREATE INDEX IF NOT EXISTS idx_ordres_site_attente
  ON public.ordres_site (restaurant_id, statut, cree_le);

ALTER TABLE public.ordres_site ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ordres_site FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.ordres_site IS
  'File d''ordres du siège vers un site. Lue et acquittée par la fonction `ordres` (clé de site), écrite par la fonction `siege` (compte du siège). RLS forcée sans politique : rien n''y accède hors service_role.';
COMMENT ON COLUMN public.ordres_site.expire_le IS
  'Passé ce délai le site refuse d''exécuter — un ordre en retard tomberait sur la recette d''un autre jour.';


-- ────────────────────────────────────────────────────────────────────────────
--  `services_caisse.sequence_id` — sans lui, le siège ne peut pas MONTRER ce
--  qu'il s'apprête à raser.
--
--  Le cloud reçoit les shifts et les séquences, mais rien ne les relie : la
--  colonne existe en local depuis toujours et n'était pas dans la liste de
--  montée. La console afficherait donc « raser la séquence » sans pouvoir dire
--  quels shifts elle contient, ni pour quel montant. Pour un geste qui fige la
--  journée d'un restaurant, c'est inacceptable.
--
--  À ajouter AUSSI dans `_shared/tables.ts` (COLONNES_VENTES.services_caisse),
--  sinon sync-push filtre la colonne en silence.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.services_caisse
  ADD COLUMN IF NOT EXISTS sequence_id UUID;

CREATE INDEX IF NOT EXISTS idx_cloud_services_sequence
  ON public.services_caisse (restaurant_id, sequence_id);

COMMENT ON COLUMN public.services_caisse.sequence_id IS
  'Séquence (journée) à laquelle ce shift appartient. NULL pour les shifts montés avant le 2026-08-25.';


-- ── Vérification ────────────────────────────────────────────────────────────
--
--   SELECT id, type, statut, demandeur, cree_le, expire_le, erreur
--     FROM ordres_site ORDER BY cree_le DESC LIMIT 20;
--
--  Un ordre qui reste EN_ATTENTE au-delà de `expire_le` : le site n'est pas
--  venu le chercher (hors ligne, ou synchro désactivée).
