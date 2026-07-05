# CORRECTIONS 3 (retours terrain Ange) — circuit client ↔ serveur complet

Retours d'un test réel : ils priment sur les specs précédentes en cas de contradiction. Rappels : interface en FRANÇAIS, montants FCFA, chaque règle appliquée CÔTÉ SERVEUR, aucun test existant cassé, un commit par point.

Principe directeur de tout ce brief : **le client interagit avec SON serveur. La caisse n'est que le repli quand aucun serveur n'est disponible. La cuisine n'est JAMAIS contactée directement par un client, dans aucun cas.**

---

## Point 1 — Mini-app client : appeler le serveur, demander la facture, suivre sa commande

Ajouter à `apps/client` (page `/t/:qr_token`) :

### 1a. Deux boutons d'appel
- **« Appeler le serveur »** : crée un appel de type `APPEL_SERVEUR` pour la table.
- **« Demander la facture »** : crée un appel de type `DEMANDE_FACTURE` pour la table.
- Nouvelle table `appels_table (id UUID, table_id, type CHECK IN ('APPEL_SERVEUR','DEMANDE_FACTURE'), statut CHECK IN ('EN_ATTENTE','TRAITE'), cree_le, traite_le, traite_par)`.
- Confirmation côté client : « Votre serveur arrive » / « Votre facture arrive ». Anti-abus : 1 appel du même type en attente par table (re-taper ne crée pas de doublon), limitation de débit par appareil.

### 1b. Routage des appels ET des commandes client (règle commune)
- Destinataire prioritaire : le **serveur propriétaire de la table** (voir Point 3). Notification son + badge sur sa tablette.
- Pour `DEMANDE_FACTURE` : le serveur reçoit l'appel et déclenche le flux existant « Demander l'addition » (la caisse imprime la note). L'interaction reste client → serveur → caisse.
- **Repli caisse** : si AUCUN serveur n'est disponible, l'appel ou la commande client arrive directement à la CAISSE avec un **bip sonore** + toast (« Table X appelle », « Table X demande la facture », « Table X : commande client à valider »). La caisse peut alors tout traiter elle-même (valider la commande client, imprimer la note).
- Définition de « aucun serveur disponible » (calculée côté serveur, à chaque événement) :
  1. aucun utilisateur actif avec role SERVEUR n'existe (le caissier n'a inscrit aucun serveur), OU
  2. des serveurs existent mais aucun n'est CONNECTÉ. Présence = session serveur ouverte avec battement de cœur (heartbeat WebSocket) reçu dans les 2 dernières minutes. Déconnexion volontaire ou tablette éteinte/hors ligne > 2 min = déconnecté.
- Cas intermédiaire : la table a un propriétaire mais LUI est déconnecté → router vers un autre serveur connecté de la même zone s'il y en a un, sinon repli caisse. Jamais vers la cuisine.

### 1c. Suivi de commande côté client
- Sous le panier, une zone « Votre commande » montre en temps réel l'état des commandes de la table (au moins celles d'origine CLIENT_QR, et si simple, toutes celles de la table) : **En validation → En préparation → Prête → Servie** (et « Refusée » avec le message existant).
- Affichage en étapes visuelles simples (pastilles/jauge), libellés en français courant. Rafraîchissement par polling léger (toutes les 10 s) — pas de WebSocket côté client pour rester compatible avec le port restreint (§ RESEAU.md).
- Le token QR ne permet de voir QUE les commandes de SA table. Test obligatoire.

---

## Point 2 — Sonnerie serveur quand sa commande est prête

- Quand le KDS passe une commande à PRET : notification **sonore + visuelle** sur la tablette du serveur rattaché à cette commande (`serveur_id`) : « Table X — commande prête ». Son distinct de celui des commandes client à valider.
- La notification reste affichée jusqu'à ce que le serveur marque la commande **« Servie »** (nouveau bouton sur sa tablette ; passe le statut à SERVIE — statut déjà présent dans l'enum).
- Si le serveur concerné est déconnecté : la notification bascule à la caisse (même règle de repli que le Point 1b).
- Les commandes prises à la caisse (sans serveur) notifient la caisse.

---

## Point 3 — Propriété de table : un serveur ne peut pas entrer dans la table d'un autre

