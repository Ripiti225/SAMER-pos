# Correction du stock initial en début de shift

## Objectif

Permettre au caissier qui prend son shift de corriger un stock initial faux, sans
payer l'erreur de son prédécesseur et sans pouvoir se servir de la correction pour
couvrir ce qu'il a pris lui-même.

Exemple : le sortant déclare 14 poulets, il en reste 12. Sans correction, le
manquant de 2 retombe le soir sur le nouveau caissier.

## Règles validées

1. Bouton « Modifier le stock initial » sur chaque produit compté, pendant la
   première heure du shift, tant que l'inventaire du shift n'est pas validé.
2. L'heure part de `services_caisse.ouvert_le`, jamais de la connexion : se
   déconnecter et se reconnecter ne relance pas le délai. Le serveur vérifie avec
   sa propre horloge.
3. L'explication est obligatoire à chaque modification. Le chiffre change tout de
   suite, quel que soit le statut du litige.
4. Le stock saisi est celui **à l'ouverture**, pas celui du moment.
5. On ne soustrait jamais la correction de l'écart du sortant : on le **recalcule**.
6. Une correction qui ne crée ni n'augmente aucun manquant du sortant n'ouvre pas
   de litige.
7. Une correction qui crée ou augmente un manquant ouvre un litige :
   - le code du sortant, ou le code d'un manager avant la clôture, l'impute au sortant ;
   - sinon il part dans SamerTrackly à la clôture, où le propriétaire décide :
     **Valider** (le sortant paie) ou **Annuler** (le caissier sur place paie).
8. Le délai d'une heure limite la correction, pas la validation : le manager peut
   valider jusqu'à la clôture. Un litige en attente ne bloque pas la clôture.
9. Annuler ne remet pas l'ancien chiffre dans le stock de la caisse : le stock
   physique reste celui qui a été corrigé. La décision change seulement qui paie.

## Calcul

Le théorique du sortant se lit dans sa ligne d'inventaire figée à la validation :
`theorique = stock_initial + entrees - sorties`.

```text
ecart_avant  = stock_compte du sortant - theorique
ecart_apres  = stock corrigé           - theorique
expliquee    = quantite_expliquee si ecart_avant < 0, sinon 0
manque(e)    = max(0, -e - expliquee)
litige       ⇔ manque(ecart_apres) > manque(ecart_avant)
```

| Attendu | Compté par le sortant | Corrigé | Écart du sortant | Résultat |
|---|---|---|---|---|
| 10 | 12 | 10 | +2 → 0 | Aucun litige, surplus annulé |
| 10 | 12 | 9 | +2 → −1 | Litige, manquant de 1 |
| 14 | 14 | 12 | 0 → −2 | Litige, manquant de 2 |
| 10 | 8 | 10 | −2 → 0 | Aucun litige, retenue annulée |

Une explication écrite sur un surplus n'excuse pas un manquant créé par la correction.

Le montant dépend de la décision :

- **Valider** : la ligne du sortant reprend le stock corrigé, et son montant est
  recalculé avec `ecart_apres`.
- **Annuler** : la ligne du caissier sur place reprend le stock initial d'origine,
  et son écart devient `ecart - (stock_reporte - stock_corrige)`. Si ce caissier n'a
  pas d'écart enregistré (inventaire débloqué), son écart devient
  `-(stock_reporte - stock_corrige)`.

Exemple 10 / 12 / 9 : Valider facture 1 boisson au sortant ; Annuler en facture 3 au
caissier sur place, si son propre comptage tombait juste.

## Cas particuliers

| Cas | Traitement |
|---|---|
| Même caissier sur les deux shifts | `RECONNUE_SORTANT` d'office, sans autre code |
| Aucun inventaire validé avant, ou produit absent de l'inventaire précédent | Pas de sortant : correction tracée, sans litige |
| Le shift précédent a été débloqué sans comptage | Le chiffre vient d'un caissier plus ancien : pas de validation sur place, le litige part dans SamerTrackly avec cet avertissement |
| Deuxième correction du même produit | Elle remplace la première (`REMPLACEE`, conservée) et repart du chiffre d'origine pour le calcul ; il faut valider à nouveau |
| Le manager est l'auteur de la correction ou le caissier sur place | Son code est refusé pour la validation manager |
| Le shift du sortant n'est pas encore arrivé dans SamerTrackly | Une correction avec manquant passe en décision manuelle, refusée avec un message clair tant que le shift n'est pas arrivé. Une correction `SANS_LITIGE` reste en trace (`information`), sans recalcul |

