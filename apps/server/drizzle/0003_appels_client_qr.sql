-- ============================================================================
-- CORRECTIONS 3 — Point 1 : circuit client ↔ serveur (appels + commande client)
-- Principe : le client interagit avec SON serveur ; la caisse est le repli ;
-- la cuisine n'est JAMAIS contactée directement par un client.
-- ============================================================================

-- Appels d'une table depuis le téléphone client (QR).
CREATE TABLE appels_table (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id    UUID NOT NULL REFERENCES tables_salle(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('APPEL_SERVEUR','DEMANDE_FACTURE')),
  statut      TEXT NOT NULL DEFAULT 'EN_ATTENTE' CHECK (statut IN ('EN_ATTENTE','TRAITE')),
  cree_le     TIMESTAMPTZ NOT NULL DEFAULT now(),
  traite_le   TIMESTAMPTZ,
  traite_par  UUID REFERENCES utilisateurs(id)
);
-- Anti-doublon : un seul appel EN_ATTENTE par (table, type).
CREATE UNIQUE INDEX un_appel_en_attente_par_table_type
  ON appels_table (table_id, type) WHERE statut = 'EN_ATTENTE';

-- Origine d'une commande : distingue une proposition CLIENT_QR (à valider,
-- jamais envoyée en cuisine sans validation) d'une prise CAISSE ou SERVEUR.
ALTER TABLE commandes
  ADD COLUMN origine TEXT NOT NULL DEFAULT 'CAISSE'
  CHECK (origine IN ('CAISSE','SERVEUR','CLIENT_QR'));

-- Motif de refus d'une commande client (message montré au client).
ALTER TABLE commandes ADD COLUMN refus_motif TEXT;
