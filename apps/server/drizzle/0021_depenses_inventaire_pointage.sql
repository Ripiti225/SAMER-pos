-- DESIGN_V2 § 6.7 / 6.8 / 6.9 — Pointage, Dépenses, Inventaire.
-- Migration DELTA écrite à la main : drizzle-kit n'a pas de snapshot des
-- migrations 0000-0020, `generate` redéposerait tout le schéma.
--
-- Toutes ces tables sont LOCALES : elles ne figurent pas dans sync/descente.ts
-- (une descente du siège ne les écrase jamais) ni dans sync_outbox — le cloud
-- n'a pas encore les tables correspondantes, et publier vers une table absente
-- ferait échouer toute la remontée du site.
--
-- ⚠ Les QUANTITÉS d'inventaire sont numériques et non entières : le fromage se
-- compte en grammes, la glace en pots (4,5) et les frites en sachets. Seuls les
-- MONTANTS restent des entiers FCFA (règle du projet).

-- ---------------------------------------------------------------------------
-- 1. Pointage (§ 6.7) — l'heure du clic fait foi comme heure d'arrivée.
-- ---------------------------------------------------------------------------
ALTER TABLE "equipe_service" ADD COLUMN IF NOT EXISTS "pointe_le" timestamp with time zone;--> statement-breakpoint

-- Les lignes déjà en base ont été créées à l'ouverture du service : leur heure
-- de création est bien leur heure d'arrivée.
UPDATE "equipe_service" SET "pointe_le" = "created_at" WHERE "pointe_le" IS NULL;--> statement-breakpoint

-- Règle du départ (§ 6.8) : à la clôture, toute personne non marquée « Reste »
-- est enregistrée comme PARTIE. Trois états, donc : NULL = pas encore tranché,
-- true = reste, false = parti. Le caissier ne marque que les exceptions.
ALTER TABLE "equipe_service" ADD COLUMN IF NOT EXISTS "reste" boolean;--> statement-breakpoint

-- Salaire proposé au paiement (modifiable, avec motif obligatoire).
ALTER TABLE "utilisateurs" ADD COLUMN IF NOT EXISTS "taux_journalier" integer;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "utilisateurs" ADD CONSTRAINT "utilisateurs_taux_journalier_check"
    CHECK ("taux_journalier" IS NULL OR "taux_journalier" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. Dépenses (§ 6.8) — le registre dont services_caisse.depenses devient la somme.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "depenses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "service_id" uuid NOT NULL REFERENCES "services_caisse"("id") ON DELETE CASCADE,
  "categorie" text NOT NULL,
  "libelle" text NOT NULL,
  "montant" integer NOT NULL,
  -- Renseigné pour un salaire ou un encouragement : qui a été payé.
  "agent_id" uuid REFERENCES "utilisateurs"("id"),
  "saisi_par" uuid NOT NULL REFERENCES "utilisateurs"("id"),
  -- Ligne née d'un paiement réel (salaire, encouragement) : NON SUPPRIMABLE.
  -- L'effacer ferait disparaître de l'argent réellement sorti du tiroir.
  "auto" boolean DEFAULT false NOT NULL,
  -- Obligatoire quand le montant payé s'écarte du taux de la fiche : c'est le
  -- seul moyen pour le manager de comprendre un écart de paie.
  "motif" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "depenses_categorie_check" CHECK ("categorie" IN
    ('MARCHE','LEGUMES','FRUITS','ANNEXES','SALAIRES','ENCOURAGEMENTS')),
  CONSTRAINT "depenses_montant_check" CHECK ("montant" > 0),
  CONSTRAINT "depenses_libelle_check" CHECK (length(btrim("libelle")) > 0),
  -- Un salaire ou un encouragement dit toujours QUI a été payé.
  CONSTRAINT "depenses_agent_check" CHECK (
    "categorie" NOT IN ('SALAIRES','ENCOURAGEMENTS') OR "agent_id" IS NOT NULL)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_depenses_service" ON "depenses" ("service_id");--> statement-breakpoint

-- Un même agent n'est payé qu'une fois par service (le bouton « Payer »
-- disparaît ensuite). Un encouragement reste possible en plus du salaire.
CREATE UNIQUE INDEX IF NOT EXISTS "un_salaire_par_agent_et_service"
  ON "depenses" ("service_id", "agent_id") WHERE "categorie" = 'SALAIRES';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Inventaire (§ 6.9)
-- ---------------------------------------------------------------------------

-- Catalogue de comptage — celui de SamerTrackly, identique sur les 7 sites,
-- donc seedé ici. Distinct du catalogue de VENTE (`articles`) : les lignes de
-- consommation (« Manaïche (100g) ») et les totaux dérivés (« Total Fromage »)
-- ne sont pas des articles vendables et n'ont pas de ligne dans `articles`.
-- `article_id` fait le pont quand il existe : il porte les sorties automatiques.
CREATE TABLE IF NOT EXISTS "produits_inventaire" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" text NOT NULL UNIQUE,
  "categorie" text NOT NULL,
  "nom" text NOT NULL,
  -- Prix de vente : sert à chiffrer le manquant non expliqué (information).
  "prix" integer DEFAULT 0 NOT NULL,
  "unite" text DEFAULT 'u' NOT NULL,
  "role" text DEFAULT 'COMPTE' NOT NULL,
  -- Sens du ratio selon le rôle : grammes de fromage, boules de glace,
  -- portions par sachet de frites. NULL pour les lignes simples.
  "ratio" numeric(12,3),
  -- Article du POS dont les ventes alimentent les sorties de ce produit.
  "article_id" uuid REFERENCES "articles"("id") ON DELETE SET NULL,
  "ordre" smallint DEFAULT 0 NOT NULL,
  "actif" boolean DEFAULT true NOT NULL,
  CONSTRAINT "produits_inventaire_categorie_check" CHECK ("categorie" IN
    ('PAIN','POUL','APER','PLAT','FROM','BOIS','GLAC','FRIT')),
  CONSTRAINT "produits_inventaire_prix_check" CHECK ("prix" >= 0),
  CONSTRAINT "produits_inventaire_role_check" CHECK ("role" IN
    ('COMPTE','ENTREE','AUTO_ENT',
     'CONSO','CONSO_POULET','CONSO_FROMAGE','CONSO_GLACE','CONSO_FRITES',
     'TOTAL_POULET','TOTAL_FROMAGE','TOTAL_GLACE','TOTAL_FRITES','DARINA'))
);--> statement-breakpoint

