# Validation des explications d’inventaire au siège — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre à un ADMIN de la console siège d’accepter ou refuser les explications d’écart d’inventaire sans ralentir leur transfert vers SamerTrackly.

**Architecture:** SamerTrackly reste la source de vérité. La console passe par l’Edge Function `siege`, qui lit SamerTrackly et appelle une nouvelle fonction SQL atomique ; l’écran SamerTrackly existant appelle la même fonction afin que la première décision gagne. Le pont POS préserve les décisions lors de ses rejeux.

**Tech Stack:** React 18, TypeScript, Supabase Edge Functions/Deno, PostgreSQL/PostgREST, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-14-validation-explications-inventaire-siege-design.md`

## Global Constraints

- L’inventaire et son explication continuent d’arriver automatiquement dans SamerTrackly avec `explication_statut = 'en_attente'`.
- Seul un compte siège `ADMIN` peut décider ; `LECTURE` reste strictement consultatif.
- Les montants restent des FCFA entiers et sont recalculés côté serveur.
- La première décision gagne ; toute tentative suivante renvoie « Cette explication a déjà été traitée ».
- Aucun changement visuel du parcours SamerTrackly.
- Ne jamais écraser une décision SamerTrackly pendant un rejeu du pont POS.

---

### Task 1: Décision SamerTrackly atomique et partagée

**Files:**
- Create: `/Users/macbookpro/samtrackly/supabase_decision_inventaire_atomique.sql`
- Modify: `/Users/macbookpro/samtrackly/lib/api.js`
- Modify: `/Users/macbookpro/samtrackly/app/verification.js`
- Test: `/Users/macbookpro/samtrackly/lib/decisionInventaire.test.mjs`

**Interfaces:**
- Produces: RPC `decider_ecart_inventaire_atomique(p_ligne_id uuid, p_statut text, p_quantite_acceptee numeric, p_prix numeric, p_par text)` retournant `statut`, `quantite_acceptee`, `montant_deduit`.
- Consumes: colonnes existantes de `inventaire_lignes`, `inventaires_shifts` et `points`.

- [ ] **Step 1: écrire le test en échec du contrat de décision**

Créer un test pur qui vérifie que les paramètres acceptés sont `validee|refusee`, que la quantité validée est bornée par `abs(ecart)`, et que le montant vaut `round(max(0, abs(ecart)-quantiteAcceptee)*prix)`.

```js
assert.deepEqual(calculerDecisionInventaire({ statut: 'validee', ecart: -3, nombreExplique: 1, prix: 8000 }), {
  quantiteAcceptee: 1,
  montantDeduit: 16000,
})
assert.deepEqual(calculerDecisionInventaire({ statut: 'refusee', ecart: -3, nombreExplique: 1, prix: 8000 }), {
  quantiteAcceptee: 0,
  montantDeduit: 24000,
})
```

- [ ] **Step 2: exécuter le test et constater l’échec**

Run: `cd /Users/macbookpro/samtrackly && node --test lib/decisionInventaire.test.mjs`

Expected: FAIL, module/fonction absent.

- [ ] **Step 3: ajouter la fonction SQL transactionnelle**

La fonction verrouille la ligne avec `SELECT ... FOR UPDATE`, refuse tout statut différent de `en_attente`, calcule la quantité et le montant, met à jour la ligne puis les deux agrégats par delta, et insère `decision_ecart_inventaire` dans `journal_activite`. Lever `P0001` avec `EXPLICATION_DEJA_TRAITEE` si la ligne n’est plus en attente.

- [ ] **Step 4: faire utiliser le RPC par SamerTrackly sans changer son écran**

Remplacer les trois écritures de `deciderEcartInventaire()` par :

```js
const { data, error } = await supabase.rpc('decider_ecart_inventaire_atomique', {
  p_ligne_id: ligneId,
  p_statut: statut,
  p_quantite_acceptee: quantiteAcceptee,
  p_prix: prix,
  p_par: par || 'Manager',
})
```

Ajouter `prix: e.prix || 0` à l’appel existant dans `verification.js`. Traduire `EXPLICATION_DEJA_TRAITEE` en message français.

- [ ] **Step 5: exécuter les tests SamerTrackly**

Run: `cd /Users/macbookpro/samtrackly && npm test`

Expected: tous les tests passent.

- [ ] **Step 6: valider la syntaxe SQL et committer**

Run: `cd /Users/macbookpro/samtrackly && npm run lint`

Commit: `feat(inventaire): rendre la décision d'explication atomique`

---

### Task 2: Lecture et décision sécurisées dans l’Edge Function siège

**Files:**
- Create: `supabase/functions/_shared/siege-inventaire.ts`
- Create: `supabase/functions/_shared/siege-inventaire.test.ts`
- Modify: `supabase/functions/siege/index.ts`

**Interfaces:**
- Produces: `inventaire_explications` avec `{ lignes: ExplicationInventaireSiege[] }`.
- Produces: `decider_explication_inventaire` avec `{ ligne_id, statut }`, statut `validee|refusee`.
- Consumes: RPC SamerTrackly de Task 1 et snapshot cloud POS `produit_prix`.

- [ ] **Step 1: écrire les tests en échec des fonctions pures**

Tester le filtrage des seules lignes portant une explication, la normalisation des nombres PostgREST et la construction des paramètres RPC sans accepter de prix venant du navigateur.

```ts
assert.equal(decisionRpc({ ligneId: 'l1', statut: 'refusee', prixSnapshot: 8000, auteur: 'Samer' }).p_prix, 8000);
assert.throws(() => decisionRpc({ ligneId: 'l1', statut: 'autre', prixSnapshot: 8000, auteur: 'Samer' }));
```

- [ ] **Step 2: exécuter le test et constater l’échec**

