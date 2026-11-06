# Déployer la correction du stock initial

Chaque étape suppose la précédente terminée. L'ordre compte : une caisse qui envoie
une table inconnue du cloud voit ses lignes partir dans `sync_rejets`, et le pont
échoue s'il appelle une fonction SamerTrackly absente.

| Étape | Où | Effet visible | Retour arrière |
|---|---|---|---|
| 1. SQL SamerTrackly | Projet `wlwotzxnzowbkbfcpnyi` | Aucun | Sans risque : le script ne fait qu'ajouter |
| 2. Écrans SamerTrackly | Déploiement web et application | Aucun tant qu'il n'y a pas de correction | Redéployer la version précédente |
| 3. Migration cloud | Projet `vbsmxwlxlcgkodwkbhfa` | Aucun | Sans risque : table vide |
| 4. Fonctions cloud | `sync-push`, `sync-pull`, `samtrackly-points` | Aucun tant qu'il n'y a pas de correction | Redéployer la version précédente |
| 5. Caisses | Site pilote, puis les autres | Le bouton apparaît | Revenir à la version précédente du poste |

## 1. SQL SamerTrackly

Dépôt `~/samtrackly`, branche `feat/correction-stock-initial`. Coller
`supabase_correction_stock_initial.sql` dans le SQL Editor du projet.

Contrôle : le script se termine par la ligne `corrections_stock_initial OK`.

## 2. Écrans SamerTrackly

Fusionner la branche, puis déployer comme d'habitude. Tant que le script de l'étape 1
n'est pas passé, les écrans se comportent comme s'il n'y avait aucun litige.

## 3. Migration cloud

Dépôt caisse. Appliquer `supabase/migrations/20261105000000_corrections_stock_initial.sql`.

Contrôle : `SELECT to_regclass('public.corrections_stock_initial');` ne renvoie pas `NULL`.

## 4. Fonctions cloud

Depuis une branche à jour avec `origin/main` :

```bash
supabase functions deploy sync-push --project-ref vbsmxwlxlcgkodwkbhfa --use-api
supabase functions deploy sync-pull --project-ref vbsmxwlxlcgkodwkbhfa --use-api
supabase functions deploy samtrackly-points --project-ref vbsmxwlxlcgkodwkbhfa --use-api
```

Contrôle : un POST sur `sync-push` avec une fausse `cle_site` répond 401
« Site non autorisé », pas 500. Ne pas appeler `samtrackly-points` à la main : il
écrit de vrais points dans SamerTrackly.

## 5. Caisses

La mise à jour porte la migration locale `0050`. Commencer par le site pilote et
dérouler ce scénario sur un vrai shift :

1. Le sortant valide son inventaire et clôture.
2. Le suivant ouvre son shift et corrige un produit vers le bas, avec une explication.
3. Sans code, la carte du produit affiche « À décider ».
4. À la clôture, le ticket Z porte le bloc « Corrections du stock initial ».
5. Après le transfert, le litige apparaît dans Vérification sur le point du shift.
6. Valider ou Annuler : le montant apparaît sur la ligne du bon caissier et dans le
   total du point.

Passer aux autres sites seulement si ces 6 points sont bons.
