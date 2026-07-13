-- Lien vers SamerTrackly (RH) : id externe de l'employé, pour la synchro auto.
ALTER TABLE "utilisateurs" ADD COLUMN "externe_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "un_externe_id" ON "utilisateurs" ("externe_id") WHERE "externe_id" IS NOT NULL;
