-- À appliquer dans le projet Supabase SamerTrackly avant de déployer le pont.
-- L'application SamerTrackly peut afficher ce texte juste sous `ecart_pos`.
ALTER TABLE public.points_shifts
  ADD COLUMN IF NOT EXISTS explication_ecart TEXT;

COMMENT ON COLUMN public.points_shifts.explication_ecart IS
  'Explication donnée par le caissier lors de la validation de son écart POS.';
