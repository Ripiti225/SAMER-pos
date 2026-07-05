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

## Étape 5 — Vérifier

- Encaisser une vente → elle apparaît dans la table cloud `commandes` en < 60 s.
- Couper le WiFi, encaisser 3 ventes, rallumer → les 3 remontent une seule fois.
- Page santé manager : voyant **Internet/Synchro** vert, dernières lignes
  acquittées, dernière réconciliation.
- Réconciliation à la demande : `pnpm sync:reconcile -- --jour=AAAA-MM-JJ`.

## Révoquer un site (vol de matériel)

Dans le SQL Editor :

```sql
UPDATE sites_autorises SET actif = FALSE WHERE restaurant_id = '<UUID>';
```

La prochaine montée du site révoqué reçoit 401 : le voyant passe rouge, mais
**aucune vente locale n'est perdue** (l'outbox est conservée).
