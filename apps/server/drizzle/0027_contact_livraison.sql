-- Contact client sur les commandes partenaires (2026-08-25).
--
-- POURQUOI — une commande Yango ou Glovo part en cuisine sans qu'on sache la
-- rattacher à quoi que ce soit : `ref_partenaire` existait depuis le début mais
-- aucun écran ne le demandait, et le numéro du client n'était nulle part. Un
-- litige avec un partenaire (« cette commande n'est jamais arrivée ») se réglait
-- donc de mémoire, et un client livré ne pouvait pas être rappelé.
--
-- Ces deux informations se saisissent AU LANCEMENT EN CUISINE, dans une modale
-- qui s'ouvre une fois la commande partie : la cuisine n'attend jamais après une
-- saisie. Le caissier peut fermer sans rien mettre — d'où le décompte
-- « commandes / contacts » du ticket Z (5 commandes, 4 contacts), qui rend le
-- trou VISIBLE au lieu de le laisser passer.
--
-- Rejouable : ADD COLUMN IF NOT EXISTS.
ALTER TABLE "commandes"
  ADD COLUMN IF NOT EXISTS "contact_client" text;
