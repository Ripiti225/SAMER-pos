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

## Idées notées pendant le sprint 1
- Verrouillage progressif du PIN manager utilisé pour les actions protégées (remise, annulation) :
  en sprint 1 chaque échec est audité (`ECHEC_PIN`) mais sans compteur de verrouillage,
  car le PIN saisi n'est pas rattaché à un compte précis avant vérification.
- Annulation partielle d'un paiement déjà enregistré (erreur de saisie du mode) : en sprint 1,
  passer par réouverture manager de la commande.
- Rendu monnaie tracé en base (sprint 1 : calculé à l'écran uniquement, seul le montant dû est enregistré).
- Servir la PWA compilée directement depuis le serveur Fastify (déploiement mono-processus sur le mini-PC).
