# SPRINT 3 — Moteur de synchronisation cloud (local ↔ Supabase)

C'est le composant le plus critique du projet (risque n°3 du prémortem, §16 du cahier des charges). Objectif de fiabilité absolu : **zéro vente perdue, zéro doublon, même après des coupures d'internet de plusieurs jours.** La caisse ne dépend JAMAIS du cloud : tout fonctionne hors ligne, la synchro rattrape quand internet revient.

Rappels : règles côté serveur, interface en français, aucun test existant cassé, un commit par étape.

---

## Architecture (décidée — ne pas changer)

```
RESTAURANT (local)                          CLOUD (Supabase, projet dédié POS)
┌─────────────────────────┐                ┌────────────────────────────────┐
│ PostgreSQL local        │                │ PostgreSQL Supabase            │
│  └── sync_outbox        │   HTTPS        │  mêmes tables + restaurant_id  │
│ Fastify                 │  sortant       │  RLS par restaurant_id         │
│  └── SyncEngine ────────┼───────────────►│ Edge Function: sync-push       │
│      (montée+descente)  │◄───────────────┼─ Edge Function: sync-pull      │
└─────────────────────────┘                └────────────────────────────────┘
```

- **Uniquement sortant** : le serveur local initie toutes les connexions (§14.4). Aucun port ouvert côté restaurant.
- **Authentification** : chaque site a une clé API propre (`cle_site`), stockée dans `parametres_locaux` en local et dans une table `sites_autorises(restaurant_id, cle_hash, actif)` côté cloud. Les Edge Functions vérifient cette clé à chaque appel. Clé révocable individuellement depuis le cloud (vol de matériel → on coupe UN site).
- **Jamais** de clé service_role Supabase sur le serveur local ni dans les PWA.

## Base cloud

- Migration SQL cloud dans `sql/cloud/schema_cloud.sql` : reprendre les tables métier du schéma local (commandes, commande_items, paiements, services_caisse, audit_log, notations, pointages, appels_table…) avec en plus `restaurant_id UUID NOT NULL` sur chacune, PK = `id` (le même UUID que local), index sur (restaurant_id, created_at).
- RLS activée sur toutes les tables. Politique : accès uniquement via les Edge Functions (service key côté function), aucune lecture anonyme.
- Tables cloud additionnelles : `sites_autorises`, `sync_journal(restaurant_id, type, nb_lignes, dernier_seq, recu_le)` pour le suivi « dernier sync par site », `reconciliations(restaurant_id, jour, total_local, total_cloud, ecart, statut)`.
- Le catalogue, les utilisateurs et les promotions sont édités dans le cloud (source siège) avec une colonne `version BIGINT` incrémentée à chaque modification (trigger).

## A. MONTÉE (local → cloud) — les ventes

`SyncEngine` dans `apps/server/src/modules/sync/` :

1. Boucle toutes les 30 s (config) : lire `sync_outbox WHERE synced_at IS NULL ORDER BY seq LIMIT 200`.
2. Envoyer le lot à l'Edge Function `sync-push` : `{ cle_site, lignes: [{seq, table_name, record_id, operation, payload}] }`.
3. Côté cloud : vérification de la clé → pour chaque ligne, **UPSERT idempotent** sur (id) — rejouer le même lot 10 fois donne exactement le même résultat. Réponse : `{ acquitte_jusqua_seq }`.
4. En local : marquer `synced_at` UNIQUEMENT pour les seq acquittés. Toute erreur (réseau, 5xx) → on ne marque rien, on réessaie au prochain cycle avec backoff progressif (30 s → 1 min → 5 min, plafonné). JAMAIS de suppression dans l'outbox en cas d'erreur.
5. Ordre strict par seq : un lot n'est envoyé que si tous les seq précédents sont acquittés (pas d'envoi parallèle).
6. L'outbox acquitté est purgé après 30 jours (jamais avant).

Interdits absolus : ne jamais bloquer une vente parce que la synchro échoue ; ne jamais modifier une donnée métier locale pendant la montée ; ne jamais marquer synced_at sans acquittement explicite du cloud.

## B. DESCENTE (cloud → local) — catalogue, utilisateurs, promotions

