# Validation des explications d’inventaire depuis la console siège

## Objectif

Ajouter à la console siège une seconde interface permettant d’accepter ou de
refuser les explications d’écart d’inventaire déjà gérées par SamerTrackly.
Cette nouvelle interface ne constitue pas un sas bloquant : le transfert du POS
vers SamerTrackly reste automatique et inchangé.

SamerTrackly reste la source de vérité de la décision. Une décision prise dans
la console siège ou dans SamerTrackly produit le même état métier.

## Règles validées

1. Une explication continue d’arriver dans SamerTrackly avec le statut
   `en_attente`, même si le siège ne l’a pas consultée.
2. Un ADMIN de la console siège peut valider ou refuser cette explication.
3. SamerTrackly conserve son écran et son fonctionnement actuels de validation.
4. La première décision enregistrée gagne. Une seconde tentative reçoit le
   message : « Cette explication a déjà été traitée ».
5. Un compte siège `LECTURE` peut consulter les explications et décisions, mais
   ne peut pas agir.
6. La console ne modifie ni le comptage saisi au restaurant ni le texte de
   l’explication.

## Architecture retenue

La console appelle exclusivement l’Edge Function `siege`, avec le JWT Supabase
de l’utilisateur. Cette fonction vérifie l’appartenance à `siege_utilisateurs`
et appelle ensuite SamerTrackly avec son secret serveur, déjà utilisé par les
écrans du siège.

Deux actions sont ajoutées :

- `inventaire_explications` : lecture paginée des lignes expliquées, avec leurs
  restaurant, date, service, caissier, produit, écart, quantité expliquée,
  montant et état de décision ;
- `decider_explication_inventaire` : décision réservée aux ADMIN, déléguée à
  une fonction SQL transactionnelle dans la base SamerTrackly.

Aucune table miroir de décision n’est créée dans le cloud POS. Dupliquer cet
état créerait deux sources de vérité et rendrait les conflits inévitables.

## Écran de la console

Un onglet `Inventaire` est ajouté à `apps/siege` avec le filtre restaurant déjà
partagé par les autres écrans et un filtre de période.

L’écran présente trois états :

- `En attente` ;
- `Validées` ;
- `Refusées`.

Chaque ligne montre au minimum le restaurant, la date, le caissier, le produit,
le stock théorique, le stock compté, l’écart, la quantité expliquée, le texte de
l’explication et le montant concerné. Les actions sont masquées pour un compte
`LECTURE`.

La validation accepte la quantité expliquée proposée par le restaurant, dans
la limite absolue de l’écart. Le refus fixe la quantité acceptée à zéro et
rétablit la déduction pleine. Les deux actions exigent une confirmation.

## Décision transactionnelle dans SamerTrackly

Une migration SamerTrackly ajoute une fonction SQL atomique appelée par la
fonction siège et par l'écran SamerTrackly existant. Elle :

1. verrouille la ligne `inventaire_lignes` concernée ;
2. vérifie que `explication_statut = 'en_attente'` ;
3. calcule côté serveur la quantité acceptée et le nouveau montant déduit ;
4. écrit `validee` ou `refusee`, `quantite_acceptee`, l’auteur et la date ;
5. ajuste par delta `inventaires_shifts.montant_a_deduire` ;
6. ajuste par delta `points.montant_inventaire` lorsque cette colonne existe ;
7. journalise la décision ;
8. valide l’ensemble dans une seule transaction.

Si la ligne n’est plus en attente, la fonction n’écrit rien et renvoie un
conflit métier. Cela protège les décisions concurrentes provenant de la console.

Pour garantir également la règle « première décision gagnante » depuis l’écran
SamerTrackly existant, son appel de décision devra utiliser cette même fonction
transactionnelle. L’interface, les libellés et les possibilités de décision de
SamerTrackly ne changent pas ; seul le mécanisme d’écriture devient atomique.

## Calculs

Les calculs restent ceux de SamerTrackly :

- validation : `quantite_acceptee = min(abs(ecart), nombre_explique)` ;
- refus : `quantite_acceptee = 0` ;
- déduction : `max(0, abs(ecart) - quantite_acceptee) × prix_produit`.

Le prix doit être résolu par l’Edge Function à partir du snapshot
`inventaire_lignes.produit_prix` du cloud POS, identifié par
`inventaires_shifts.pos_service_id` et le code produit. Ce prix figé est celui
qui a servi au comptage ; il est transmis par le serveur à la fonction SQL,
jamais par le navigateur. Le nouveau montant est arrondi en FCFA et les totaux
sont ajustés par rapport à l’ancien `montant_deduit`.

## Erreurs et concurrence

- Ligne absente : « Explication introuvable ».
- Ligne déjà décidée : « Cette explication a déjà été traitée ».
- Compte `LECTURE` : réponse 403, « Cette action est réservée aux administrateurs ».
- Échec SamerTrackly : aucun état local optimiste permanent ; l’écran garde la
  ligne et propose de réessayer.
- Double clic : bouton désactivé pendant l’appel et protection transactionnelle
  côté serveur.

## Compatibilité et historique

Les explications anciennes et nouvelles sont lues directement dans
SamerTrackly. Il n’y a ni migration de statut historique, ni nouvelle file
d’attente, ni activation qui interrompe les transferts. Les décisions déjà
prises restent visibles telles quelles.

Le pont POS → SamerTrackly doit préserver une décision existante lors d’un
rejeu : il ne doit pas supprimer puis recréer une ligne déjà `validee` ou
`refusee` en la remettant à `en_attente`.

## Tests requis

- lecture et filtrage des trois états depuis la console ;
- refus d’écriture pour un compte `LECTURE` ;
- validation d’une explication en attente ;
- refus et restauration de la déduction pleine ;
- mise à jour atomique de la ligne, du shift et du point ;
- première décision gagnante lors de deux décisions opposées ;
- message français lorsqu’une ligne a déjà été traitée ;
- transfert POS inchangé lorsque le siège n’intervient pas ;
- rejeu du pont préservant une décision SamerTrackly existante ;
- build TypeScript de la console et tests du pont verts.

## Hors périmètre

- modifier la saisie d’inventaire sur la caisse ;
- introduire une validation préalable obligatoire au siège ;
- modifier l’apparence ou le parcours de l’écran SamerTrackly ;
- créer une seconde copie des décisions dans le cloud POS.
