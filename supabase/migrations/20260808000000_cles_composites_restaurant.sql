-- ============================================================================
-- Cloisonnement par restaurant : PK composite (restaurant_id, id).
--
-- Pourquoi : l'image de déploiement (dossier POS-Samer, `data/pgdata` inclus)
-- est copiée telle quelle sur les 7 sites. Les lignes seedées y portent donc
-- les MÊMES UUID partout (catalogue importé de l'export, comptes, restaurant).
-- Avec une PK = id seul, la ligne « chawarma » de Palmeraie et celle du 7E
-- étaient la MÊME ligne cloud : le premier upsert d'un site réécrivait le
-- restaurant_id de l'autre, et son catalogue disparaissait de sa descente.
--
-- Après cette migration, deux restaurants peuvent porter le même UUID sans
-- jamais s'écraser, et tout UPSERT doit cibler (restaurant_id, id).
-- Idempotent : rejouable sans effet si les PK sont déjà composites.
-- ============================================================================

DO $$
DECLARE
  t     TEXT;
  pk    TEXT;
  ncols INT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- montée (ventes)
    'commandes','commande_items','notes_split','paiements','services_caisse',
    'audit_log','pointages','clients_fidelite','points_fidelite',
    -- descente (catalogue / promotions / utilisateurs)
    'categories','articles','prix_canaux','groupes_options','options',
    'supplements','combos','combo_articles','promotions','utilisateurs'
  ]
  LOOP
    -- Un cloud plus ancien peut ne pas avoir toutes les tables (sprint 4) :
    -- on les saute au lieu de faire échouer tout le bloc (DO = atomique).
    CONTINUE WHEN to_regclass(t) IS NULL;

    SELECT c.conname, array_length(c.conkey, 1)
      INTO pk, ncols
      FROM pg_constraint c
     WHERE c.conrelid = t::regclass AND c.contype = 'p';

    IF pk IS NOT NULL AND ncols = 1 THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, pk);
    END IF;

    IF pk IS NULL OR ncols = 1 THEN
      -- DROP CONSTRAINT peut laisser tomber le NOT NULL implicite : on le repose.
      EXECUTE format('ALTER TABLE %I ALTER COLUMN id SET NOT NULL', t);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN restaurant_id SET NOT NULL', t);
      EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY (restaurant_id, id)', t);
    END IF;
  END LOOP;
END $$;

-- `parametres_locaux` (barème fidélité descendu du siège) avait été oublié dans
-- la boucle RLS d'origine : sans RLS, la clé anon de Supabase peut lire la
-- table (les GRANT par défaut restent en place). On la verrouille comme les
-- autres — seules les Edge Functions (service_role) y accèdent.
DO $$
BEGIN
  IF to_regclass('parametres_locaux') IS NOT NULL THEN
    ALTER TABLE parametres_locaux ENABLE ROW LEVEL SECURITY;
    ALTER TABLE parametres_locaux FORCE ROW LEVEL SECURITY;
  END IF;
END $$;
