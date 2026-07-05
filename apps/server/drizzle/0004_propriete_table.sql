-- ============================================================================
-- CORRECTIONS3 — Point 3 : propriété de table
-- La table appartient au serveur qui l'a ouverte. Un autre serveur ne peut
-- pas y accéder ; caissier/manager/propriétaire, si.
-- ============================================================================

ALTER TABLE tables_salle ADD COLUMN ouverte_par UUID REFERENCES utilisateurs(id);
