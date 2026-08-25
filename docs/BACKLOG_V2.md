# BACKLOG V2 — idées et éléments hors périmètre du sprint 1

Toute idée hors périmètre du sprint 1 est notée ici, jamais implémentée en douce.

## Reporté (prévu au cahier des charges, sprints 2-3)
- Synchronisation cloud (le `sync_outbox` est déjà alimenté en sprint 1, le moteur de lecture arrive en sprint 3).
- KDS cuisine (écrans CUISINIER / PIZZAIOLO / COMPTOIRISTE).
- App serveur sur tablette (prise de commande en salle).
- Notation client par QR code sur table.
- Pointage du personnel (géofencing / SMS / PIN).
- Programme de fidélité (identifiant client partagé avec SAMER DELIV).
- Impression ESC/POS réelle (sprint 1 : interface `PrinterService` + `ConsolePrinter` uniquement).
- Plan de salle graphique (sprint 1 : simple liste de tables).

## Idées notées pendant le sprint 2
- KDS : gestion par article individuel (marquer un seul plat prêt) — v1 = la carte entière change d'état (§A2).
- KDS : filtrage des cartes par poste (PIZZAIOLO ne voit que les pizzas) — nécessite un mapping catégorie → poste.
- App serveur : notification sur la tablette quand une commande passe PRETE (« plats à récupérer »).
- App serveur : transfert d'une commande d'une table à une autre (client qui change de table).
- Paiement d'une commande encore en cuisine : aujourd'hui autorisé (fast-food) — la carte disparaît alors du KDS avant d'être prête ; à arbitrer avec le patron.
- File anti-coupure : purge/inspection des actions en erreur définitive depuis un écran manager.

## Idées notées pendant le sprint 1
- Verrouillage progressif du PIN manager utilisé pour les actions protégées (remise, annulation) :
  en sprint 1 chaque échec est audité (`ECHEC_PIN`) mais sans compteur de verrouillage,
  car le PIN saisi n'est pas rattaché à un compte précis avant vérification.
- Annulation partielle d'un paiement déjà enregistré (erreur de saisie du mode) : en sprint 1,
  passer par réouverture manager de la commande.
- Rendu monnaie tracé en base (sprint 1 : calculé à l'écran uniquement, seul le montant dû est enregistré).
- Servir la PWA compilée directement depuis le serveur Fastify (déploiement mono-processus sur le mini-PC).

## Idées notées pendant le sprint 4
- Fidélité — rapprochement cloud (fusions_clients) : la fusion des clients POS
  et SAMER DELIV sur le même téléphone se fait côté cloud (Edge Function à la
  montée) et redescend une table `fusions_clients(ancien_id, id_retenu)`
  appliquée à la descente. Reporté à l'intégration SAMER DELIV (nécessite le
  projet cloud SAMER DELIV comme référence des clients). En attendant, le POS
  génère des id clients locaux qui remontent au cloud ; l'unicité par téléphone
  y sera réconciliée lors de ce jalon.
- Notation client (QR) : la prise de note par le client reste sprint 5+ ; le
  récap manager (moyennes, dernières mauvaises notes) lit les `notations`
  existantes.
- Horaires prévus des employés (retards vs planning) : champ texte simple en
  v2, planning complet reporté.

## Parcours client au QR — livré le 24/08/2026 (briques 1 et 2)
Demande du patron : le client qui scanne le QR de sa table s'identifie par
téléphone et repart avec un reçu PDF + ses points. Deux briques sur trois sont
implémentées et testées (`apps/server/test/client-qr-fidelite-recu.test.ts`) :

- **Téléphone facultatif à la commande** — `CommandeClientSchema.telephone`
  (vide = absent), rattachement `trouverOuCreer()` + `client_fidelite_id` dans
  la transaction de création. Le libellé du bouton passe à « Commander sans
  points » quand le champ est vide : le renoncement est un choix, pas un oubli.
- **Reçu PDF client** — `GET /api/client/:qr_token/recu/:commande_id`
  (`apps/server/src/printer/recu-pdf.ts`), servi seulement pour une commande de
  la table du jeton, PAYEE, dans les 45 min. Les commandes payées restent dans
  le suivi pendant cette même fenêtre pour l'écran « Vous venez de payer… ».

**Reste à faire — points bidirectionnels POS ↔ SAMER DELIV.** Le socle est là
(id client local par téléphone, remontée `sync_outbox`, règle des 24 h de
`soldeVerifiable()`), mais la réconciliation par téléphone côté cloud manque —
voir « Fidélité — rapprochement cloud (fusions_clients) » plus haut. Tant
qu'elle n'existe pas, un client connu de l'app SAMER DELIV aura deux soldes
séparés, et l'écran de confirmation dit « ajoutés à votre compte Samer Delly »
sans que la fusion soit réellement faite. À traiter au jalon SAMER DELIV.

## HTTPS sur le réseau local des sites
Les PWA (caisse, tablette serveur, téléphone client via QR, KDS) sont servies en
`http://IP-LAN`. Le navigateur classe ces pages en **contexte non sécurisé** et
leur retire une famille d'API : `crypto.randomUUID()`, `crypto.subtle`, et plus
tard tout ce qui touche à la géolocalisation, aux notifications push ou à
l'accès caméra si un besoin apparaît (scan de code-barres à la réception, par
exemple).

Le piège s'est déjà refermé trois fois sur `crypto.randomUUID()` — la dernière
en date virait l'écran de la tablette serveur au blanc dès qu'on touchait un
produit. Il est désormais neutralisé par `uuidLocal()` (@pos/shared) et par le
garde-fou `apps/server/test/garde-contexte-non-securise.test.ts`, mais cela
traite les symptômes un à un, pas la cause.

Servir les PWA en HTTPS (certificat local, nom de domaine interne du site)
supprimerait la classe de problèmes entière et rouvrirait ces API. Chantier
d'infrastructure : génération et renouvellement du certificat, distribution de
l'autorité sur chaque terminal, adaptation du reverse-proxy local. À arbitrer
avec le déploiement des 7 sites.