1. Toutes les 5 min (config), appel de `sync-pull` : `{ cle_site, versions: {catalogue: N, utilisateurs: N, promotions: N} }` (versions lues dans `sync_etat`).
2. Le cloud renvoie uniquement les lignes dont version > N, filtrées pour ce restaurant.
3. Application en local en transaction : UPSERT par id, puis mise à jour de `sync_etat`. Les modifications locales du catalogue ne sont pas prévues (le siège est maître) — si un conflit apparaît, LE CLOUD GAGNE pour catalogue/utilisateurs/promotions.
4. La descente ne touche JAMAIS aux tables de ventes (commandes, paiements, services, audit) : celles-ci ne vont que dans un sens, local → cloud.

## C. RÉCONCILIATION QUOTIDIENNE (le filet de sécurité)

1. Chaque nuit à 03h00 locale (node-cron), le serveur local calcule pour la veille : nombre de commandes PAYEES, somme des totaux, somme des paiements par mode.
2. Il l'envoie à l'Edge Function `sync-reconcile`, qui calcule les mêmes chiffres côté cloud pour ce restaurant/jour et enregistre le résultat dans `reconciliations`.
3. Écart = 0 → statut OK. Écart ≠ 0 → statut ECART + le serveur local relance immédiatement une montée complète des lignes du jour concerné (re-poussée idempotente), puis re-vérifie. Si l'écart persiste : voyant rouge sur la page santé + ligne d'audit `ECART_RECONCILIATION`.
4. Commande manuelle `pnpm sync:reconcile -- --jour=AAAA-MM-JJ` pour vérifier n'importe quel jour à la demande.

## D. Page santé — voyant Internet/Synchro (§15.3)

Compléter la page santé du manager :
- Voyant **Internet/Synchro** : vert = dernier acquittement < 5 min ; orange = en attente (hors ligne, N lignes en file, « les ventes continuent normalement ») ; rouge = écart de réconciliation ou erreur répétée > 24 h, avec l'action recommandée en une phrase.
- Afficher : lignes en attente, heure du dernier acquittement, résultat de la dernière réconciliation.
- La pastille discrète de la caisse (vert/orange) lit le même état.

## E. Simulation de pannes (tests obligatoires)

Tests d'intégration avec un faux cloud (serveur HTTP de test) :
1. Coupure pendant l'envoi d'un lot (réponse jamais reçue) → au cycle suivant, le lot est renvoyé → aucun doublon côté cloud (vérifier par comptage).
2. Cloud qui répond 500 par intermittence → backoff respecté, aucune ligne marquée synced_at à tort.
3. 48 h hors ligne simulées (5 000 lignes en file) → reconnexion → tout remonte dans l'ordre, réconciliation OK.
4. Redémarrage brutal du serveur local au milieu d'un cycle → reprise propre (rien perdu, rien dupliqué).
5. Clé de site révoquée → montée refusée proprement (401), voyant rouge, aucune perte locale.
6. Réconciliation détecte un trou artificiel (ligne supprimée manuellement côté cloud de test) → re-poussée automatique → écart résolu.

## Configuration locale (.env du serveur)

```
SUPABASE_SYNC_URL=   (URL du projet, fournie par Ange)
CLE_SITE=            (générée par le script d'enrôlement)
SYNC_INTERVALLE_MONTEE=30
SYNC_INTERVALLE_DESCENTE=300
```
Script `pnpm site:enroler` : génère la clé du site, affiche le SQL à exécuter côté cloud pour l'enregistrer (insertion du hash dans `sites_autorises`).

## Définition de « terminé »

1. Une vente encaissée apparaît dans la table cloud `commandes` en < 60 s quand internet est présent.
2. Couper internet (désactiver le WiFi du Mac), encaisser 3 ventes, rallumer → les 3 remontent, une seule fois chacune.
3. Modifier un prix dans le cloud → il descend en local en < 5 min ; les commandes déjà passées gardent leur ancien prix (snapshot intact).
4. Les 6 tests de simulation de pannes passent.
5. La réconciliation du jour affiche 0 écart sur la page santé.
6. Tous les tests existants passent toujours.
