# Paiement partiel par articles sur une table

Date : 26 août 2026
Statut : conception validée par le métier

## 1. Problème

Une commande de groupe est saisie sur une table unique. Aujourd'hui, le POS peut diviser le montant de l'addition en notes, mais ces notes ne sont liées à aucun article. La commande et la table ne sont considérées comme réglées qu'après encaissement du total complet.

Le besoin est de permettre à une personne qui quitte la table de choisir et payer immédiatement les produits qu'elle a consommés. Les produits des autres convives restent ouverts sur la même table. Les produits réglés restent visibles pour l'équipe avec la mention « Payé », mais ne figurent plus dans les factures suivantes.

## 2. Objectifs

- Encaisser une sélection d'articles et de quantités sans solder toute la table.
- Conserver une seule commande et un seul `numero_ticket` pour la table.
- Produire un reçu individuel détaillé après chaque règlement.
- Exclure les quantités payées des sélections et factures suivantes.
- Autoriser l'ajout et la modification des seules quantités encore impayées.
- Répartir exactement promotions et remises, sans perdre ni créer un FCFA.
- Associer la fidélité au client qui règle chaque sous-note.
- Résister à deux sélections concurrentes depuis plusieurs caisses.
- Conserver les garanties transactionnelles, d'audit et de synchronisation du POS.

## 3. Décisions métier validées

1. Une quantité partielle peut être sélectionnée : par exemple 1 Coca sur une ligne de 3.
2. Un article dont la quantité vaut 1 ne peut pas être fractionné en parts ou en montants libres.
3. Promotion et remise sont réparties proportionnellement entre les articles.
4. Les articles payés sont immuables ; seuls les articles et quantités impayés restent modifiables.
5. De nouveaux articles peuvent être ajoutés après un paiement partiel.
6. Dès qu'une sous-note a reçu un premier paiement, aucune correction, annulation ou réaffectation n'est possible, y compris avec un PIN manager.
7. Les reçus gardent le numéro principal avec un suffixe : « Ticket 125 — Paiement 1 ».
8. Un reçu individuel ne contient que les articles et paiements de la personne concernée.
9. Le reçu individuel est imprimé automatiquement dès que la sous-note est entièrement payée.
10. Le partage actuel par montants égaux ou libres est remplacé par le paiement par articles.
11. La fonction est ouverte depuis l'écran Paiement avec « Payer par articles ».
12. Chaque sous-note peut être associée à son propre client fidélité.

## 4. Modèle retenu

La commande reste l'agrégat principal. Une sous-note représente la sélection et le règlement d'une personne. Les paiements existants continuent de porter un `note_id`, mais la note est désormais reliée aux articles et quantités qu'elle facture.

### 4.1 Extension de `notes_split`

La table existante est conservée pour éviter une rupture des paiements et de l'historique. Elle reçoit les informations nécessaires à un reçu autonome :

- `type` : `ARTICLES` pour le nouveau flux, `MONTANT_HISTORIQUE` pour les anciennes notes ;
- `numero` : numéro séquentiel dans la commande ;
- `statut` : `A_PAYER`, `PARTIELLEMENT_PAYEE`, `PAYEE` ou `ANNULEE` ;
- `sous_total`, `promo_montant`, `remise_montant`, `fidelite_montant` et `montant` ;
- `client_fidelite_id` et `fidelite_points` ;
- `service_id`, `payee_par`, `created_at` et `payee_le`.

Une contrainte unique porte sur `(commande_id, numero)`. Les montants restent des `INTEGER` en FCFA.

### 4.2 Nouvelle table `note_split_items`

Chaque ligne relie une sous-note à un `commande_item` avec :

- un UUID serveur ;
- `note_id` ;
- `commande_item_id` ;
- la `quantite` entière affectée ;
- le `montant_brut` figé pour cette quantité.

La quantité doit être strictement positive. Une contrainte unique sur `(note_id, commande_item_id)` empêche de dupliquer la même ligne dans une sous-note. La somme des allocations actives d'un article ne peut jamais dépasser `commande_items.quantite` ; cette règle est vérifiée dans la transaction après verrouillage de la commande.

Les allocations d'une note annulée avant tout paiement restent tracées, mais ne réservent plus les quantités.

### 4.3 Fidélité

`points_fidelite` reçoit un `note_id` facultatif. Une nouvelle sous-note crédite les points une seule fois lors de son passage à `PAYEE`, sur son montant net. L'utilisation de points et le client sont également portés par la sous-note. Les colonnes de fidélité de `commandes` restent disponibles pour l'historique et les commandes antérieures à cette évolution.

## 5. Invariants serveur

