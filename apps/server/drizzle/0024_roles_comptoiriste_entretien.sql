-- Rôles COMPTOIRISTE et ENTRETIEN (2026-08-17).
--
-- Ils existaient dans le restaurant, pas dans le POS. La descente SamerTrackly
-- (`mapPosteRole`) rangeait :
--   * « Comptoiriste » (18 personnes) avec les CAISSIERS → encaissement,
--     remise, réouverture d'une commande payée, clôture de service ;
--   * « Technicien de surface », « Ménagère », « Plongeuse », « Plonge »
--     (5 personnes) avec la CUISINE, `poste_cuisine` vide → or l'attribution
--     des plats se rabat sur CUISINIER quand ce champ est vide, donc ces
--     employés se voyaient créditer des plats qu'ils n'ont jamais préparés.
--
-- Tranché par le boss le 2026-08-17 :
--   * COMPTOIRISTE = écran cuisine seulement, jamais la caisse. Son
--     `poste_cuisine` devient COMPTOIRISTE, ce qui active enfin l'attribution
--     des plats du comptoir (le poste existait, personne n'y était affecté).
--   * ENTRETIEN = aucune application. Le compte existe pour l'équipe du jour
--     et les présences.
--
-- Idempotent.

-- 1) L'ancien enum `role_pos` porte encore la colonne `utilisateurs.role`, que
--    `attribution.ts` interroge. Les deux valeurs doivent y entrer, sinon la
--    descente échouerait à écrire le rôle.
--    Note : on n'UTILISE aucune de ces valeurs dans cette migration — PostgreSQL
--    l'interdit dans la transaction qui les crée.
ALTER TYPE role_pos ADD VALUE IF NOT EXISTS 'COMPTOIRISTE';
--> statement-breakpoint
ALTER TYPE role_pos ADD VALUE IF NOT EXISTS 'ENTRETIEN';
--> statement-breakpoint

-- 2) Les rôles eux-mêmes. `roles.nom` est du TEXTE (pas l'enum) : aucun
--    problème de transaction ici.
INSERT INTO roles (nom, systeme, actif)
VALUES ('COMPTOIRISTE', TRUE, TRUE), ('ENTRETIEN', TRUE, TRUE)
ON CONFLICT (nom) DO UPDATE SET systeme = TRUE, actif = TRUE;
--> statement-breakpoint

-- 3) Permissions. COMPTOIRISTE = `cuisine.avancer` et rien d'autre : c'est
--    cette absence qui lui ferme la caisse (`peutAccederCaisse()` refuse un
--    compte dont toutes les permissions sont purement cuisine).
--    ENTRETIEN n'en reçoit AUCUNE — voulu, pas un oubli.
INSERT INTO role_permissions (role_id, permission_cle)
SELECT r.id, 'cuisine.avancer' FROM roles r WHERE r.nom = 'COMPTOIRISTE'
ON CONFLICT (role_id, permission_cle) DO NOTHING;
