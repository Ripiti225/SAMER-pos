-- Note des caissiers (2026-10-15) — lecture seule, descendue du cloud (flux
-- NOTES), calculée par SamerTrackly. Pas de clé étrangère vers utilisateurs :
-- une note arrivée avant le compte ne doit pas faire échouer la descente.
CREATE TABLE IF NOT EXISTS "notes_caissiers" (
  "id" uuid PRIMARY KEY NOT NULL,
  "note" numeric(4, 1),
  "note_precedente" numeric(4, 1),
  "appreciation" text,
  "nb_shifts" integer DEFAULT 0 NOT NULL,
  "min_shifts" integer DEFAULT 8 NOT NULL,
  "criteres" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "bonus" jsonb,
  "periode_debut" date,
  "periode_fin" date,
  "calcule_le" timestamp with time zone DEFAULT now() NOT NULL
);
