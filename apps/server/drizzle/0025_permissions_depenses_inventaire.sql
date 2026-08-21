-- Permissions Dépenses / Inventaire / Pointage (2026-08-17).
--
-- Ces trois modules (DESIGN_V2 § 6.7 à § 6.10) étaient gardés par
-- `caisse.service.ouvrir`. Conséquences : invisibles dans « Rôles & accès »,
-- donc impossibles à accorder ou à retirer ; et surtout, quiconque pouvait
-- ouvrir un service pouvait sortir de l'argent du tiroir (salaires,
-- encouragements) et faire passer une clôture sans inventaire conforme.
--
-- CETTE MIGRATION EST INDISPENSABLE, pas cosmétique. `etablirRolesSysteme()`
-- n'est appelé que par le seed : sur une base déjà installée, les nouvelles
-- permissions n'existeraient sur AUCUN rôle et plus personne ne pourrait
-- enregistrer une dépense ni valider un inventaire. C'est exactement l'objection
-- qui avait fait renoncer à créer ces permissions à l'époque — elle se règle
-- ici.
--
-- RÈGLE APPLIQUÉE : personne ne perd d'accès (sprint 4B, définition de
-- « terminé » n° 1). Tout rôle qui possède `caisse.service.ouvrir` aujourd'hui
-- reçoit les sept nouvelles permissions — c'est très exactement ce qu'il
-- pouvait faire hier. Le durcissement (retirer « Payer un salaire » et
-- « Débloquer une clôture » au CAISSIER) est ensuite un réglage à deux clics
-- dans Rôles & accès, et c'est au boss de le décider, pas à une migration.
--
-- Idempotent.
INSERT INTO role_permissions (role_id, permission_cle)
SELECT r.id, p.cle
  FROM roles r
  CROSS JOIN (VALUES
    ('depenses.saisir'),
    ('depenses.supprimer'),
    ('depenses.paie'),
    ('inventaire.saisir'),
    ('inventaire.valider'),
    ('inventaire.debloquer'),
    ('pointage.gerer')
  ) AS p(cle)
 WHERE EXISTS (
   SELECT 1 FROM role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_cle = 'caisse.service.ouvrir'
 )
ON CONFLICT (role_id, permission_cle) DO NOTHING;
--> statement-breakpoint

-- PROPRIETAIRE et SUPERVISEUR ont tout par construction (le guard les laisse
-- passer même sans ligne — garde anti-verrouillage du 1.5). On pose quand même
-- les lignes pour que l'écran « Rôles & accès » affiche des cases cochées et
-- non un rôle qui aurait l'air amputé.
INSERT INTO role_permissions (role_id, permission_cle)
SELECT r.id, p.cle
  FROM roles r
  CROSS JOIN (VALUES
    ('depenses.saisir'),
    ('depenses.supprimer'),
    ('depenses.paie'),
    ('inventaire.saisir'),
    ('inventaire.valider'),
    ('inventaire.debloquer'),
    ('pointage.gerer')
  ) AS p(cle)
 WHERE r.nom IN ('PROPRIETAIRE', 'SUPERVISEUR')
ON CONFLICT (role_id, permission_cle) DO NOTHING;
