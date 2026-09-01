-- Mémorise l'explication effectivement envoyée à Samtrackly.
-- Les anciens transferts restent à NULL : si le POS possède déjà une
-- explication, le pont les détectera et les rejouera automatiquement une fois.
ALTER TABLE public.samtrackly_transferts
  ADD COLUMN IF NOT EXISTS explication_ecart_transferee TEXT;

COMMENT ON COLUMN public.samtrackly_transferts.explication_ecart_transferee IS
  'Dernière explication_ecart envoyée à Samtrackly, normalisée et vide si absente.';
