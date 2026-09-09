-- Ajouts SamerDelly du 08/09/2026 : 4 nouveautés issues de l'export de 100 lignes.
-- À exécuter uniquement dans le projet CLOUD POS, jamais dans la base SamerDelly.
-- Ajouts uniquement : aucun prix existant ni aucune vente modifiés.
-- Les catégories absentes du cloud sont publiées avec les UUID du catalogue d'origine.
-- Les catégories déjà présentes sont conservées ; les ambiguïtés restent bloquantes.
-- À la Braise est exclue par marque, nom ET code. Aucun mécanisme de dérogation ici.
-- Les sites non enrôlés ou inactifs ne peuvent pas recevoir cette diffusion.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TEMP TABLE lot_samerdelly (
  id uuid PRIMARY KEY, categorie_source uuid NOT NULL, categorie text NOT NULL, categorie_ordre smallint NOT NULL,
  nom text NOT NULL, description text, prix_base integer NOT NULL CHECK (prix_base >= 0),
  image_url text, disponible boolean NOT NULL
) ON COMMIT DROP;
INSERT INTO lot_samerdelly VALUES
  ('18d98cca-3c12-4ac7-9367-490a2a3a2246'::uuid, '65712bc8-bbaa-42de-aefd-e088da38bda8'::uuid, 'Apéritifs', 10, 'Falafel x6', NULL, 1000, 'https://mobmgbedyyqeggxjpbrk.supabase.co/storage/v1/object/public/photos/produits/18d98cca-3c12-4ac7-9367-490a2a3a2246.jpg', true),
  ('41f49c13-6925-4e61-9093-87395642066e'::uuid, '65712bc8-bbaa-42de-aefd-e088da38bda8'::uuid, 'Apéritifs', 10, 'Mini pizza x3', NULL, 1000, 'https://mobmgbedyyqeggxjpbrk.supabase.co/storage/v1/object/public/photos/produits/41f49c13-6925-4e61-9093-87395642066e.jpg', true),
  ('42aea29d-f2ac-4ebf-a154-afc97d42e032'::uuid, 'c843361b-82d8-48cf-8450-41f42e14d7bc'::uuid, 'Tacos', 4, 'Tacos burger', NULL, 5000, 'https://mobmgbedyyqeggxjpbrk.supabase.co/storage/v1/object/public/photos/produits/42aea29d-f2ac-4ebf-a154-afc97d42e032.jpg', true),
  ('70585fd0-8730-4994-a027-fc4896d0b9a1'::uuid, '1558a155-8d0d-447b-ac8e-6533afeff3db'::uuid, 'Desserts', 14, 'Gâteau au chocolat', NULL, 2000, 'https://mobmgbedyyqeggxjpbrk.supabase.co/storage/v1/object/public/photos/produits/70585fd0-8730-4994-a027-fc4896d0b9a1.jpg', true);

CREATE TEMP TABLE cibles_samerdelly ON COMMIT DROP AS
SELECT r.restaurant_id, r.nom AS restaurant
FROM public.restaurants r
JOIN public.sites_autorises s ON s.restaurant_id = r.restaurant_id AND s.actif
WHERE r.actif
  AND r.marque IN ('SAMER', 'AL_KAYAN')
  AND lower(r.nom) NOT LIKE '%braise%'
  AND lower(r.code) NOT LIKE '%braise%'
  AND r.code <> 'A_CONFIGURER';

-- Retrouve la catégorie DE CHAQUE SITE. Priorité à l'UUID d'origine ;
-- sinon, le nom doit désigner exactement une catégorie active.
CREATE TEMP TABLE correspondances_samerdelly ON COMMIT DROP AS
SELECT t.restaurant_id, t.restaurant, p.*,
  COALESCE(
    (SELECT ARRAY[c.id] FROM public.categories c
     WHERE c.restaurant_id = t.restaurant_id AND c.id = p.categorie_source AND c.actif),
    (SELECT array_agg(c.id) FROM public.categories c
     WHERE c.restaurant_id = t.restaurant_id AND c.actif
       AND lower(btrim(c.nom)) = lower(btrim(p.categorie)))
  ) AS categories_pos
FROM cibles_samerdelly t CROSS JOIN lot_samerdelly p;

