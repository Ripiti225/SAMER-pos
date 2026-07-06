-- ============================================================================
-- SPRINT 4B+4C — Fondation : rôles composés de permissions.
-- Les employés existants conservent EXACTEMENT leurs accès : on crée les rôles
-- système avec leurs permissions actuelles et on raccorde chaque utilisateur.
-- ============================================================================

CREATE TABLE roles (
  id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom     TEXT NOT NULL UNIQUE,
  systeme BOOLEAN NOT NULL DEFAULT FALSE,
  actif   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE role_permissions (
  role_id        UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_cle TEXT NOT NULL,
  PRIMARY KEY (role_id, permission_cle)
);

-- role_id sur utilisateurs ; l'ancien enum role devient facultatif (les rôles
-- personnalisés n'ont pas de valeur d'enum).
ALTER TABLE utilisateurs ADD COLUMN role_id UUID REFERENCES roles(id);
ALTER TABLE utilisateurs ALTER COLUMN role DROP NOT NULL;

-- Rôles système
INSERT INTO roles (nom, systeme, actif) VALUES
  ('PROPRIETAIRE', TRUE, TRUE),
  ('SUPERVISEUR',  TRUE, TRUE),
  ('MANAGER',      TRUE, TRUE),
  ('CAISSIER',     TRUE, TRUE),
  ('SERVEUR',      TRUE, TRUE),
  ('CUISINE',      TRUE, TRUE)
ON CONFLICT (nom) DO NOTHING;

-- Permissions par rôle (miroir de PERMISSIONS_DEFAUT dans shared/permissions.ts)
INSERT INTO role_permissions (role_id, permission_cle)
SELECT r.id, p.cle FROM roles r
CROSS JOIN LATERAL unnest(ARRAY[
  'caisse.service.ouvrir','caisse.encaisser','caisse.remise','caisse.annuler_envoye',
  'caisse.rouvrir','caisse.cloturer','caisse.imprimer_note',
  'salle.commande','salle.envoyer_cuisine','salle.transferer_table','salle.voir_toutes_tables',
  'cuisine.avancer',
  'rapports.x','rapports.z','rapports.tableau_bord','rapports.notation',
  'reglages.equipe','reglages.salle','reglages.disponibilite','reglages.catalogue',
  'reglages.fidelite','reglages.parametres','reglages.pointage','reglages.audit','reglages.sante',
  'roles.gerer'
]) AS p(cle)
WHERE r.nom IN ('PROPRIETAIRE','SUPERVISEUR');

INSERT INTO role_permissions (role_id, permission_cle)
SELECT r.id, p.cle FROM roles r
CROSS JOIN LATERAL unnest(ARRAY[
  'caisse.service.ouvrir','caisse.encaisser','caisse.remise','caisse.annuler_envoye',
  'caisse.rouvrir','caisse.cloturer','caisse.imprimer_note',
  'salle.commande','salle.envoyer_cuisine','salle.transferer_table','salle.voir_toutes_tables',
  'rapports.x','rapports.z','rapports.notation',
  'reglages.equipe','reglages.salle','reglages.disponibilite','reglages.parametres',
  'reglages.pointage','reglages.audit','reglages.sante'
]) AS p(cle)
WHERE r.nom = 'MANAGER';

INSERT INTO role_permissions (role_id, permission_cle)
SELECT r.id, p.cle FROM roles r
CROSS JOIN LATERAL unnest(ARRAY[
  'caisse.service.ouvrir','caisse.encaisser','caisse.remise','caisse.annuler_envoye',
  'caisse.rouvrir','caisse.cloturer','caisse.imprimer_note',
  'salle.commande','salle.envoyer_cuisine','salle.transferer_table','salle.voir_toutes_tables'
]) AS p(cle)
WHERE r.nom = 'CAISSIER';

INSERT INTO role_permissions (role_id, permission_cle)
SELECT r.id, p.cle FROM roles r
CROSS JOIN LATERAL unnest(ARRAY['salle.commande','salle.envoyer_cuisine']) AS p(cle)
WHERE r.nom = 'SERVEUR';

INSERT INTO role_permissions (role_id, permission_cle)
SELECT r.id, 'cuisine.avancer' FROM roles r WHERE r.nom = 'CUISINE';

-- Raccordement : chaque utilisateur existant garde son rôle système.
UPDATE utilisateurs u SET role_id = r.id FROM roles r WHERE r.nom = u.role::text;