- Une quantité est disponible si elle n'est affectée à aucune sous-note active.
- Une sous-note sans paiement peut être annulée ; une sous-note ayant reçu au moins un FCFA ne peut plus l'être ni être modifiée.
- La somme des paiements d'une sous-note ne dépasse jamais son `montant`.
- Une sous-note passe à `PAYEE` uniquement si la somme de ses paiements est exactement égale à son montant.
- Un article payé ou réservé par une sous-note partiellement payée n'est plus sélectionnable.
- La quantité d'une ligne de commande ne peut pas être abaissée sous sa quantité réservée ou payée.
- Une ligne comportant une quantité payée ne peut être annulée ni voir son prix, ses options ou ses suppléments modifiés.
- Une commande passe à `PAYEE` uniquement lorsque toutes ses quantités actives appartiennent à des sous-notes payées et qu'aucune sous-note active ne conserve de reste.
- La table reste `OCCUPEE` jusque-là, puis passe à `LIBRE` dans la transaction du dernier paiement.
- Les articles, reçus et points payés sont immuables.

Le verrou `FOR UPDATE` de la commande sérialise la création des sous-notes. Après le verrou, le serveur recalcule les quantités disponibles ; une seconde caisse qui a affiché un état ancien reçoit « Cet article vient d'être sélectionné sur une autre caisse ».

## 6. Calcul des montants

Le serveur calcule toujours les montants ; le client n'envoie que les identifiants d'articles et les quantités.

Pour une sélection :

1. calculer son montant brut depuis les prix, options et suppléments figés dans `commande_items` ;
2. déterminer les pools de promotion et de remise encore attribuables aux quantités impayées ;
3. attribuer à la sélection une part proportionnelle à son poids brut ;
4. distribuer les éventuels restes de division par la méthode des plus grands restes, avec un ordre stable par UUID ;
5. figer ces montants sur la sous-note.

Ainsi, la somme finale des parts est exactement égale aux réductions de la commande. Une sous-note déjà créée ne change jamais. Après le premier paiement partiel, une remise manuelle globale ne peut plus être modifiée. Les nouveaux articles sont évalués avec les promotions actives au moment de leur ajout et rejoignent uniquement le solde impayé ; ils ne modifient aucun reçu antérieur.

Le total courant de la commande est présenté comme : montants nets figés des sous-notes actives + montant net recalculé des quantités encore libres. Le reste à payer soustrait tous les paiements déjà enregistrés.

## 7. API et transactions

### 7.1 Créer une sélection

`POST /api/commandes/:id/sous-notes`

Corps : liste de `{ commande_item_id, quantite }`. La route verrouille la commande, valide les disponibilités, calcule les réductions, crée la note et ses allocations, écrit l'outbox et l'audit, puis renvoie la commande actualisée.

### 7.2 Annuler une sélection non commencée

`POST /api/commandes/:id/sous-notes/:noteId/annuler`

La route est acceptée uniquement lorsque la note ne possède aucun paiement. Elle passe la note à `ANNULEE` et libère ses allocations. Il n'existe aucune route de correction après un premier paiement.

### 7.3 Encaisser

`POST /api/commandes/:id/paiements` conserve sa forme, mais un `note_id` est obligatoire pour le nouveau flux. Chaque paiement peut utiliser un mode différent. La transaction :

1. verrouille la commande et charge la sous-note ;
2. refuse une note annulée ou déjà payée ;
3. refuse tout dépassement ;
4. insère le paiement et son outbox ;
5. actualise le statut de la note ;
6. crédite la fidélité et fige le reçu lorsque la note est soldée ;
7. solde la commande et libère la table seulement si toutes les quantités sont payées.

L'impression intervient après validation de la transaction. Un échec d'imprimante ne remet jamais en cause l'encaissement et reste réimprimable depuis l'historique.

### 7.4 Lecture

`CommandeVue` expose pour chaque article les quantités totale, réservée, payée et disponible. Chaque `NoteSplitVue` expose ses articles, réductions, client, paiements, statut et reste. Les WebSockets existants diffusent la commande après toute sélection ou tout paiement.

## 8. Parcours PWA

L'écran Paiement conserve le règlement intégral pour une commande simple. « Payer par articles » remplace les boutons de partage égal et la saisie libre.

Le mode de sélection affiche :

- les articles disponibles avec cases tactiles d'au moins 48 px ;
- un sélecteur de quantité lorsque la ligne en contient plusieurs ;
- « Tout sélectionner » pour régler rapidement tout le solde ;
- le montant brut, la part de réduction et le total de la sélection ;
- l'association facultative d'un client fidélité ;
- une confirmation avant la création de la sous-note.

Le paiement affiche le reste de la sous-note en très grand et conserve les paiements mixtes. Le bouton d'encaissement est désactivé en cas de dépassement.

Sur la commande de table :

- les quantités payées restent visibles, grisées, avec « Payé — Paiement N » ;
- les quantités réservées portent « Paiement en cours » ;
- seules les quantités disponibles figurent dans la prochaine facture ;
- une note incomplète propose « Reprendre le paiement » ;
- après une note payée, le POS revient à la table si un solde subsiste ;
- après la dernière note, le POS confirme l'encaissement et libère la table.

