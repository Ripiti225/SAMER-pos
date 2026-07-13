# BRIEF CLAUDE CODE — Réconciliation de fermeture de caisse (SamerTrackly)

> ⚠️ Ce brief a été écrit pour **SamerTrackly** (React Native / Supabase).
> Pour le **POS** (`pos-samer`, Fastify/Drizzle/Postgres/React), les règles sont
> **adaptées** à l'architecture existante (voir le rapport d'exploration).

## NOUVEAU — Deux niveaux de fermeture : SHIFT puis SÉQUENCE

Il peut y avoir **plusieurs shifts dans une même journée** (un shift = un service
caisse ouvert avec un fond de caisse, fermé par le caissier au comptage aveugle).

Tous les shifts d'une journée appartiennent à une **SÉQUENCE**. La séquence n'est
**« rasée » (fermée et remise à zéro) qu'une seule fois par le GÉRANT**, en fin de
journée, via un **onglet « Fermeture de séquence »**.

- La fermeture de séquence **agrège TOUS les shifts faits depuis la dernière
  fermeture de séquence** (ventes, écarts, dépenses, livraisons, par mode…).
- Exemple : shift 1 = 10 000 F, shift 2 = 20 000 F, shift 3 = 30 000 F →
  **vente totale de la séquence = 60 000 F**.
- Seul le gérant (rôle MANAGER / PROPRIETAIRE / SUPERVISEUR) peut fermer la
  séquence ; les caissiers ne ferment que leur shift.
- Une nouvelle séquence démarre automatiquement après la fermeture de la
  précédente ; les shifts suivants s'y rattachent.

## CONTEXTE

- Projet : `/Users/samer/samtrackly` — React Native / Expo, backend Supabase (`wlwotzxnzowbkbfcpnyi.supabase.co`).
- Fichiers probablement concernés : `point-shift.js` (gestion des shifts caissier), `depenses.js` (dépenses), `ventes.js` (ventes), table `points_shifts` (ou équivalent). Vérifier, ne pas supposer.
- Convention existante : colonnes `saisi_par_nom` sur les tables de saisie ; les données saisies après minuit appartiennent à la journée précédente ; les données se réinitialisent par shift.
- Problème : la logique actuelle calcule `vente = espèce finale - fond de caisse`, ce qui est FAUX. On la remplace par un vrai formulaire de réconciliation multi-sources.

## RÈGLES GÉNÉRALES (obligatoires)

1. **Réécris entièrement chaque fichier modifié** (pas de diff partiel, pas de `// ... reste inchangé`).
2. Labels UI en **français**, cohérents avec le style existant de l'app (mêmes composants, mêmes couleurs, mêmes conventions de nommage).
3. Commentaires minimaux dans le code.
4. **Un commit par étape** avec message clair (ex: `feat(caisse): formulaire de réconciliation fermeture shift`).
5. Les règles métier critiques (verrouillage, non-négativité) doivent être **appliquées côté serveur** (contrainte SQL, trigger ou RLS Supabase), pas seulement côté client.
6. Montants en FCFA, entiers, formatés avec séparateur de milliers à l'affichage (suivre le formatage déjà utilisé dans l'app).
7. Tout montant auto-calculé absent/null = **0** (jamais NaN, jamais crash).

---

## ÉTAPE 1 — EXPLORATION (OBLIGATOIRE AVANT TOUT CODE)

Explore le codebase et le schéma Supabase, puis **produis un rapport et ARRÊTE-TOI pour validation** avant de coder. Le rapport doit lister, avec noms exacts (fichier, table, colonne, valeurs) :

1. **Shift / caisse** : l'écran et le composant de fermeture de shift ; la table qui stocke le fond de caisse (probablement `points_shifts` ou `sessions_caisse`) ; les champs `fond_de_caisse`, `created_at`, statut éventuel.
2. **Sources livraison** : tables/requêtes déjà utilisées ailleurs (stats/dashboard) pour **Yango**, **Glovo**, **Samer TELIV** — nom de table, champ montant, champ date, champ restaurant/point de vente.
3. **Ventes/commandes** : la table des commandes du POS, son champ `mode_paiement` et les **valeurs exactes stockées** pour wave / OM (orange money ?) / carte / djamo (casse, accents, variantes).
4. **Dépenses** : où et comment les dépenses sont enregistrées actuellement (`depenses.js`, table associée) — préciser si on réutilise cette table ou si le champ « Dépenses » du formulaire est une saisie indépendante.
5. **Fenêtre du shift** : confirmer comment délimiter la fenêtre `[fond_de_caisse.created_at → maintenant]` et comment la règle « après minuit = journée précédente » s'applique ici.
6. **Multi-restaurants** : confirmer que toutes les requêtes filtrent bien par restaurant/point de vente du shift courant.

Si une hypothèse du brief est fausse (nom de table, valeurs de mode_paiement…), signale-le dans le rapport et propose la correction. **N'écris aucun code avant mon "OK".**

---

## ÉTAPE 2 — NOUVEAU FORMULAIRE DE FERMETURE

Quand le caissier appuie sur **« Fini »**, afficher un formulaire de réconciliation avec ces 8 champs, dans cet ordre :

