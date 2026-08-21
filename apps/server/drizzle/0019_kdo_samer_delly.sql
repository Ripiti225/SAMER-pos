-- Kdo (repas offert) + renommage « Samer Deliv » → « Samer Delly » (choix client).
-- Migration DELTA écrite à la main : drizzle-kit n'a pas de snapshot des
-- migrations 0000-0018, `generate` redéposerait tout le schéma.

-- 1. Renommage du partenaire. Aucune contrainte CHECK ne porte sur ces valeurs
-- (partenaire et canal sont du TEXT libre) : de simples UPDATE suffisent.
-- Les rapports Z déjà FIGÉS (services_caisse.rapport_z, sequences_caisse.rapport)
-- gardent volontairement 'SAMER_DELIV' : ce sont des archives immuables, on ne
-- réécrit pas l'histoire — l'affichage sait lire les deux codes.
UPDATE "commandes" SET "partenaire" = 'SAMER_DELLY' WHERE "partenaire" = 'SAMER_DELIV';--> statement-breakpoint
UPDATE "prix_canaux" SET "canal" = 'SAMER_DELLY' WHERE "canal" = 'SAMER_DELIV';--> statement-breakpoint
UPDATE "tables_salle" SET "partenaire" = 'SAMER_DELLY', "numero" = 'SAMER DELLY' WHERE "partenaire" = 'SAMER_DELIV';--> statement-breakpoint

-- 2. Commande offerte (Kdo). Elle passe à PAYEE sans aucune ligne de paiement :
-- elle compte donc dans la vente du shift (comme une livraison Yango) mais
-- n'entre JAMAIS dans le théorique espèces, qui ne se calcule qu'à partir des
-- paiements réellement encaissés. Le motif est obligatoire côté serveur.
ALTER TABLE "commandes" ADD COLUMN "offert" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "commandes" ADD COLUMN "motif_offert" text;--> statement-breakpoint
ALTER TABLE "commandes" ADD CONSTRAINT "motif_offert_obligatoire" CHECK ("offert" = false OR "statut" <> 'PAYEE' OR "motif_offert" IS NOT NULL);--> statement-breakpoint

-- 3. Table virtuelle KDO, dans la zone RC — et non dans « Livraison » : le
-- cadeau se consomme sur place. Idempotent (rejouable sans dommage) : ne fait
-- rien si la table existe déjà, et retombe sur la première zone si aucune ne
-- s'appelle RC (un site a pu renommer ses zones).
DO $$
DECLARE zone_rc uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM tables_salle WHERE partenaire = 'KDO') THEN
    RETURN;
  END IF;
  SELECT id INTO zone_rc FROM zones WHERE upper(trim(nom)) = 'RC' LIMIT 1;
  IF zone_rc IS NULL THEN
    SELECT id INTO zone_rc FROM zones ORDER BY ordre, nom LIMIT 1;
  END IF;
  IF zone_rc IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO tables_salle (zone_id, numero, partenaire)
  VALUES (zone_rc, 'KDO', 'KDO')
  ON CONFLICT DO NOTHING;
END $$;
