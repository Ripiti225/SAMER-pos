# Déploiement du cloud de synchronisation (sprint 3)

Guide pas à pas pour brancher un restaurant à son projet Supabase. Objectif :
**zéro vente perdue, zéro doublon.** La caisse fonctionne toujours hors ligne ;
la synchro rattrape quand internet revient.

Tout se fait en **sortant** depuis le serveur local : aucun port n'est ouvert
côté restaurant, aucune clé `service_role` ne quitte le cloud.

---

## Prérequis

- Un projet Supabase dédié POS (URL + accès au SQL Editor).
- La CLI Supabase installée (`brew install supabase/tap/supabase`) et connectée
  (`supabase login`).
- Le `restaurant` déjà seedé en local (`pnpm db:seed`).

## Étape 1 — Créer le schéma cloud

Dans le **SQL Editor** du projet Supabase, coller et exécuter le contenu de
[`sql/cloud/schema_cloud.sql`](../sql/cloud/schema_cloud.sql). Cela crée :
- les tables de ventes (réplica) avec `restaurant_id` et RLS ;
- les tables de catalogue/utilisateurs/promotions avec `version` + trigger ;
- les tables de contrôle `sites_autorises`, `sync_journal`, `reconciliations`.

## Étape 2 — Déployer les Edge Functions

Depuis la racine du dépôt :

```bash
supabase link --project-ref <REF_DU_PROJET>     # une seule fois
supabase functions deploy sync-push
supabase functions deploy sync-pull
supabase functions deploy sync-reconcile
```

Les fonctions lisent `SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` depuis les
secrets — **déjà injectés automatiquement** par Supabase pour les Edge
Functions. Rien à configurer de plus. (`verify_jwt = false` est déjà réglé dans
`supabase/config.toml` : l'authentification se fait par clé de site.)

## Étape 3 — Enrôler le site

```bash
SUPABASE_SYNC_URL="https://<REF>.supabase.co/functions/v1" pnpm site:enroler
```

Le script :
1. génère la clé de site et la garde **en local** (`parametres_locaux.cle_site`) ;
2. affiche un `INSERT INTO sites_autorises …` à **coller dans le SQL Editor**
   (seul le sha256 de la clé y est stocké).

Colle ce SQL dans Supabase pour autoriser le site.

## Étape 4 — Configurer le serveur local

Dans `apps/server/.env` (voir `.env.example`) :

```
SUPABASE_SYNC_URL=https://<REF>.supabase.co/functions/v1
SYNC_ACTIF=1
```

`CLE_SITE` peut rester vide : elle est lue depuis `parametres_locaux`.

Redémarre le serveur (`pnpm dev`). La montée démarre automatiquement.

## Étape 4 bis — Republier ce qui est né AVANT l'enrôlement

**À faire à chaque installation, une fois la synchro active.** C'est le piège le
plus discret du déploiement : il ne produit aucune erreur, seulement des écrans
vides au siège, des semaines plus tard.

```bash
pnpm roles:republier
pnpm salle:republier
```

### Pourquoi

La montée repose sur `sync_outbox`, qui n'enregistre que les **changements**.
Tout ce qui existe déjà au moment de l'enrôlement n'a donc jamais été publié :

| Donnée | Née où | Publiée à l'enrôlement ? |
|---|---|---|
| Rôles et permissions | migrations SQL `0006`, `0024` (`INSERT INTO roles …`) | **non** — une migration n'écrit pas dans l'outbox |
| Zones et tables de salle | seed / installation, avant l'enrôlement | **non** — et un plan de salle ne change presque jamais ensuite |
| Catalogue (catégories, articles) | `pnpm catalogue:importer`, en local | **non** — et par conception : le catalogue ne remonte jamais |
| Ventes, clôtures, dépenses | à l'usage, après l'enrôlement | oui |

`pnpm roles:republier` remet tous les rôles et leurs permissions dans l'outbox
sans rien modifier en local. Ils montent au cycle suivant (30 s), et l'onglet
**Paramètres** de la console du siège se remplit. Le script est rejouable :
`sync-push` écrit côté cloud en UPSERT sur `(restaurant_id, id)`.

Sans lui, la console affiche « aucun rôle » et diffuser des accès depuis le
siège est impossible — il n'y a rien à viser.

`pnpm salle:republier` fait la même chose pour les **zones et les tables**. Sans
lui, le cloud reçoit `commandes.table_id` — un uuid qu'il ne sait traduire avec
rien — et le tableau de bord ne peut pas dire quelle table travaille le plus.
La console détecte ce cas et l'écrit à l'écran.

### Le catalogue, lui, ne se republie pas

C'est voulu, pas un oubli : **le cloud est maître du catalogue**, il ne fait que
descendre. Un site dont le catalogue a été importé en local reste donc invisible
du siège, et le restera. Pour qu'un article créé au siège arrive sur ce site, il
faut d'abord y créer la catégorie **depuis la console** (onglet Catégories) :
elle descendra, et l'onglet Menu pourra y ranger des articles.

Conséquence à connaître : `categories.nom` n'est pas unique côté site. Créer au
siège une catégorie dont le nom existe déjà en local en donnera **deux** à la
caisse. La console avertit sur ce qu'elle voit — mais elle ne voit pas le
catalogue local du site.

## Étape 5 — Vérifier

- Encaisser une vente → elle apparaît dans la table cloud `commandes` en < 60 s.
- Couper le WiFi, encaisser 3 ventes, rallumer → les 3 remontent une seule fois.
- Page santé manager : voyant **Internet/Synchro** vert, dernières lignes
  acquittées, dernière réconciliation.
- Réconciliation à la demande : `pnpm sync:reconcile -- --jour=AAAA-MM-JJ`.
- **Console du siège, onglet Paramètres** : les rôles du site y apparaissent.
  S'ils manquent, l'étape 4 bis n'a pas été faite.

## Révoquer un site (vol de matériel)

Dans le SQL Editor :

```sql
UPDATE sites_autorises SET actif = FALSE WHERE restaurant_id = '<UUID>';
```

La prochaine montée du site révoqué reçoit 401 : le voyant passe rouge, mais
**aucune vente locale n'est perdue** (l'outbox est conservée).
