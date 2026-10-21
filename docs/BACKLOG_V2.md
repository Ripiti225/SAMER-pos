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
  passer par réouverture manager de la commande. → Livré le 21/10/2026 : « Annuler un paiement »
  (PIN administrateur), voir la section dédiée plus bas.
- Rendu monnaie tracé en base (sprint 1 : calculé à l'écran uniquement, seul le montant dû est enregistré).
- Servir la PWA compilée directement depuis le serveur Fastify (déploiement mono-processus sur le mini-PC).

## Idées notées pendant le sprint 4
- SamerTrackly — écart global de clôture : afficher en indicateur principal
  l'**écart de réconciliation** (`rapport_z.diff`), et non l'écart de caisse
  espèces (`services_caisse.ecart`). L'écart espèces peut rester disponible
  comme détail secondaire pour le contrôle du tiroir.
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
avec le déploiement de tous les sites.

Cas concret ajouté le 2026-10-15 : la sonnerie « commande prête » du serveur.
Depuis cette date, la page joue sa propre mélodie de 15 s (+ vibration
Android) jusqu'à « Servie » ou « Arrêter », mais elle ne peut ni utiliser la
SONNERIE du téléphone, ni réveiller un téléphone écran éteint ou une app en
arrière-plan : il faudrait les notifications système (service worker + Push),
fermées en http. Le passage en HTTPS local, ou une petite app native, est le
seul chemin vers une vraie sonnerie de téléphone.

## Corriger un paiement saisi par erreur, tant que le shift est ouvert — livré le 21/10/2026
Une commande qui a reçu un paiement ne peut plus être annulée (le serveur
refuse : « Une commande ayant reçu un paiement ne peut plus être annulée »), et
la caisse n'a **aucune route pour retirer un paiement**. La réouverture manager
repasse la commande en OUVERTE mais **laisse ses paiements en place** : la note
du sprint 1 plus haut (« passer par réouverture manager ») ne suffit donc pas.

Cas concret du 2026-10-16 : une commande test (ticket 1422, SP837, 5 000 FCFA)
ouverte la veille a été encaissée dans le shift d'une caissière encore ouvert,
en 2 000 espèces, 1 000 Wave et 2 000 Orange Money, tous fictifs. Rien ne permet
de la neutraliser : la caissière aura un écart de −2 000 au comptage à l'aveugle,
le ticket Z affichera 3 000 de mobile money jamais reçus, et la seule trace
possible est l'explication d'écart.

À prévoir : **annulation d'un paiement**, réservée au shift encore OUVERT dans
lequel il a été encaissé, avec PIN manager et motif obligatoires, journalisée
(`ANNULATION_PAIEMENT`) et écrite dans `sync_outbox` dans la même transaction.
Le paiement n'est jamais supprimé : il est marqué annulé (ou contre-passé par une
ligne négative), pour que le cloud, SamerTrackly et le journal d'audit restent
cohérents. La commande redevient alors annulable par la voie normale. Une fois le
shift clôturé, plus aucune correction côté caisse : le ticket Z reste figé.

**Livré le 2026-10-21** (migration locale `0042_annulation_paiement`) :
- Bouton discret « Annuler un paiement » sous chaque ligne de « Paiements
  enregistrés » (écran Paiement, accessible aussi depuis Mes ventes pour un
  ticket déjà soldé). Modale motif + **PIN administrateur** — décision du
  propriétaire, plus stricte que le PIN manager prévu ci-dessus.
  Administrateur = rôle **PROPRIETAIRE** seul (SAMER Zreik, Admin Willy) : ni
  SUPERVISEUR, ni rôle personnalisé, ni permission cochable. Un PIN manager
  valide est refusé en le disant (« seul un administrateur… »), audité
  `ECHEC_PIN` type `PIN_ADMINISTRATEUR`.
- Route `POST /api/paiements/:id/annuler` (`paiements/annulation.ts`), refusée
  si le shift du paiement est clôturé. Le shift est verrouillé pendant
  l'annulation : la clôture ne peut pas figer un ticket Z au même instant.
- **Contre-passation**, jamais de suppression : une ligne NÉGATIVE du même mode,
  même shift, même caissier, liée par `contrepasse_de` (+ `annule_par`,
  `annulation_motif`). Toutes les sommes (théorique espèces, ticket Z, mobile
  money, monnaie rendue, rapport X, réconciliation, SamerTrackly via le rapport
  Z, tableau de bord du siège) retombent justes sans filtre ; les comptages
  (`nb`) sont nets. Le cloud reçoit un INSERT ordinaire, sans colonne nouvelle :
  aucun risque de bloquer l'outbox. Migration cloud facultative
  `20261021020000_annulation_paiement.sql` (nombre de paiements net dans
  `siege_par_mode`), non appliquée.
- La commande soldée repasse OUVERTE (table réoccupée) ; sa sélection
  implicite, si elle n'a plus aucun paiement valable, est annulée : la
  commande se repaie ou s'annule par la voie normale.
- Fidélité : un paiement en POINTS rend ses points ; une vente soldée qui avait
  crédité des points les reprend (lignes `points_fidelite` source
  `ANNULATION_PAIEMENT`) et les regagne si elle est payée à nouveau.
- Audit `ANNULATION_PAIEMENT` (au nom de l'administrateur, motif, mode,
  contre-passation, caissier demandeur) et outbox dans la même transaction.
