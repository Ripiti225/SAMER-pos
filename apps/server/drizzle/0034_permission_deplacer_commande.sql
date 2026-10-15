-- Le déplacement évite une fausse annulation et donc un faux RETOUR.
-- Accordé par défaut aux rôles de caisse/encadrement ; reste modifiable dans
-- Réglages > Rôles & accès comme toute permission non protégée.
INSERT INTO role_permissions (role_id, permission_cle)
SELECT id, 'salle.deplacer_commande'
FROM roles
WHERE nom IN ('PROPRIETAIRE', 'SUPERVISEUR', 'MANAGER', 'CAISSIER')
ON CONFLICT DO NOTHING;
