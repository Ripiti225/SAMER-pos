-- Monnaie rendue — miroir cloud multi-restaurant.
-- Sans ces colonnes, `sync-push` refuse les paiements du POS mis à jour et
-- l'outbox s'accumule : appliquer AVANT de redéployer la fonction.
ALTER TABLE paiements
  ADD COLUMN IF NOT EXISTS montant_recu   INTEGER,
  ADD COLUMN IF NOT EXISTS monnaie_rendue INTEGER;
