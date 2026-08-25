-- ════════════════════════════════════════════════════════════════════════════
--  DESCENTE DES PERMISSIONS DE RÔLE — côté CLOUD POS
--
--  Le siège change les accès d'un rôle pour plusieurs restaurants d'un coup
--  (console → onglet Paramètres). Jusqu'ici `role_permissions` ne servait qu'à
--  la MONTÉE : les sites y publiaient leurs rôles, le cloud ne renvoyait rien.
--
--  Une table de descente a trois choses que celle-ci n'avait pas :
--    1. une colonne `version`, alimentée par `bump_version()` ;
--    2. le trigger qui la bump à chaque écriture ;
--    3. l'index (restaurant_id, version), qui rend la descente incrémentale.
--
--  Sans elles, `sync-pull` filtre sur `version > N` et ne verrait JAMAIS une
--  ligne écrite par le siège : la diffusion partirait sans erreur et
--  n'arriverait nulle part.
--
--  À lancer dans pos-samer-cloud. Rejouable sans risque.
--
--  NB : la table `roles` n'est PAS rendue descendante, et ne doit pas l'être.
--  Son `nom` est UNIQUE côté site ; y pousser une ligne portant un uuid du
--  siège provoquerait une violation d'unicité qui annule la transaction de
--  descente — et c'est TOUT le flux du site qui s'arrête, catalogue compris.
--  Le siège vise donc le rôle par son NOM et n'envoie que le jeu de
--  permissions de l'id local, comme il vise la catégorie d'un article.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.role_permissions
  ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 0;

DROP TRIGGER IF EXISTS trg_version ON public.role_permissions;
CREATE TRIGGER trg_version
  BEFORE INSERT OR UPDATE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION bump_version();

CREATE INDEX IF NOT EXISTS idx_role_permissions_ver
  ON public.role_permissions (restaurant_id, version);

COMMENT ON COLUMN public.role_permissions.version IS
  'Séquence globale cloud (bump_version). Sert la descente incrémentale : sync-pull ne sert que les lignes dont version > le curseur du site.';


-- ── Vérification ────────────────────────────────────────────────────────────
--
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'role_permissions' AND column_name = 'version';
--
--   SELECT tgname FROM pg_trigger
--    WHERE tgrelid = 'role_permissions'::regclass AND NOT tgisinternal;
--
--  Les lignes déjà présentes gardent version = 0 : elles ne redescendront pas
--  tant que le siège n'y aura pas touché. C'est voulu — elles viennent des
--  sites eux-mêmes, les leur renvoyer ne servirait à rien.
