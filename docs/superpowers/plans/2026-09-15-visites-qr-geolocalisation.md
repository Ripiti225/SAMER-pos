# Visites QR et géolocalisation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isoler les commandes et reçus de chaque visite QR et limiter les actions client à 50 m du restaurant lorsque la géolocalisation est activée.

**Architecture:** Un UUID serveur matérialise une visite temporaire par onglet et est conservé dans `sessionStorage`. Les commandes QR référencent cette visite ; toutes les lectures sensibles sont filtrées par table et visite. Le serveur valide la distance de Haversine avant les actions avec effet.

**Tech Stack:** PostgreSQL 16, Drizzle ORM, Fastify, Zod, React 18, TanStack Query, Vitest, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-09-15-visites-qr-geolocalisation-design.md`

## Global Constraints

- Interface, erreurs et libellés en français ; montants en FCFA entiers.
- `sql/schema.sql` reste la source de vérité et Drizzle en est le miroir exact.
- La table physique continue d'être libérée uniquement par le paiement existant.
- Aucun reçu ou détail d'une autre visite ne doit être révélé.
- Les règles de session et de distance sont appliquées côté serveur.
- Préserver toutes les modifications non liées déjà présentes dans le worktree.

---

### Task 1: Schéma des visites QR

**Files:**
- Modify: `sql/schema.sql`
- Modify: `apps/server/src/db/schema/index.ts`
- Create: `apps/server/drizzle/0033_visites_qr.sql`
- Modify: `apps/server/drizzle/meta/_journal.json`
- Modify: `apps/server/test/aide.ts`

**Interfaces:**
- Produces: table `visites_qr` et FK nullable `commandes.visite_qr_id`.
- Consumes: `tables_salle.id` et `commandes.id` existants.

- [ ] **Step 1:** Ajouter au test d'intégration une création de visite qui échoue parce que la table SQL n'existe pas encore.
- [ ] **Step 2:** Exécuter le test ciblé et constater l'échec attendu.
- [ ] **Step 3:** Ajouter `visites_qr`, `commandes.visite_qr_id`, les index et le delta de migration.
- [ ] **Step 4:** Adapter le nettoyage de la base de test puis appliquer les migrations.
- [ ] **Step 5:** Réexécuter le test ciblé jusqu'au vert.

### Task 2: Contrat serveur de visite et confidentialité

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/types.ts`
- Create: `apps/server/src/modules/client/geolocalisation.ts`
- Modify: `apps/server/src/modules/client/routes.ts`
- Modify: `apps/server/test/client-qr-fidelite-recu.test.ts`
- Modify: `apps/server/test/corrections3-point1.test.ts`
- Modify: `apps/server/test/corrections3-point4.test.ts`

**Interfaces:**
- Produces: `POST /api/client/:qr_token/visite` retournant `{ visite_id, expire_le }`.
- Consumes: en-tête `X-Visite-QR` sur suivi, appels, commandes et reçus.
- Produces: `distanceMetres()` et validation serveur du rayon configuré.

- [ ] **Step 1:** Écrire les tests en échec : visite A voit son reçu, visite B voit une liste vide, une commande caisse est invisible et un reçu étranger renvoie 404.
- [ ] **Step 2:** Exécuter ces tests et vérifier que l'ancien filtrage par table les fait échouer.
- [ ] **Step 3:** Implémenter la création/reprise de visite et le garde de visite.
- [ ] **Step 4:** Rattacher les commandes QR à la visite et filtrer suivi/reçus par `visite_qr_id`.
- [ ] **Step 5:** Adapter les anciens tests QR au nouveau contrat et les remettre au vert.
- [ ] **Step 6:** Écrire puis faire passer les tests de distance à l'intérieur et à l'extérieur de 50 m.

### Task 3: Configuration de la géolocalisation

**Files:**
- Modify: `packages/shared/src/permissions.ts`
- Modify: `apps/server/src/db/seed.ts`
- Modify: `apps/caisse/src/screens/Reglages.tsx`
- Modify: `apps/server/test/admin-reglages.test.ts`

**Interfaces:**
- Produces: paramètres `client_qr_geolocalisation_activee`, `client_qr_latitude`, `client_qr_longitude`, `client_qr_rayon_metres`.
- Consumes: route existante `PATCH /api/admin/parametres`.

- [ ] **Step 1:** Ajouter les assertions serveur en échec sur les quatre paramètres et leurs défauts.
- [ ] **Step 2:** Ajouter les paramètres à la liste blanche partagée et au seed.
- [ ] **Step 3:** Ajouter dans Réglages le bouton « Utiliser ma position actuelle » pour remplir latitude et longitude.
- [ ] **Step 4:** Exécuter les tests de réglages et le build caisse.

### Task 4: Session par onglet dans l'app client

**Files:**
- Create: `apps/client/src/visite.ts`
- Modify: `apps/client/src/api.ts`
- Modify: `apps/client/src/App.tsx`
- Modify: `apps/client/src/screens/PageTable.tsx`
- Modify: `apps/client/src/screens/SuiviCommandes.tsx`
- Modify: `apps/client/src/screens/ConfirmationPaiement.tsx`

**Interfaces:**
- Produces: jeton stocké sous `pos_visite_qr:<qr_token>` dans `sessionStorage`.
- Consumes: `X-Visite-QR` et téléchargement Blob du reçu.

- [ ] **Step 1:** Ajouter les fonctions pures de lecture/écriture de visite et d'obtention de position.
- [ ] **Step 2:** Initialiser ou reprendre la visite avant d'afficher la page de commande.
- [ ] **Step 3:** Porter visite et position sur les actions et les clés TanStack Query.
- [ ] **Step 4:** Remplacer les liens de reçu par un téléchargement authentifié et ajouter « Commander autre chose ».
- [ ] **Step 5:** Compiler l'app client et corriger toute erreur TypeScript.

### Task 5: Vérification complète

**Files:**
- Review: tous les fichiers modifiés par les Tasks 1–4.

**Interfaces:**
- Consumes: fonctionnalité complète.
- Produces: preuve de non-régression.

- [ ] **Step 1:** Exécuter les tests QR ciblés.
- [ ] **Step 2:** Exécuter `pnpm --filter @pos/server test`.
- [ ] **Step 3:** Exécuter `pnpm build`.
- [ ] **Step 4:** Exécuter `git diff --check` et vérifier que les changements non liés sont préservés.
