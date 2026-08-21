-- Snapshot produit sur les lignes d'inventaire (2026-08-21).
--
-- POURQUOI — le pont POS → SamerTrackly ne pouvait pas nommer les produits.
-- `CATALOGUE_INVENTAIRE` (catalogue-inventaire.ts) ne porte QUE des `code` :
-- chaque mini-PC sème donc `produits_inventaire` avec ses propres uuid, générés
-- par `gen_random_uuid()`. Deux sites n'ont pas les mêmes ids pour « Pain
-- chawarma ». Le cloud, lui, reçoit `inventaire_lignes.produit_id` — un uuid
-- local qu'il ne sait traduire avec RIEN, sa table `produits_inventaire` étant
-- vide (c'est une table de DESCENTE, jamais remontée par les sites).
--
-- Constaté le 2026-08-21 : 4 services transférés ont écrit chez SamerTrackly un
-- inventaire « validé, 0 à déduire » dont les 34 lignes avaient toutes été
-- écartées, faute de correspondance. Un inventaire vide d'apparence saine lève
-- la bannière « Inventaire du jour requis » en affirmant qu'il n'y a rien à
-- retenir sur la paie.
--
-- CE QU'ON FIGE, ET POURQUOI CES TROIS COLONNES
--   produit_code — l'identité stable, celle que SamerTrackly utilise comme
--                  `inventaire_lignes.produit_id`. Identique sur les 7 sites.
--   produit_nom  — pour `entrees_shift.produit_nom` côté SamerTrackly.
--   produit_prix — pour chiffrer le manquant non expliqué AVEC LE PRIX QUI A
--                  SERVI AU COMPTAGE. Relire le catalogue au moment du
--                  transfert donnerait un montant différent de celui que le
--                  POS a affiché au caissier si le siège a changé le prix
--                  entre-temps. Même principe que `commande_items.prix_unitaire`.
--
-- Rejouable : ADD COLUMN IF NOT EXISTS, backfill limité aux lignes non encore
-- renseignées, trigger en CREATE OR REPLACE.

ALTER TABLE "inventaire_lignes"
  ADD COLUMN IF NOT EXISTS "produit_code" text,
  ADD COLUMN IF NOT EXISTS "produit_nom"  text,
  ADD COLUMN IF NOT EXISTS "produit_prix" integer;
--> statement-breakpoint

ALTER TABLE "entrees_stock"
  ADD COLUMN IF NOT EXISTS "produit_code" text,
  ADD COLUMN IF NOT EXISTS "produit_nom"  text;
--> statement-breakpoint

-- Rattrapage de l'historique : tout ce qui a été compté avant cette migration
-- devient transférable. Un site à jour peut rejouer ses anciens services.
UPDATE "inventaire_lignes" l
   SET "produit_code" = p."code",
       "produit_nom"  = p."nom",
       "produit_prix" = p."prix"
  FROM "produits_inventaire" p
 WHERE p."id" = l."produit_id" AND l."produit_code" IS NULL;
--> statement-breakpoint

UPDATE "entrees_stock" e
   SET "produit_code" = p."code",
       "produit_nom"  = p."nom"
  FROM "produits_inventaire" p
 WHERE p."id" = e."produit_id" AND e."produit_code" IS NULL;
--> statement-breakpoint

-- Le remplissage est fait par la base, pas par le code applicatif : l'inventaire
-- est écrit depuis plusieurs endroits (comptage, réceptions, recalculs), et un
-- seul oubli reproduirait exactement la panne du 2026-08-21.
CREATE OR REPLACE FUNCTION remplir_snapshot_produit() RETURNS trigger AS $$
BEGIN
  SELECT p."code", p."nom", p."prix"
    INTO NEW."produit_code", NEW."produit_nom", NEW."produit_prix"
    FROM "produits_inventaire" p
   WHERE p."id" = NEW."produit_id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- `entrees_stock` n'a pas de colonne prix : une fonction dédiée, sinon
-- l'affectation de NEW."produit_prix" lèverait une erreur de champ inconnu.
CREATE OR REPLACE FUNCTION remplir_snapshot_produit_entree() RETURNS trigger AS $$
BEGIN
  SELECT p."code", p."nom"
    INTO NEW."produit_code", NEW."produit_nom"
    FROM "produits_inventaire" p
   WHERE p."id" = NEW."produit_id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_snapshot_produit_ligne ON "inventaire_lignes";
--> statement-breakpoint
CREATE TRIGGER trg_snapshot_produit_ligne
  BEFORE INSERT OR UPDATE OF "produit_id" ON "inventaire_lignes"
  FOR EACH ROW EXECUTE FUNCTION remplir_snapshot_produit();
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_snapshot_produit_entree ON "entrees_stock";
--> statement-breakpoint
CREATE TRIGGER trg_snapshot_produit_entree
  BEFORE INSERT OR UPDATE OF "produit_id" ON "entrees_stock"
  FOR EACH ROW EXECUTE FUNCTION remplir_snapshot_produit_entree();
