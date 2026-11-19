# Codes promo « cartes colis »

Autocollants −20 % glissés dans les sacs de livraison. Le client scanne le QR,
garde son code sur son numéro, et son numéro suffit à sa prochaine commande.
Le brief complet, avec les règles R1 à R13 et le backlog, est hors dépôt :
`~/BRIEF_CODES_PROMO_CARTES.md`.

Principe : **seule la caisse consomme un code** (passage à `UTILISE`). Le site
active, vérifie et réserve. La console crée et annule les lots.

## Données (cloud POS)

Migration `supabase/migrations/20261119000000_promo_cartes.sql` (PROMO-02) :
`promo_lots`, `promo_codes`, `promo_categories_exclues`, `promo_utilisations`,
`promo_conflits`, `promo_essais`, coordonnées des restaurants (`telephone`,
`adresse`, `prefixe_promo`, `slug_site`), colonnes `code_promo_*` sur
`commandes` et `notes_split`. Toutes les tables sont fermées au public : seule
la clé de service y accède.

Statuts d'un code : `DISPONIBLE` → `RESERVE` → `UTILISE`, ou `ANNULE` quand
son lot est annulé. Garder un code sur un numéro ne change pas son statut.

Format : préfixe du restaurant, tiret, 5 caractères sans 0, O, 1, I ni L
(`PAM-7K3QX`). Préfixes : PAM Palmeraie, ANG Angré 7E, SAN Lavage, MAR Maroc,
OAS Oasis, BRA À la Braise, AKK Al Kayan KMS, AKY Al Kayan Yop.

## Fonction `promo` (PROMO-03)

Migration `supabase/migrations/20261119010000_promo_fonctions.sql` : tirage
des codes, création et annulation d'un lot (atomiques), compteurs, numéros à
relancer. EXECUTE retiré à `anon` et `authenticated`.

Toutes les requêtes sont des `POST` JSON `{ "action": "…", … }`.

### Porte du site (serveur SAMER DELIV uniquement)

En-têtes obligatoires :

| En-tête | Contenu |
|---|---|
| `x-promo-secret` | secret partagé, secret de fonction `PROMO_SECRET_SITE` côté cloud |
| `x-client-ip` | IP du client, que le cloud ne voit pas derrière Vercel |

Sans secret valide : `401`. Le secret n'est pas encore posé : la porte reste
fermée jusqu'au branchement du site (PROMO-11).

| Action | Corps | Réponse `ok: true` |
|---|---|---|
| `consulter` | `code` | `restaurant`, `pourcentage`, `valide_du`, `valide_au`, `deja_garde` |
| `activer` | `code`, `telephone`, `consentement: true` | `deja`, `restaurant`, `pourcentage`, dates |
| `verifier` | `slug_site`, `code` **ou** `telephone`, `lignes?` | `code_masque`, `code` (si tapé), `pourcentage`, `valide_au`, `remise_estimee?` |
| `reserver` | idem + `ref_site` | idem + `reserve_jusqua` (2 h) |

`lignes` : `[{ "montant": 6500, "exclue": false }]`, montants entiers en FCFA,
déjà au prix du happy hour s'il s'applique. `exclue` vient de `exclue_promo`
côté site. La remise est une estimation, arrondie ligne par ligne comme la
caisse.

Refus : `{ ok: false, motif, message }`, le message est en tutoiement et prêt
à afficher. Motifs : `INVALID`, `ALREADY_USED`, `EXPIRED`, `NOT_STARTED`,
`WRONG_BRANCH`, `NO_ELIGIBLE_ITEM`, `ALREADY_CLAIMED`, `NO_ACTIVE_CODE`,
`CONSENT_REQUIRED`, `INVALID_PHONE`, et `RATE_LIMITED` (HTTP 429).

Par numéro, le site ne reçoit que le code masqué (`PAM-•••QX`) : on ne livre
pas le code d'un client à quiconque connaît son numéro.

Limite d'essais : 10 **codes inconnus** depuis la même IP dans l'heure
bloquent cette IP une heure. Un numéro sans code ne compte pas : le site
vérifie le numéro à chaque commande, et beaucoup de clients partagent une IP
d'opérateur mobile. L'IP n'est jamais stockée, seulement son empreinte.

### Porte de la console du siège

Jeton de session, comme la fonction `siege`.

