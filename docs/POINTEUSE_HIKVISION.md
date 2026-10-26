# Pointeuse Hikvision DS-K1T320EFWX — mise en service sur un site

Depuis le 2026-10-26, les présences du POS viennent de la pointeuse : l'employé
choisit **Entrée** ou **Sortie** puis présente son visage. Le serveur POS du site
lit l'appareil toutes les 20 secondes sur le réseau local. La pointeuse garde
ses pointages en mémoire : une coupure du POS ou du Wi-Fi ne perd rien, tout
est relu au retour.

## Règles de présence (décidées par le propriétaire)

| Situation | Ce que fait le POS |
|---|---|
| Entrée pointée avant l'ouverture du shift | L'employé entre dans l'équipe à l'ouverture, **avec son heure réelle** de pointage |
| Entrée pendant le shift | Ajouté à l'équipe à l'heure du pointage |
| Sortie pointée | Marqué « parti » à cette heure, son compteur s'arrête |
| Sortie puis Entrée dans le même shift | L'absence est **déduite** des heures |
| Pas de sortie pointée à « J'ai fini » | La caisse demande **« Il reste ou il part ? »**, un employé à la fois |
| Visage non reconnu / pointeuse en panne | Accueil › bandeau Équipe › **Pointage de secours** : **PIN manager + motif**, tracé dans le journal |

À l'ouverture, le caissier ne coche plus l'équipe : il voit qui a pointé et
ajuste seulement le poste du jour.

## 1. Sur la pointeuse (une fois)

1. **Activer** l'appareil au premier allumage : choisir le mot de passe `admin`
   et le noter (il sera saisi dans le POS).
2. **Réseau** : relier la pointeuse au **même réseau** que le PC serveur du POS
   (Wi-Fi du restaurant ou câble). Lui donner une **adresse IP fixe** (dans la
   pointeuse, ou par une réservation DHCP sur la box). Noter l'adresse.
3. **Heure** : régler la date et l'heure exactes, fuseau **GMT+0** (Abidjan),
   NTP activé si internet est disponible. *L'heure de la pointeuse fait foi
   pour la paie.* ⚠ Réglage d'usine constaté le 2026-10-26 : fuseau **CST-8
   (Chine)**, heure manuelle, 10 min de retard. À corriger systématiquement.
4. **Présence (T&A)** : activer le statut de présence en mode **Manuel** (ou
   « Manuel et auto ») pour que l'employé choisisse Entrée / Sortie avant de
   présenter son visage. Désactivé en usine : sans lui, le POS déduit le sens
   (présent → Sortie, absent → Entrée) et ne compte qu'un passage par 2 min.
5. Si l'interface web de la pointeuse propose *Configuration › Réseau ›
   Protocole d'intégration › ISAPI*, vérifier qu'il est **activé**.

## 2. Dans le POS — Réglages › Équipe & accès › Pointeuse

1. Saisir **l'adresse IP**, l'utilisateur (`admin`) et le mot de passe, puis
   **Enregistrer et tester**. Le badge passe à « Connectée » et affiche le
   modèle et le n° de série.
2. Cliquer **Envoyer l'équipe à la pointeuse** : chaque employé actif reçoit
   un numéro, et sa fiche (n° + nom) est créée sur l'appareil.
3. Sur la pointeuse : **Utilisateur › (nom) › Visage**, enrôler chaque
   employé.
4. Faire un essai : Entrée sur la pointeuse, puis **Lire maintenant** ; le
   pointage apparaît dans « Derniers pointages » et dans le bandeau Équipe.

Employés déjà enregistrés à la main sur la pointeuse : reporter leur
« N° employé » dans la liste du POS. Un numéro pointé mais inconnu du POS est
signalé en orange ; dès qu'on le renseigne, ses pointages des 16 dernières
heures sont récupérés.

Retirer la pointeuse (vider l'adresse et enregistrer) ramène l'ancien
fonctionnement : équipe cochée à l'ouverture, pointage libre à la caisse.

## Dépannage

- **« Injoignable »** : pointeuse éteinte, sur un autre réseau, ou IP changée.
  Depuis le PC serveur, ouvrir `http://<IP>` dans le navigateur : la page de
  connexion Hikvision doit s'afficher.
- **« Identifiant ou mot de passe incorrect »** : ressaisir le mot de passe
  `admin` de la pointeuse. Après plusieurs échecs, l'appareil se verrouille
  quelques minutes.
- **Heures décalées** : vérifier l'heure et le fuseau de la pointeuse (étape 1.3).
- Réglage par fichier possible sur un poste : `POINTEUSE_URL`,
  `POINTEUSE_UTILISATEUR`, `POINTEUSE_MOT_DE_PASSE` dans `apps/server/.env`
  (prioritaire sur l'écran).

## Technique

- Lecture : `POST /ISAPI/AccessControl/AcsEvent` (authentification Digest),
  module `apps/server/src/modules/pointeuse/`.
- Journal brut : table `pointeuse_evenements` (un pointage = une ligne, jamais
  en double). Statuts : `APPLIQUE`, `EN_ATTENTE`, `INCONNU`, `IGNORE`.
- Un shift déjà clôturé n'est jamais modifié par un pointage lu en retard.
- Migration locale `0044_pointeuse.sql` ; rien de nouveau ne monte au cloud.