-- Un inventaire par service. `valide` verrouille tout en lecture seule.
CREATE TABLE IF NOT EXISTS "inventaires_service" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "service_id" uuid NOT NULL UNIQUE REFERENCES "services_caisse"("id") ON DELETE CASCADE,
  "valide" boolean DEFAULT false NOT NULL,
  "valide_le" timestamp with time zone,
  "valide_par" uuid REFERENCES "utilisateurs"("id"),
  -- Issue de secours : sans elle, un caissier bloqué à 2 h du matin ne peut
  -- plus fermer sa caisse. Le déblocage est tracé (audit DEBLOCAGE_INVENTAIRE).
  "debloque_par" uuid REFERENCES "utilisateurs"("id"),
  "debloque_le" timestamp with time zone,
  "debloque_motif" text,
  -- Manquant non expliqué, chiffré en FCFA. INFORMATION pour le manager :
  -- jamais déduit de la caisse (contrairement à SamerTrackly).
  "montant_manquant" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "inventaires_service_manquant_check" CHECK ("montant_manquant" >= 0),
  CONSTRAINT "inventaires_service_deblocage_check" CHECK (
    "debloque_par" IS NULL OR "debloque_motif" IS NOT NULL)
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "inventaire_lignes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "inventaire_id" uuid NOT NULL REFERENCES "inventaires_service"("id") ON DELETE CASCADE,
  "produit_id" uuid NOT NULL REFERENCES "produits_inventaire"("id") ON DELETE CASCADE,
  -- Stock final du service précédent — repris, jamais modifiable.
  "stock_initial" numeric(12,2) DEFAULT 0 NOT NULL,
  "entrees" numeric(12,2) DEFAULT 0 NOT NULL,
  "sorties" numeric(12,2) DEFAULT 0 NOT NULL,
  -- La SEULE donnée que le caissier saisit. NULL = pas encore compté.
  "stock_compte" numeric(12,2),
  "ecart" numeric(12,2),
  "quantite_expliquee" numeric(12,2) DEFAULT 0 NOT NULL,
  "explication" text,
  CONSTRAINT "inventaire_lignes_expliquee_check" CHECK ("quantite_expliquee" >= 0)
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "inventaire_lignes_produit_key"
  ON "inventaire_lignes" ("inventaire_id", "produit_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "entrees_stock" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "inventaire_id" uuid NOT NULL REFERENCES "inventaires_service"("id") ON DELETE CASCADE,
  "produit_id" uuid NOT NULL REFERENCES "produits_inventaire"("id") ON DELETE CASCADE,
  "quantite" numeric(12,2) NOT NULL,
  "fournisseur" text,
  "saisi_par" uuid REFERENCES "utilisateurs"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "entrees_stock_quantite_check" CHECK ("quantite" > 0)
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_entrees_stock_inventaire" ON "entrees_stock" ("inventaire_id");--> statement-breakpoint

-- Verrou de clôture appliqué CÔTÉ SERVEUR (§ 9) : l'UI ne fait que le refléter.
ALTER TABLE "services_caisse" ADD COLUMN IF NOT EXISTS "inventaire_valide" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Seed du catalogue d'inventaire — 8 catégories, 52 produits.
--    Noms, prix, grammages et ratios repris tels quels de SamerTrackly.
--    Idempotent : rejouable sans doublon.
-- ---------------------------------------------------------------------------
INSERT INTO "produits_inventaire" ("code","categorie","nom","prix","unite","role","ratio","ordre") VALUES
  -- Pains
  ('p1','PAIN','Pain chawarma',2500,'u','COMPTE',NULL,1),
  ('p2','PAIN','Pain burger',3500,'u','COMPTE',NULL,2),
  ('p3','PAIN','Pain fahita',3000,'u','COMPTE',NULL,3),
  -- Poulet : po1 alimente po7 et po8 ; po2→po6 sont des sorties
  ('po1','POUL','Poulet frais',0,'u','ENTREE',NULL,1),
  ('po2','POUL','Pané',0,'u','CONSO_POULET',1,2),
  ('po3','POUL','Rôti',0,'u','CONSO_POULET',1,3),
  ('po4','POUL','Braise',0,'u','CONSO_POULET',1,4),
  ('po5','POUL','Désossé',0,'u','CONSO_POULET',1,5),
  ('po6','POUL','Cuisses de poulet',0,'u','CONSO_POULET',1,6),
  ('po7','POUL','Pâte de poulet',1000,'u','AUTO_ENT',10,7),
  ('po8','POUL','Total poulet',8000,'u','TOTAL_POULET',NULL,8),
  -- Apéritifs
  ('a1','APER','Nems',2000,'u','COMPTE',NULL,1),
  ('a2','APER','Kébbé',1000,'u','COMPTE',NULL,2),
  ('a3','APER','Bourak',2000,'u','COMPTE',NULL,3),
  ('a4','APER','Fatayer viande',1000,'u','COMPTE',NULL,4),
  ('a5','APER','Fatayer légumes',1000,'u','COMPTE',NULL,5),
  ('a6','APER','Fatayer maison',1500,'u','COMPTE',NULL,6),
  ('a7','APER','Fatayer JFromage',1500,'u','COMPTE',NULL,7),
  ('a8','APER','Mini tacos',2000,'u','COMPTE',NULL,8),
  ('a9','APER','Francisco',0,'u','COMPTE',NULL,9),
  ('f1','APER','Philadelphia',2500,'u','COMPTE',NULL,10),
  -- Plats
  ('pl1','PLAT','Steak',6000,'u','COMPTE',NULL,1),
  ('pl2','PLAT','Escalope plats',5000,'u','COMPTE',NULL,2),
  ('pl3','PLAT','Chicken burger',0,'u','COMPTE',NULL,3),
  ('pl4','PLAT','Viande burger',0,'u','COMPTE',NULL,4),
  ('pl5','PLAT','Crispy 5pcs',5000,'u','COMPTE',NULL,5),
  ('a10','PLAT','Brochette poulet',5000,'u','COMPTE',NULL,6),
  ('a11','PLAT','Brochette viande',5000,'u','COMPTE',NULL,7),
  -- Fromage : chaque produit consomme des grammes, f10 est le stock réel
  ('f2','FROM','Manaïche (100g)',0,'g','CONSO_FROMAGE',100,1),
  ('f3','FROM','Pizza spéciale (130g)',0,'g','CONSO_FROMAGE',130,2),
  ('f4','FROM','Pizza moyenne (160g)',0,'g','CONSO_FROMAGE',160,3),
  ('f5','FROM','Pizza grande (200g)',0,'g','CONSO_FROMAGE',200,4),
  ('f6','FROM','Mini pizza (20g)',0,'g','CONSO_FROMAGE',20,5),
  ('f7','FROM','Fatayer JF 30g',0,'g','CONSO_FROMAGE',30,6),
  ('f8','FROM','Sandwich/Tacos (50g)',0,'g','CONSO_FROMAGE',50,7),
  ('f9','FROM','Mini tacos (30g)',0,'g','CONSO_FROMAGE',30,8),
  ('f10','FROM','Total Fromage',5,'g','TOTAL_FROMAGE',NULL,9),
  -- Boissons
  ('b1','BOIS','Nespresso',1000,'u','COMPTE',NULL,1),
  ('b2','BOIS','Eau G',1000,'u','COMPTE',NULL,2),
  ('b3','BOIS','Eau P',500,'u','COMPTE',NULL,3),
  ('b4','BOIS','Boisson 1000f',1000,'u','COMPTE',NULL,4),
  ('b5','BOIS','Boisson 1500f',1500,'u','COMPTE',NULL,5),
  ('b6','BOIS','Pot Fresco',1000,'u','COMPTE',NULL,6),
  ('b7','BOIS','Darina',0,'u','DARINA',NULL,7),
  ('b8','BOIS','Thé',1000,'u','COMPTE',NULL,8),
  -- Glaces
  ('g1','GLAC','Glace 2 boules',0,'u','CONSO_GLACE',2,1),
  ('g2','GLAC','Milkshake/Spéciale',0,'u','CONSO_GLACE',3,2),
  ('g3','GLAC','Pot de glace',6000,'pot','TOTAL_GLACE',38,3),
  ('g4','GLAC','Cornets',1000,'u','COMPTE',NULL,4),
  -- Frites
  ('fr1','FRIT','Portions de frites',0,'u','CONSO_FRITES',8,1),
  ('fr2','FRIT','Tacos vendus',0,'u','CONSO_FRITES',15,2),
  ('fr3','FRIT','Sachet de frites',2500,'sachet','TOTAL_FRITES',NULL,3)
ON CONFLICT ("code") DO NOTHING;
