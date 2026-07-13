-- Équipe : photo, intitulé de poste, disponibilité RH (malade / congé / permission).
CREATE TYPE "disponibilite_employe" AS ENUM ('PRESENT', 'MALADE', 'CONGE', 'PERMISSION');
--> statement-breakpoint
ALTER TABLE "utilisateurs" ADD COLUMN "poste" text;
--> statement-breakpoint
ALTER TABLE "utilisateurs" ADD COLUMN "photo_url" text;
--> statement-breakpoint
ALTER TABLE "utilisateurs" ADD COLUMN "disponibilite" "disponibilite_employe" DEFAULT 'PRESENT' NOT NULL;