DO $$
DECLARE probleme text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cibles_samerdelly) THEN
    RAISE EXCEPTION 'Aucun restaurant actif et enrôlé autorisé : aucun produit ajouté.';
  END IF;
  SELECT string_agg(DISTINCT restaurant || ' : ' || categorie, ', ')
    INTO probleme FROM correspondances_samerdelly m
    WHERE coalesce(array_length(m.categories_pos, 1), 0) > 1
      OR (coalesce(array_length(m.categories_pos, 1), 0) = 0 AND EXISTS (
        SELECT 1 FROM public.categories c WHERE c.restaurant_id = m.restaurant_id
          AND (c.id = m.categorie_source OR lower(btrim(c.nom)) = lower(btrim(m.categorie)))
      ));
  IF probleme IS NOT NULL THEN
    RAISE EXCEPTION 'Catégories ambiguës ou désactivées (%). Aucun produit ajouté.', probleme;
  END IF;
END $$;

-- Le catalogue initial a été importé directement sur les postes et ne remonte
-- pas au cloud. Publier ses UUID permet à ces postes de retrouver leurs catégories.
-- Aucun UUID aléatoire, aucune modification d'une catégorie déjà publiée.
CREATE TEMP TABLE categories_creees_samerdelly ON COMMIT DROP AS
WITH creees AS (
  INSERT INTO public.categories (restaurant_id, id, nom, ordre, actif)
  SELECT DISTINCT restaurant_id, categorie_source, categorie, categorie_ordre, TRUE
  FROM correspondances_samerdelly
  WHERE coalesce(array_length(categories_pos, 1), 0) = 0
  ON CONFLICT (restaurant_id, id) DO NOTHING
  RETURNING restaurant_id, id
)
SELECT * FROM creees;

UPDATE correspondances_samerdelly m
SET categories_pos = ARRAY[c.id]
FROM public.categories c
WHERE coalesce(array_length(m.categories_pos, 1), 0) = 0
  AND c.restaurant_id = m.restaurant_id AND c.id = m.categorie_source AND c.actif;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM correspondances_samerdelly
             WHERE coalesce(array_length(categories_pos, 1), 0) <> 1) THEN
    RAISE EXCEPTION 'Le catalogue a changé pendant la préparation. Aucun produit ajouté ; relancez le script.';
  END IF;
END $$;

CREATE TEMP TABLE resultat_samerdelly ON COMMIT DROP AS
WITH ajoutes AS (
  INSERT INTO public.articles
    (restaurant_id, id, categorie_id, nom, description, prix_base, image_url, disponible, actif, updated_at)
  SELECT m.restaurant_id, m.id, m.categories_pos[1], m.nom, m.description,
    m.prix_base, m.image_url, m.disponible, TRUE, now()
  FROM correspondances_samerdelly m
  WHERE NOT EXISTS (
    SELECT 1 FROM public.articles a WHERE a.restaurant_id = m.restaurant_id
      AND (a.id = m.id OR
        (a.categorie_id = m.categories_pos[1] AND lower(btrim(a.nom)) = lower(btrim(m.nom))))
  )
  ON CONFLICT (restaurant_id, id) DO NOTHING
  RETURNING restaurant_id, id, nom, prix_base
)
SELECT * FROM ajoutes;

-- Résultat exact du lot. Une ligne déjà présente conserve TOUS ses champs.
SELECT m.restaurant, m.nom AS produit, m.prix_base AS prix_export,
  CASE WHEN a.id IS NOT NULL THEN 'AJOUTÉ' ELSE 'DÉJÀ PRÉSENT — CONSERVÉ' END AS resultat,
  CASE WHEN c.id IS NOT NULL THEN 'PUBLIÉE' ELSE 'DÉJÀ PRÉSENTE' END AS categorie_cloud
FROM correspondances_samerdelly m
LEFT JOIN resultat_samerdelly a ON a.restaurant_id = m.restaurant_id AND a.id = m.id
LEFT JOIN categories_creees_samerdelly c ON c.restaurant_id = m.restaurant_id AND c.id = m.categories_pos[1]
ORDER BY m.restaurant, m.categorie, m.nom;
COMMIT;
