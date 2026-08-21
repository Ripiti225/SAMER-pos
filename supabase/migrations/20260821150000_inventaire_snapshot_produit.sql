-- ════════════════════════════════════════════════════════════════════════════
--  Snapshot produit sur les lignes d'inventaire — côté CLOUD POS
--
--  Pendant cloud de la migration locale 0026_inventaire_snapshot_produit.sql.
--  À lancer dans pos-samer-cloud. Rejouable sans risque.
--
--  Le cloud reçoit `inventaire_lignes.produit_id` : un uuid généré sur le
--  mini-PC, que rien ici ne sait traduire — `produits_inventaire` est une table
--  de DESCENTE, remplie par le siège, jamais remontée par les sites. Elle est
--  vide, et le resterait même remplie : le siège créerait un jeu d'uuid de plus.
--
--  Les sites envoient désormais le code, le nom et le prix avec chaque ligne.
--  Ces colonnes sont ajoutées aux listes blanches de montée dans
--  `_shared/tables.ts` — sans quoi sync-push les filtrerait en silence.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.inventaire_lignes
  ADD COLUMN IF NOT EXISTS produit_code text,
  ADD COLUMN IF NOT EXISTS produit_nom  text,
  ADD COLUMN IF NOT EXISTS produit_prix integer;

ALTER TABLE public.entrees_stock
  ADD COLUMN IF NOT EXISTS produit_code text,
  ADD COLUMN IF NOT EXISTS produit_nom  text;

COMMENT ON COLUMN public.inventaire_lignes.produit_code IS
  'Code produit figé par le site (= inventaire_lignes.produit_id chez SamerTrackly). NULL pour les lignes montées avant le 2026-08-21.';
COMMENT ON COLUMN public.inventaire_lignes.produit_prix IS
  'Prix ayant servi au comptage sur le site, pas celui du catalogue au moment du transfert.';


-- ── Vérification ────────────────────────────────────────────────────────────
--
--   SELECT count(*) FILTER (WHERE produit_code IS NULL)  AS sans_code,
--          count(*) FILTER (WHERE produit_code IS NOT NULL) AS avec_code
--     FROM inventaire_lignes;
--
--   Tant que `avec_code` vaut 0, le site n'a pas encore la migration locale 0026
--   ou n'a rien remonté depuis : le pont refusera d'écrire (garde-fou de
--   samtrackly-inventaire.ts) plutôt que d'inventer un inventaire vide.
