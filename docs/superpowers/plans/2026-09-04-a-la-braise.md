# Profil À la Braise Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter la marque et le profil d’installation complet `ALA_BRAISE`, avec catalogue, salle, horaires, images, inventaire et logo obligatoire sur les tickets.

**Architecture:** Le seed commun demeure neutre. Un importeur de profils versionnés applique, dans une transaction, des données stables identifiées par UUID déterministes. La disponibilité effective est calculée côté serveur à partir de l’état catalogue, de la rupture locale, d’un créneau et d’une dérogation persistante manager.

**Tech Stack:** Node.js 22, Fastify, TypeScript strict, Drizzle/PostgreSQL 16, Zod, React 18, TanStack Query, Vitest, PNGJS, ESC/POS.

**Spec:** `docs/superpowers/specs/2026-09-04-a-la-braise-design.md`

## Global Constraints

- `sql/schema.sql` est la source de vérité et le schéma Drizzle doit en être le miroir.
- Les montants restent des entiers FCFA ; les consommations d’inventaire utilisent `numeric(12,3)`.
- L’import ne lance aucun `TRUNCATE`, ne touche pas aux ventes et reste idempotent.
- Toutes les erreurs et tous les libellés visibles restent en français.
- La disponibilité horaire est imposée par le serveur, jamais seulement par l’UI.
- Le logo À la Braise est obligatoire sur les tickets en modes `raster` et `bandes`.
- Les images gardent leur ratio et ne sont jamais rognées.

---

### Task 1: Troisième marque et logo-ticket

**Files:**
- Modify: `sql/schema.sql`
- Create: `apps/server/drizzle/0031_a_la_braise.sql`
- Modify: `apps/server/src/db/schema/index.ts`
- Modify: `packages/shared/src/types.ts`
- Modify: `apps/server/src/modules/auth/routes.ts`
- Modify: `apps/server/src/modules/client/routes.ts`
- Modify: `apps/server/src/printer/logo.ts`
- Create: `apps/server/assets/logo-a-la-braise.png`
- Modify: `apps/siege/src/api.ts`
- Modify: `apps/siege/src/components/Etat.tsx`
- Modify: `apps/siege/src/screens/Parametres.tsx`
- Modify: `apps/siege/src/screens/Sequences.tsx`
- Test: `apps/server/test/a-la-braise-marque.test.ts`

**Interfaces:**
- Produces: `type Marque = 'SAMER' | 'AL_KAYAN' | 'A_LA_BRAISE'` et résolution explicite du logo.

- [ ] Écrire un test qui insère un restaurant `A_LA_BRAISE`, vérifie la réponse `/api/auth/moi`, puis vérifie que `logoTicket('A_LA_BRAISE', 'raster')` et `logoTicket('A_LA_BRAISE', 'bandes')` retournent des buffers non vides distincts des logos Samer.
- [ ] Exécuter `pnpm --filter @pos/server test -- a-la-braise-marque.test.ts` et constater l’échec sur la contrainte/type/logo absent.
- [ ] Étendre la contrainte dans `sql/schema.sql`, Drizzle et la migration `0031`; étendre tous les types fermés de marque.
- [ ] Convertir le logo source en PNG de qualité dans `apps/server/assets/logo-a-la-braise.png` et ajouter une branche explicite dans `cheminLogo()`.
- [ ] Exécuter le test ciblé, les tests d’impression et les builds serveur/siège.
- [ ] Commit: `feat(marque): ajouter À la Braise et son logo ticket`.

### Task 2: Profil d’installation idempotent

**Files:**
- Create: `config/restaurants/a-la-braise/profil.json`
- Create: `config/restaurants/a-la-braise/catalogue.json`
- Create: `apps/server/src/scripts/importer-profil-restaurant.ts`
- Modify: `apps/server/package.json`
- Modify: `package.json`
- Test: `apps/server/test/profil-a-la-braise.test.ts`

**Interfaces:**
- Produces: commande `pnpm profil:importer --code ALA_BRAISE`.
- Produces: import transactionnel des paramètres, catégories, articles, options, suppléments, zones et tables.

- [ ] Écrire le test d’intégration qui applique le profil deux fois et vérifie une seule identité `ALA_BRAISE`, 34 tables physiques, 3 virtuelles, aucun doublon, les catégories prévues et les prix corrigés.
- [ ] Exécuter le test ciblé et constater l’échec car l’importeur n’existe pas.
- [ ] Écrire `profil.json` avec identité, adresse, GPS, Google Maps, réseaux, thème, entête et pied vide.
- [ ] Écrire `catalogue.json` avec la totalité des articles, prix, descriptions et choix de la spécification ; utiliser des UUID v5/déterministes ou des UUID constants propres au profil.
- [ ] Implémenter l’importeur avec validation Zod, transaction et upserts ciblés ; interdire l’application si la base appartient déjà à un autre restaurant ayant des ventes.
- [ ] Ajouter les scripts pnpm, exécuter deux imports sur la base de test et vérifier l’idempotence.
- [ ] Commit: `feat(installation): ajouter le profil À la Braise`.

### Task 3: Disponibilité horaire et dérogation manager