## Caisse (POS)

### Données

Nouvelle table `corrections_stock_initial`, ajoutée à `sql/schema.sql`, au schéma
Drizzle et à la migration `0050` :

- `inventaire_id`, `produit_id`, et le snapshot `produit_code`, `produit_nom`, `produit_prix` ;
- `stock_reporte` (chiffre d'origine), `stock_avant`, `stock_apres` ;
- `explication` (non vide) et `saisi_par` ;
- `service_sortant_id`, `caissier_sortant_id` (nuls s'il n'y a pas de sortant) ;
- `shift_intermediaire_debloque` ;
- `ecart_sortant_avant`, `ecart_sortant_apres` ;
- `statut` : `SANS_LITIGE`, `A_VALIDER`, `RECONNUE_SORTANT`, `VALIDEE_MANAGER`, `REMPLACEE` ;
- `valide_par`, `valide_le`, `created_at`.

Un index unique partiel garantit une seule correction active par produit et par
inventaire (`statut <> 'REMPLACEE'`). `inventaire_lignes.stock_initial` reste le
chiffre utilisé par tous les calculs existants, donc le stock sous les plats, le
tirage et le ticket Z suivent sans modification de leur formule.

Chaque INSERT et UPDATE écrit une ligne `sync_outbox` dans la même transaction.

### Routes

- `GET /api/inventaire/lignes/:produitId/correction` : sortant, stock repris,
  théorique du sortant, sorties depuis l'ouverture, et fin du délai.
- `POST /api/inventaire/lignes/:produitId/corriger-initial` : `stock_initial`,
  `explication`, et au plus un de `pin_sortant` ou `pin_manager`.
- `POST /api/inventaire/corrections/:id/valider` : exactement un de `pin_sortant` ou
  `pin_manager`. Possible seulement sur `A_VALIDER`, avant la clôture, et hors
  `shift_intermediaire_debloque`.

Toutes exigent `inventaire.saisir`. Les refus sont appliqués côté serveur, avec un
message en français :

- délai dépassé ;
- inventaire validé ;
- produit non compté ;
- chiffre inchangé ou négatif ;
- explication vide ;
- PIN faux ou bloqué.

Le code du sortant passe par `verifierPinUtilisateur` et celui du manager par
`verifierPinManager` : mêmes verrous anti-force brute et audit `ECHEC_PIN` qu'ailleurs.
Un PIN refusé renvoie 403, pas 401, pour ne pas fermer la session du caissier.

Deux actions d'audit sont ajoutées : `CORRECTION_STOCK_INITIAL` et
`VALIDATION_CORRECTION_STOCK`, avec les chiffres avant et après, l'explication, le
sortant et le validateur.

### Écran

Dans `screens/Inventaire.tsx` :

- bouton sur chaque `CarteProduit`, masqué après le délai ou après validation, avec
  le temps restant ;
- modale avec le stock repris, le nom du sortant, le stock à l'ouverture, l'explication
  et l'effet prévu (« Manquant de 2 pour le caissier sortant » ou « Aucun litige ») ;
- rappel des sorties depuis l'ouverture, y compris les commandes non payées, car le
  stock ne compte que les commandes payées et le comptage physique doit se comparer
  aux deux ;
- code du sortant ou du manager, facultatif, avec « Passer » ;
- sur la carte, le chiffre d'origine, le chiffre corrigé et l'état du litige, avec
  un bouton « Valider » tant qu'il est en attente.

### Ticket Z

Le rapport Z et les tickets imprimés (`ConsolePrinter`, `escpos`) gagnent un bloc
« Corrections du stock initial » : produit, avant, après, statut. Le rapport du
sortant reste figé et n'est jamais réécrit.

## Cloud

- `corrections_stock_initial` ajoutée à `supabase/functions/_shared/tables.ts`, avec
  sa migration cloud.
- Nouveau module testé `_shared/samtrackly-corrections.ts`.
- `samtrackly-points` transfère les corrections du service après celui-ci. Son échec
  fait échouer le transfert, qui reste visible et rejouable, comme le reste de
  l'inventaire.
- Un rejeu ne réapplique jamais une correction et n'efface jamais une décision.

## SamerTrackly

Même recette que `supabase_correction_entrees.sql` : une table de trace, des fonctions
SQL atomiques, et un recalcul de la ligne, du total du shift et du total du point.
Le montant reste sur `inventaire_lignes.montant_deduit`, car Litiges, Récap du point
et le rapport mensuel additionnent cette colonne.

### Données

Table `corrections_stock_initial`, unique sur `pos_correction_id` :

- produit, prix, explication et auteur ;
- `pos_service_sortant_id`, `pos_service_place_id` ;
- `stock_reporte`, `stock_corrige`, `stock_reel_origine` ;
- `statut` : `information`, `appliquee`, `en_attente`, `validee`, `annulee` ;
- `ancien_montant`, `nouveau_montant`, décideur et date.

### Fonctions

`transmettre_correction_stock_initial` enregistre la correction, sans rien changer si
elle est déjà connue :

| Statut POS | Effet dans SamerTrackly |
|---|---|
| `SANS_LITIGE`, avec sortant | Applique le recalcul sur le sortant (`appliquee`) |
| `SANS_LITIGE`, sans sortant | Trace seule (`information`) |
| `RECONNUE_SORTANT`, `VALIDEE_MANAGER` | Applique le recalcul sur le sortant (`appliquee`) |
| `A_VALIDER` | `en_attente`, sans changer aucun montant |
| `REMPLACEE` | N'est pas transmise |

`decider_correction_stock_initial` verrouille la correction et n'accepte que
`en_attente` : la première décision gagne. Une seconde reçoit « Ce litige a déjà été
traité ».

Le recalcul reprend la formule de `corriger_entree_inventaire` :

- `deduction_annulee` reste respectée ;
- seul un manquant coûte ;
- une quantité acceptée reste acceptée ;
- les totaux bougent par différence.

Si le nouvel écart est nul et que l'explication était `en_attente`, elle sort de la
file. Une décision déjà prise reste affichée, mais son montant suit le recalcul.

### Écrans

Une carte « Litiges de stock initial » est ajoutée à `app/verification.js`, avec un
rappel dans `app/litiges.js`. Elle montre le produit, les deux caissiers, les chiffres,
l'explication, le montant selon chaque décision et un éventuel avertissement, avec
les boutons **Valider** et **Annuler** et une confirmation.

La décision est réservée aux comptes qui voient déjà les écarts sur cet écran : les
rôles SamerTrackly `manager` et `directeur`.

## Déploiement

L'ordre évite qu'un site envoie une table que le cloud refuserait :

1. SamerTrackly : SQL, puis écrans.
2. Cloud : migration, puis `sync-push`, `sync-pull` et `samtrackly-points`.
3. Caisse : mise à jour de chaque site.

Sans mise à jour, un site garde son comportement actuel.

## Tests

**Caisse**

- refus après 1 h, y compris après déconnexion et reconnexion ;
- refus si l'inventaire est validé ;
- explication obligatoire ;
- code d'un autre caissier refusé au titre du sortant ;
- manager auteur ou caissier sur place refusé ;
- les 4 lignes du tableau de calcul ;
- chaque cas particulier ;
- remplacement d'une correction ;
- validation manager après 1 h et avant clôture, refusée après clôture ;
- clôture possible avec un litige en attente ;
- outbox et audit dans la même transaction ;
- ticket Z du sortant inchangé.

**Cloud**

- transfert complet et rejeu sans double facturation ;
- correction absente de la liste si elle est `REMPLACEE`.

**SamerTrackly**

- Valider et Annuler : ligne, shift et point mis à jour ensemble ;
- première décision gagnante ;
- `deduction_annulee` respectée ;
- explication en attente retirée quand l'écart tombe à zéro ;
- shift du sortant absent : décision refusée avec message clair.

## Hors périmètre

- écran dans la console siège : la décision se prend dans SamerTrackly ;
- réglage de la durée d'une heure : c'est une constante ;
- correction du stock initial après la première heure ;
- changement de la saisie du comptage de fin de shift.
