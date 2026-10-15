-- Ajoute le nouveau droit aux jeux de permissions déjà publiés dans le cloud.
-- Les rôles sans ce droit restent inchangés ; l'écran Rôles & accès permet
-- ensuite de l'ajouter ou de le retirer restaurant par restaurant.
UPDATE public.role_permissions rp
SET permissions = COALESCE(rp.permissions, '[]'::jsonb) || '"salle.deplacer_commande"'::jsonb
WHERE EXISTS (
  SELECT 1 FROM public.roles r
  WHERE r.restaurant_id = rp.restaurant_id
    AND r.id = rp.role_id
    AND r.nom IN ('PROPRIETAIRE', 'SUPERVISEUR', 'MANAGER', 'CAISSIER')
)
AND NOT COALESCE(rp.permissions, '[]'::jsonb) @> '["salle.deplacer_commande"]'::jsonb;