Tous les messages restent en français courant.

## 9. Reçus et impression

`PrinterService` reçoit une opération d'impression de sous-note. `ConsolePrinter`, ESC/POS et le reçu PDF utilisent la même vue figée.

Le reçu porte :

- l'identité du restaurant ;
- « Ticket 125 — Paiement 1 » ;
- uniquement les produits et quantités de la sous-note ;
- promotion, remise et fidélité de la personne ;
- détail des modes de paiement ;
- total réglé et points gagnés ;
- date, caissier et table.

Les articles des autres convives n'apparaissent jamais sur ce reçu.

## 10. Rapports et clôture

- Les modes de paiement et le théorique espèces continuent de provenir des lignes `paiements`, y compris lorsque la table reste ouverte.
- Les ventes d'articles déjà réalisées proviennent des allocations de sous-notes payées ; elles ne sont pas recomptées lorsque la commande finale passe à `PAYEE`.
- Les commandes historiques sans allocations conservent les requêtes actuelles.
- Le nombre de commandes utilise le ticket principal, tandis qu'un compteur séparé peut indiquer le nombre de paiements individuels.
- Une sous-note partiellement payée apparaît au rapport Z comme « encaissement incomplet » avec les montants déjà reçus, afin que le tiroir reste explicable.
- Top plats, retours, promotions, remises et fidélité ne comptent chaque quantité qu'une fois.

## 11. Audit, synchronisation et schémas

Les actions `CREATION_SOUS_NOTE`, `ANNULATION_SOUS_NOTE` et `PAIEMENT_SOUS_NOTE` sont journalisées avec commande, numéro, articles, quantités, montants et auteur. Aucun journal existant n'est modifié ou supprimé.

Les écritures de `notes_split`, `note_split_items`, `paiements` et `points_fidelite` produisent leur outbox dans la même transaction. Les évolutions sont appliquées conjointement à :

- `sql/schema.sql`, source de vérité ;
- au miroir Drizzle et à une migration locale ;
- au schéma cloud et à sa migration Supabase ;
- aux types de synchronisation de la fonction siège.

Les anciennes notes monétaires sont marquées `MONTANT_HISTORIQUE`. Une note historique déjà commencée reste encaissable par la route compatible, mais aucune nouvelle note monétaire ne peut être créée après déploiement.

## 12. Tests et critères d'acceptation

Tests serveur obligatoires :

- allocation de 1 unité sur une ligne de 3 ;
- refus d'une quantité supérieure au disponible ;
- deux créations concurrentes sur le dernier article : une seule réussit ;
- répartition proportionnelle et exacte des réductions, arrondis compris ;
- impossibilité de modifier une quantité payée ;
- annulation possible avant paiement et impossible après le premier FCFA ;
- paiement mixte exact d'une sous-note ;
- commande non payée et table occupée après une première sous-note ;
- ajout d'un article après paiement partiel ;
- fidélité créditée une seule fois au bon client ;
- commande payée et table libérée après le dernier article ;
- rapports sans double comptage ;
- audit append-only et outbox transactionnelle ;
- compatibilité des notes historiques.

Parcours manuel d'acceptation :

1. ouvrir une table et commander 3 Coca, 2 Chawarmas et 1 Pizza ;
2. sélectionner 1 Coca et 1 Chawarma pour le premier client ;
3. associer son compte fidélité et payer en espèces + Wave ;
4. vérifier le reçu individuel et les mentions « Payé » sur la table ;
5. ajouter une boisson à la table ;
6. vérifier que la facture suivante exclut les articles du premier client ;
7. payer tous les articles restants ;
8. vérifier la libération de la table, les rapports, le ticket Z et l'absence de double comptage.

La livraison partenaire sans encaissement, les Kdo et les remboursements restent hors de ce nouveau flux.

## 13. Ordre de déploiement

Déployer les éléments dans cet ordre afin qu'aucun client ni moteur de synchronisation n'envoie une structure inconnue :

1. appliquer la migration locale `0028_paiement_par_articles.sql` sur chaque serveur de restaurant ;
2. déployer le serveur local compatible avec les anciennes notes monétaires et les nouvelles sous-notes par articles ;
3. déployer la PWA caisse, qui envoie désormais les sélections et le `note_id` ;
4. appliquer la migration cloud `20260826000000_paiement_par_articles.sql` ;
5. redéployer les fonctions Supabase de synchronisation avec leurs nouvelles listes blanches.

En cas de retour arrière de la PWA, le serveur continue d'accepter un paiement intégral simple en créant automatiquement une sous-note couvrant tous les articles disponibles. Les sous-notes par articles déjà créées ne doivent jamais être supprimées ni reconverties en partage monétaire.