Run: `node --test supabase/functions/_shared/siege-inventaire.test.ts`

Expected: FAIL, module absent.

- [ ] **Step 3: implémenter le module pur et les appels serveur**

Ajouter un helper PostgREST SamerTrackly avec méthode, corps JSON et en-tête `Prefer: return=representation`. La lecture récupère les shifts de la période, leurs lignes expliquées, les restaurants et les caissiers. La décision relit la ligne SamerTrackly, résout `pos_service_id`, puis lit `produit_prix` dans le cloud POS avant l’appel RPC.

- [ ] **Step 4: ajouter les deux actions au switch**

`inventaire_explications` est accessible à `ADMIN|LECTURE`. `decider_explication_inventaire` appelle `exigeAdmin(siege)`, ignore tout prix fourni par le corps et transforme le code SQL de conflit en HTTP 409 avec le message validé.

- [ ] **Step 5: exécuter les tests de fonctions**

Run: `pnpm test:functions`

Expected: tous les tests passent.

- [ ] **Step 6: committer**

Commit: `feat(siege): exposer les décisions d'inventaire`

---

### Task 3: Préserver les décisions pendant les rejeux du pont

**Files:**
- Modify: `supabase/functions/samtrackly-points/index.ts`
- Modify: `supabase/functions/_shared/samtrackly-inventaire.ts`
- Modify: `supabase/functions/_shared/samtrackly-inventaire.test.ts`

**Interfaces:**
- Produces: `doitCreerDetailInventaire(nbLignesExistantes: number): boolean`.
- Consumes: `inventaires_shifts.pos_service_id` et lignes déjà présentes dans SamerTrackly.

- [ ] **Step 1: écrire le test de non-régression en échec**

Vérifier qu’un inventaire SamerTrackly existant avec des lignes n’est pas supprimé/recréé lors d’un rejeu et qu’un inventaire neuf reçoit toujours ses lignes `en_attente`.

- [ ] **Step 2: exécuter le test ciblé et constater l’échec**

Run: `node --test supabase/functions/_shared/samtrackly-inventaire.test.ts`

Expected: FAIL sur la nouvelle assertion.

- [ ] **Step 3: rendre le détail idempotent**

Avant l’upsert de l’en-tête, lire l’inventaire existant par `pos_service_id`. S’il porte déjà des lignes, ne pas exécuter `DELETE inventaire_lignes` ni les réinsérer, et préserver son `montant_a_deduire`. Pour un nouvel inventaire, conserver exactement la création actuelle.

- [ ] **Step 4: exécuter les tests ciblés puis tous les tests de fonctions**

Run: `node --test supabase/functions/_shared/samtrackly-inventaire.test.ts && pnpm test:functions`

Expected: tous les tests passent.

- [ ] **Step 5: committer**

Commit: `fix(sync): préserver les décisions d'inventaire au rejeu`

---

### Task 4: Écran Inventaire de la console siège

**Files:**
- Create: `apps/siege/src/screens/Inventaire.tsx`
- Modify: `apps/siege/src/api.ts`
- Modify: `apps/siege/src/App.tsx`

**Interfaces:**
- Consumes: actions `inventaire_explications` et `decider_explication_inventaire` de Task 2.
- Produces: onglet `inventaire` dans la navigation siège.

- [ ] **Step 1: définir les types API**

Ajouter `ExplicationInventaireSiege` avec les champs de la spec et `StatutExplicationInventaire = 'en_attente' | 'validee' | 'refusee'`.

- [ ] **Step 2: construire l’écran avec les filtres existants**

Réutiliser `FiltreRestaurant` et `SelecteurPeriode`. Afficher trois boutons d’état avec compteurs, un état de chargement, un état vide explicite et des cartes/lignes contenant tous les chiffres utiles.

- [ ] **Step 3: ajouter les actions ADMIN**

Afficher `Accepter` et `Refuser` uniquement si `niveau === 'ADMIN'` et statut en attente. Demander confirmation, désactiver les boutons pendant l’appel, recharger après succès, et afficher les erreurs françaises renvoyées par `ErreurSiege`.

- [ ] **Step 4: raccorder la navigation**

Ajouter `'inventaire'` à `Ecran`, la section `Inventaire`, et rendre `<Inventaire siege={siege} filtre={filtreResto} onFiltre={setFiltreResto} />`.

- [ ] **Step 5: compiler la console**

Run: `pnpm --filter @pos/siege build`

Expected: TypeScript strict et Vite passent.

- [ ] **Step 6: committer**

Commit: `feat(siege): valider les explications d'inventaire`

---

### Task 5: Documentation et vérification complète

**Files:**
- Modify: `docs/CONSOLE_SIEGE.md`
- Modify: `docs/MAJ_CLE_MASTER.md`

**Interfaces:**
- Consumes: toutes les tâches précédentes.
- Produces: ordre de migration/déploiement exploitable.

- [ ] **Step 1: documenter le parcours et le déploiement**

Documenter l’onglet Inventaire, les droits, la première décision gagnante et l’ordre : migration SamerTrackly, déploiement SamerTrackly utilisant le RPC, Edge Functions `samtrackly-points` puis `siege`, enfin console web.

- [ ] **Step 2: exécuter les vérifications POS**

Run: `pnpm test:functions && pnpm --filter @pos/siege build && pnpm build`

Expected: zéro échec et zéro erreur TypeScript.

- [ ] **Step 3: exécuter les vérifications SamerTrackly**

Run: `cd /Users/macbookpro/samtrackly && npm test && npm run lint`

Expected: zéro test en échec et zéro erreur lint.

- [ ] **Step 4: vérifier les diffs et committer la documentation**

Run: `git diff --check`

Commit POS: `docs(siege): documenter la validation d'inventaire`