**Files:**
- Modify: `sql/schema.sql`
- Create: `apps/server/drizzle/0032_disponibilite_horaire.sql`
- Modify: `apps/server/src/db/schema/index.ts`
- Create: `apps/server/src/modules/catalogue/horaires.ts`
- Modify: `apps/server/src/modules/catalogue/service.ts`
- Modify: `apps/server/src/modules/catalogue/admin-disponibilite.ts`
- Modify: `apps/server/src/modules/commandes/service.ts`
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/schemas.ts`
- Test: `apps/server/test/disponibilite-horaire.test.ts`

**Interfaces:**
- Produces: `disponibiliteEffective(article, maintenant): { disponible: boolean; raison: string | null; derogation: boolean }`.
- Produces: route manager persistante pour activer/désactiver une dérogation auditée.

- [ ] Écrire les tests avec une horloge injectée couvrant 03:59/04:00/10:00/16:00/23:59/00:00, refus serveur hors plage, permission manager, persistance et audit.
- [ ] Exécuter le test ciblé et constater l’échec attendu.
- [ ] Ajouter les tables/colonnes minimales pour créneaux de catégorie et dérogations persistantes, avec contraintes, index et miroir Drizzle.
- [ ] Implémenter le calcul pur des créneaux, y compris fin `00:00`, puis l’utiliser dans le catalogue et avant ajout à une commande.
- [ ] Ajouter la route manager qui exige permission, motif lisible et journalise activation/désactivation.
- [ ] Exécuter les tests ciblés puis les tests catalogue/commandes existants.
- [ ] Commit: `feat(catalogue): appliquer les horaires et dérogations manager`.

### Task 4: Ordre quotidien et images sans rognage

**Files:**
- Create: `apps/caisse/public/catalogue/a-la-braise/*.webp`
- Modify: `config/restaurants/a-la-braise/catalogue.json`
- Modify: `apps/caisse/src/screens/Commande.tsx`
- Modify: `apps/caisse/src/screens/Reglages.tsx`
- Create: `apps/caisse/src/catalogue-ordre.ts`
- Test: `apps/caisse/src/catalogue-ordre.test.ts`
- Test: `apps/caisse/src/screens/Commande.test.tsx` if the existing test stack supports component rendering; otherwise assert the CSS class in the existing UI test pattern.

**Interfaces:**
- Produces: `ordonnerCategories(categories, date)` qui place `Tous les jours`, puis le jour courant, puis les autres catégories dans leur ordre stable.

- [ ] Écrire le test d’ordre du lundi et du dimanche et un test empêchant le retour de `object-cover` sur les vignettes produit.
- [ ] Exécuter les tests et constater les échecs.
- [ ] Convertir chaque image certaine en WebP carré 800×800 avec ratio conservé, fond sombre et orientation corrigée ; ne pas affecter les images ambiguës.
- [ ] Référencer les URLs locales dans le catalogue et appliquer `object-contain` dans Commande et Réglages.
- [ ] Implémenter et brancher le tri quotidien sans masquer les autres jours.
- [ ] Exécuter tests caisse et build caisse.
- [ ] Commit: `feat(caisse): afficher le catalogue À la Braise sans rogner les photos`.

### Task 5: Inventaire initial et demi-portions

**Files:**
- Modify: `config/restaurants/a-la-braise/profil.json`
- Modify: `apps/server/src/scripts/importer-profil-restaurant.ts`
- Test: `apps/server/test/inventaire-a-la-braise.test.ts`

**Interfaces:**
- Consumes: tables `produits_inventaire` et `inventaire_consommations` existantes.
- Produces: cinq produits à stock zéro et recettes 1,000/0,500/1,000.

- [ ] Écrire un test qui vérifie les cinq produits, stock initial zéro, une consommation `0.500` pour un demi et exactement `1.000` après deux ventes demi.
- [ ] Exécuter le test et constater l’absence des produits/recettes.
- [ ] Ajouter les produits Poulet de chair, Poulet hybride, Pintade, Boisson 1 000 et Boisson 1 500 et les seules recettes connues.
- [ ] Exécuter le test ciblé puis `inventaire-depenses.test.ts`.
- [ ] Commit: `feat(inventaire): initialiser les stocks À la Braise`.

### Task 6: Validation d’installation et documentation

**Files:**
- Modify: `docs/INSTALL_WINDOWS.md`
- Modify: `deploy/windows/README-DEPLOIEMENT.md`
- Create: `docs/INSTALLATION_A_LA_BRAISE.md`
- Test: all suites.

**Interfaces:**
- Produces: procédure reproductible d’installation et contrôle du ticket-logo réel.

- [ ] Documenter la commande d’import, l’enrôlement cloud créant un UUID distinct, les réglages imprimante et l’essai des deux modes de logo.
- [ ] Exécuter `git diff --check` et la vérification de correspondance `sql/schema.sql`/Drizzle.
- [ ] Exécuter `pnpm test` et obtenir zéro échec.
- [ ] Exécuter `pnpm build` et obtenir zéro erreur TypeScript.
- [ ] Exécuter l’import deux fois sur une base de test puis le parcours API critique.
- [ ] Inspecter visuellement le logo et un échantillon représentatif de photos converties.
- [ ] Commit: `docs(installation): documenter le déploiement À la Braise`.
