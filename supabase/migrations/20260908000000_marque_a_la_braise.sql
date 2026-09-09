-- Troisième marque du groupe : À la Braise (créée chez SamerTrackly le
-- 2026-09-05). Le POS l'accepte depuis la migration locale `0031_a_la_braise`,
-- mais le cloud, lui, refusait encore la valeur : l'INSERT d'enrôlement du site
-- serait tombé sur le CHECK, avec un message Postgres illisible pour la personne
-- qui installe le mini-PC. La contrainte est recréée sous le même nom, sinon
-- Postgres en fabrique un second (`restaurants_marque_check1`) et la migration
-- cesse d'être rejouable.
ALTER TABLE public.restaurants DROP CONSTRAINT IF EXISTS restaurants_marque_check;
ALTER TABLE public.restaurants ADD CONSTRAINT restaurants_marque_check
  CHECK (marque IN ('SAMER', 'AL_KAYAN', 'A_LA_BRAISE'));
