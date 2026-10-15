-- Verrouillage automatique par inactivité : DÉSACTIVÉ (décision du 2026-07-12).
-- La décision n'avait été appliquée qu'aux installations neuves : les postes
-- installés avant gardaient l'ancien défaut (600 s caisse, 120 s tablette) et
-- se verrouillaient seuls après 10 minutes sans toucher l'écran.
--
-- On ne remet à 0 QUE l'ancien défaut exact. Un délai choisi à la main dans
-- Réglages → Paramètres (toute autre valeur) est respecté.
UPDATE "parametres_locaux" SET "valeur" = '0'::jsonb, "updated_at" = now()
 WHERE "cle" = 'verrou_inactivite_caisse_secondes' AND "valeur" = '600'::jsonb;
--> statement-breakpoint
UPDATE "parametres_locaux" SET "valeur" = '0'::jsonb, "updated_at" = now()
 WHERE "cle" = 'verrouillage_inactivite_serveur_secondes' AND "valeur" = '120'::jsonb;