Règle : **la table appartient au serveur qui l'a ouverte.** Exemple de référence : Awa ouvre « Terrasse 1 » → Fatou ne peut PAS y accéder. Seuls Awa, la caissière (CAISSIER) et le MANAGER/PROPRIETAIRE ont accès.

À faire :
- Ajouter `ouverte_par UUID REFERENCES utilisateurs(id)` sur `tables_salle` (migration). Renseigné à l'ouverture de la table (première commande), remis à NULL quand la table repasse LIBRE.
- Application CÔTÉ SERVEUR (pas seulement UI) : toute action sur la commande d'une table (voir détail, ajouter des articles, envoyer en cuisine, marquer servie, demander l'addition) est refusée (403) si l'utilisateur est un SERVEUR différent de `ouverte_par`. Message : « Table ouverte par Awa ». Les rôles CAISSIER, MANAGER, PROPRIETAIRE ont toujours accès.
- Sur le plan de salle des serveurs : les tables des autres apparaissent avec le prénom du propriétaire et ne s'ouvrent pas (toast explicatif). Pas de bouton grisé mystérieux : afficher « Table de Awa ».
- Transfert de table : seul CAISSIER/MANAGER peut réaffecter une table à un autre serveur (bouton « Transférer » côté caisse ; écrit une ligne d'audit `TRANSFERT_TABLE`). Cas réel : Awa termine son service.
- Le routage des appels/commandes client (Point 1b) utilise ce `ouverte_par` comme serveur prioritaire. Si la table n'a pas encore de propriétaire (client scanne le QR d'une table LIBRE) : router vers les serveurs connectés de la zone ; le premier qui prend la commande devient propriétaire de la table.

---

## Point 4 — Statut de table complet et synchronisé partout

Le statut affiché d'une table doit refléter tout le cycle de vie, en temps réel, de façon IDENTIQUE sur : le plan de salle caisse, le plan de salle serveur, et la page client.

- Le statut affiché est DÉRIVÉ côté serveur (une seule source de calcul, exposée par l'API et poussée par WebSocket) à partir de l'état réel des commandes et appels de la table. Ne pas dupliquer cette logique dans chaque app.
- États affichés et couleurs (thème clair existant) :
  * **Libre** — gris
  * **Commande client à valider** — violet (proposition CLIENT_QR en attente)
  * **En préparation** — orange marque (commande envoyée en cuisine, pas encore prête)
  * **Prête** — vert clignotant discret (au moins une commande PRETE non servie)
  * **Servie / en cours de repas** — bleu clair
  * **Appel serveur** — badge cloche sur la table, prioritaire visuellement
  * **Facture demandée / addition demandée** — bleu foncé + badge « Note », jusqu'à l'encaissement (règle CORRECTIONS2 Point 2 conservée : la note imprimée ne libère pas la table)
- Si plusieurs états coexistent (ex. en préparation + appel serveur), la table montre la couleur de l'état principal + les badges des autres. Priorité des badges : Appel > Facture > Prête.
- L'encaissement final remet la table à Libre et efface appels/badges résiduels (les appels non traités passent TRAITE avec `traite_par` = caissier).

---

## Définition de « terminé »

1. Depuis le téléphone client : « Appeler le serveur » fait sonner la tablette du bon serveur ; « Demander la facture » aussi, et le serveur déclenche l'impression de la note à la caisse.
2. Test de repli : déconnecter tous les serveurs → un appel et une commande client arrivent à la CAISSE avec bip. Un test API prouve qu'en AUCUN cas une commande client n'atteint la cuisine sans validation (serveur OU caisse).
3. Le client voit sa commande passer En validation → En préparation → Prête → Servie sans recharger la page.
4. KDS marque Prête → la tablette du serveur propriétaire sonne → bouton « Servie » → la notification disparaît et la table passe bleu clair partout.
5. Test de propriété : Awa ouvre Terrasse 1 → une requête API de Fatou sur cette table renvoie 403 « Table ouverte par Awa » ; la caissière, elle, y accède ; le transfert par la caisse fonctionne et s'inscrit dans l'audit.
6. Les statuts de table sont identiques au même instant sur caisse, tablette et téléphone client (une seule logique de calcul côté serveur).
7. Tous les tests existants passent, plus les nouveaux (routage avec repli, heartbeat de présence, 403 de propriété, portée du token QR limitée à sa table).