| # | Champ (label FR) | Source | Comportement |
|---|---|---|---|
| 1 | Dépenses | Saisie manuelle | Clavier numérique, ≥ 0, défaut 0 |
| 2 | Yango cse | Auto : somme ventes Yango sur la fenêtre du shift | **Lecture seule** |
| 3 | Glovo cse | Auto : somme ventes Glovo sur la fenêtre | **Lecture seule** |
| 4 | Samer TELIV cse | Auto : somme ventes Samer TELIV sur la fenêtre | **Lecture seule** |
| 5 | Wave | Auto : somme ventes `mode_paiement = wave` sur la fenêtre | Pré-rempli, **modifiable** |
| 6 | OM | Auto : somme ventes `mode_paiement = OM` | Pré-rempli, **modifiable** |
| 7 | Carte et Djamo | Auto : somme ventes `mode_paiement IN (carte, djamo)` | Pré-rempli, **modifiable** |
| 8 | Espèce en caisse | Saisie manuelle | Clavier numérique ; **jamais négatif** : bloquer la validation et afficher une erreur claire si < 0 ou vide |

- Fenêtre de calcul : `fond_de_caisse.created_at` du shift courant → maintenant, filtrée sur le restaurant du shift.
- Afficher aussi, en lecture seule, le **fond de caisse** du shift (rappel) au-dessus du formulaire.
- Utiliser les valeurs **exactes** de `mode_paiement` trouvées à l'Étape 1 (pas celles supposées ici).
- États UI : loading pendant les requêtes auto, message d'erreur + bouton "Réessayer" si une requête échoue (ne jamais afficher 0 silencieusement en cas d'erreur réseau).

---

## ÉTAPE 3 — CALCUL

```
vente_totale = depenses + yango + glovo + samer_teliv + wave + om + carte_djamo + espece_en_caisse - fond_de_caisse
diff = vente_totale - total_commandes_systeme
```

- `total_commandes_systeme` = somme de **toutes** les commandes enregistrées dans le POS sur la fenêtre du shift, toutes catégories/modes de paiement confondus, même restaurant.
- Afficher `vente_totale`, `total_commandes_systeme` et `diff` en bas du formulaire, mis à jour en temps réel à chaque modification de champ.
- `diff` : afficher signé (ex: `-2 500 FCFA` en rouge si négatif = manquant, vert si ≥ 0), avec libellé explicite (ex: « Écart caisse »).

---

## ÉTAPE 4 — VALIDATION ET VERROUILLAGE

Au clic sur **« Valider »** :

1. Enregistrer en base : les 8 valeurs saisies/calculées + `vente_totale` + `diff` + `total_commandes_systeme` + `saisi_par_nom` (convention existante) + timestamp de fermeture.
   - Si le schéma actuel ne le permet pas : proposer dans le rapport d'Étape 1 soit des colonnes sur `points_shifts`, soit une table dédiée `fermetures_caisse` liée au shift — et fournir le **SQL de migration Supabase complet** correspondant.
2. Marquer le shift comme **fermé** (statut + `closed_at`).
3. **Verrouillage serveur** : une fois fermé, aucune mise à jour possible sur ce shift ni sur sa fermeture (RLS ou trigger Supabase qui rejette tout UPDATE). Le client ne suffit pas.
4. Demander une **confirmation** avant validation (« Cette action est définitive ») car aucun retour en arrière n'est possible.
5. Après validation : afficher un **ticket récapitulatif** non modifiable — toutes les valeurs, fond de caisse, vente_totale, total système, et la `diff` en bas, avec date/heure et nom du caissier.

**Persistance de l'état fermé (source de vérité = base, pas le state local) :**
- Au chargement de l'écran shift, si le shift courant est déjà fermé → afficher directement le ticket récapitulatif (reconstruit depuis la base), jamais le formulaire.
- Cela doit tenir après redémarrage de l'app, reconnexion du caissier, ou changement d'appareil.

---

## ÉTAPE 5 — RECETTE (à vérifier avant de conclure)

- [ ] Shift ouvert → « Fini » → formulaire avec champs auto corrects (croiser avec les stats existantes du dashboard).
- [ ] Champs 2-4 non modifiables ; champs 5-7 pré-remplis et modifiables ; champs 1 et 8 vides/0 par défaut.
- [ ] Espèce en caisse négative ou vide → validation bloquée + message d'erreur.
- [ ] Calcul temps réel de vente_totale et diff correct (tester avec des valeurs connues).
- [ ] Validation → shift fermé en base, ticket affiché.
- [ ] Kill de l'app + réouverture → ticket affiché, pas le formulaire.
- [ ] Tentative d'UPDATE direct sur un shift fermé via Supabase → rejetée (verrouillage serveur).
- [ ] Aucune régression sur l'ouverture de shift (fond de caisse) ni sur les autres écrans (`ventes.js`, `depenses.js`, dashboard).
- [ ] Multi-restaurant : les sommes ne mélangent jamais deux points de vente.

## LIVRABLES

1. Rapport d'exploration (Étape 1) → attendre mon OK.
2. SQL de migration Supabase (fichier séparé, prêt à coller dans le SQL Editor).
3. Fichier(s) réécrits en entier.
4. Un commit par étape.