| Action | Droits | Effet |
|---|---|---|
| `lots` (`restaurant_id?`) | tous | lots et compteurs : gardés, réservés, utilisés par canal, CA, remise, conflits |
| `lot_creer` (`restaurant_id`, `libelle`, `quantite`, `pourcentage?`, `du?`, `au?`) | ADMIN | crée le lot et ses codes ; par défaut du lendemain pendant 28 jours |
| `lot_annuler` (`restaurant_id`, `lot_id`) | ADMIN | codes non utilisés → `ANNULE` |
| `lot_codes` (`restaurant_id`, `lot_id`) | ADMIN | codes en clair et coordonnées du restaurant, pour l'impression |
| `relances` (`restaurant_id?`, `jours?`) | ADMIN | numéros gardés avec consentement, non utilisés, qui expirent dans `jours` (3 par défaut, `null` = tous) |

`lot_codes` et `relances` sont réservés aux ADMIN : l'un donne des bons de
réduction, l'autre des numéros de téléphone. Création et annulation sont
tracées dans `siege_audit`.

## Déploiement

1. Migrations : `20261119000000_promo_cartes.sql` puis `20261119010000_promo_fonctions.sql`.
2. `supabase functions deploy promo --project-ref vbsmxwlxlcgkodwkbhfa --use-api --no-verify-jwt`
3. Au branchement du site : poser `PROMO_SECRET_SITE` (`supabase secrets set`)
   et la même valeur dans les variables Vercel du site.
4. Avant de mettre à jour les caisses avec les codes promo : redéployer
   `sync-push`, pour que `promo_utilisations` et `code_promo_*` soient acceptés.

Contrôle : sans session, `{"action":"lots"}` répond 401 « Connexion requise » ;
sans secret, `{"action":"verifier"}` répond 401 « Accès refusé ».

## Où chaque règle est vérifiée (PROMO-05)

Deux jeux de tests, selon qui applique la règle :

- **Base** : `supabase/tests/promo_regles.sql`. À coller dans l'éditeur SQL de
  `pos-samer-cloud`. Il se termine toujours par une erreur volontaire, qui
  annule tout ce qu'il a écrit : « PROMO TESTS OK — n vérifications » ou
  « PROMO ÉCHEC — » suivi de la règle cassée. Sans trace, rejouable en production.
- **Fonction `promo`** : `node --experimental-strip-types --test supabase/functions/_shared/promo.test.ts`.

| Règle | Ce qui la garantit | Test |
|---|---|---|
| R1 usage unique | contraintes de statut ; réservation par `UPDATE … WHERE statut = 'DISPONIBLE'` : une seule gagne | SQL |
| R2 restaurant | fonction `promo` (`refusUtilisation`) | TS |
| R3 validité | fonction `promo`, dernier jour inclus | TS |
| R4 exclusion Chawarma | table `promo_categories_exclues` (descend aux caisses) ; remise estimée hors lignes exclues | SQL + TS |
| R5 montant | arrondi ligne par ligne comme la caisse | TS |
| R6 un code par commande | caisse (PROMO-09) | — |
| R7 panier sans éligible | fonction `promo` (`NO_ELIGIBLE_ITEM`) | TS |
| R8 annulation de commande | caisse (PROMO-10) | — |
| R9 libération des réservations | `promo_liberer_reservations` + pg_cron (PROMO-04) | SQL, sauté tant que PROMO-04 n'est pas appliqué |
| R10 seule la caisse consomme | aucune action du site n'écrit `UTILISE` | revue de code |
| R11 un code, un numéro | `UPDATE … WHERE telephone IS NULL` : le second numéro ne trouve plus rien | SQL + TS |
| R12 recherche par numéro | format `+225XXXXXXXXXX` (contrainte) ; le plus proche de l'expiration d'abord | SQL + TS |
| R13 consentement | contrainte « pas de numéro sans consentement » + refus côté fonction | SQL + TS |

Le script vérifie aussi le tirage d'un lot (codes uniques, préfixe), son
annulation (les utilisés restent), les compteurs de la console, les relances,
la version qui fait descendre chaque modification aux caisses, et que rien
n'est ouvert à la clé publique (fonctions et tables).

Une vraie course entre deux connexions ne se rejoue pas depuis l'éditeur SQL :
le test vérifie la condition qui la tranche. Postgres réévalue un `UPDATE …
WHERE statut = 'DISPONIBLE'` mis en attente par un autre : le second ne trouve
plus la ligne.
