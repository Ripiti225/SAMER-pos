-- Paiement avec les points fidélité du client rattaché : un mode à part entière,
-- pour que le ticket Z, la clôture et le point SamerTrackly le montrent.
-- Aucun argent reçu — jamais déclaré par le caissier, jamais dans le tiroir.
ALTER TYPE "mode_paiement" ADD VALUE IF NOT EXISTS 'POINTS';
