-- Champs modifiés à la main dans le POS : la synchro SamerTrackly ne les écrase plus.
ALTER TABLE "utilisateurs" ADD COLUMN "champs_manuels" jsonb DEFAULT '[]'::jsonb NOT NULL;
