# Ajouts SamerDelly du 8 septembre 2026

État : script corrigé et testé ; **publication non confirmée**. La première tentative dans le cloud a été annulée parce que les catégories Apéritifs, Tacos et Desserts n'étaient pas résolues pour Samer Angré 7E et Samer Palmeraie. La CLI Supabase de ce poste n'a pas de session authentifiée.

L'export fourni comporte exactement 100 lignes. Quatre identifiants n'existent pas dans `catalogue_samer.json` (128 produits) ; leurs dates de création dans l'export sont le 7 septembre 2026. La présence d'une suite à l'export reste à confirmer. Les produits absents de ce fichier partiel ne doivent jamais être supprimés.

| Produit | Catégorie | Prix FCFA |
|---|---|---:|
| Falafel x6 | Apéritifs | 1 000 |
| Mini pizza x3 | Apéritifs | 1 000 |
| Tacos burger | Tacos | 5 000 |
| Gâteau au chocolat | Desserts | 2 000 |

Le lot normalisé est dans `ajouts_samerdelly_20260908.json` : UUID SamerDelly conservés, photos et disponibilité reprises de l'export. Aucun tarif partenaire n'est inventé.

## Publication

Exécuter `sql/cloud/ajouts_samerdelly_20260908.sql` dans l'éditeur SQL du projet **pos-samer-cloud** (`vbsmxwlxlcgkodwkbhfa`). Le script est autonome ; il ne nécessite aucune autre migration en attente dans le dépôt.

Il cible les restaurants actifs et enrôlés de marques SAMER et AL_KAYAN. À la Braise est exclue par sa marque, son nom et son code ; le script n'a aucune dérogation permettant de l'inclure. Les postes non enrôlés ne recevront pas cette diffusion et restent à traiter une fois raccordés.

Pour chaque site, la catégorie est recherchée d'abord par UUID SamerDelly, puis par nom. Si elle est entièrement absente du cloud, elle est publiée avec son UUID, son nom et son ordre dans le catalogue d'origine. Ces UUID correspondent aux installations issues de l'export commun ; un poste réinstallé avec des catégories créées indépendamment nécessite une vérification de ses identifiants locaux. Le cloud ne voit pas automatiquement les catégories créées sur place.

Une catégorie ambiguë ou désactivée reste bloquante : aucune sélection arbitraire, aucune réactivation implicite. Les catégories déjà présentes ne sont pas modifiées. Le script ne remplace aucun produit et conserve les prix, disponibilités et données de vente existants. Un produit déjà présent par UUID ou par nom dans la même catégorie est conservé.

Le résultat SQL donne, pour chaque produit et restaurant, `AJOUTÉ` ou `DÉJÀ PRÉSENT — CONSERVÉ`, ainsi que `categorie_cloud` (`PUBLIÉE` ou `DÉJÀ PRÉSENTE`). Après publication, vérifier `/api/catalogue` sur les sites une fois leur synchronisation descendante effectuée ; une publication cloud seule ne prouve pas que les postes ont reçu les produits.

## Vérification effectuée

Sur une base PostgreSQL 16 isolée, avec huit restaurants fictifs : ajout dans les deux sites autorisés ; conservation d'un prix et d'une disponibilité déjà définis ; exclusion d'À la Braise par marque, nom et code ; exclusion des sites inactifs, non enrôlés et du poste à configurer. Le cas de trois catégories absentes sur deux sites publie exactement six catégories avec les UUID d'origine et ajoute les produits. Une seconde exécution ne crée aucun doublon de produit ou de catégorie. Les cas de catégorie ambiguë et désactivée annulent l'ensemble du lot.
