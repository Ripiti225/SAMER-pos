-- ============================================================================
-- ALLÈGEMENT — « Équipe du jour » : remplace le pointage géoloc/SMS.
-- À l'ouverture d'un service, le caissier coche les présents et ajuste leur
-- poste du jour (info + remontée back-office, pas de chronométrage).
-- ============================================================================

CREATE TABLE equipe_service (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id     UUID NOT NULL REFERENCES services_caisse(id) ON DELETE CASCADE,
  utilisateur_id UUID NOT NULL REFERENCES utilisateurs(id),
  poste_jour     TEXT NOT NULL,   -- valeur de POSTES_JOUR (shared)
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (service_id, utilisateur_id)
);

CREATE INDEX idx_equipe_service_service ON equipe_service (service_id);
