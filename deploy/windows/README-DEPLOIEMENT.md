# Déploiement du POS sur plusieurs PC Windows (clé USB « master »)

Objectif : préparer **une clé USB une seule fois**, puis **copier + double-clic**
sur chacun des ~9 PC — sans installeur ni internet sur place.

> Rappel archi : **un serveur POS par restaurant**. Si un restaurant a plusieurs
> caisses, **un seul PC fait le serveur** ; les autres caisses sont juste un
> navigateur pointé sur `http://IP-du-serveur:5173` (rien à installer dessus).
> Donc tu n'installes le dossier portable que sur les **PC-serveurs**.

---

## PARTIE A — Fabriquer la clé master (UNE FOIS, sur un PC Windows avec internet)

On assemble un dossier **portable** (aucune installation système) :

```
POS-Samer\
├── runtime\node\        <- Node.js portable (voir 1)
├── runtime\pgsql\bin\   <- PostgreSQL portable (voir 2)
├── data\pgdata\         <- base créée par le script (voir 4)
├── app\                 <- le dépôt pos-samer (voir 3)
├── demarrer-pos.bat
├── arreter-pos.bat
├── preparer-app.ps1
└── installer-demarrage-auto.ps1
```

1. **Node.js portable** : télécharger le ZIP *Windows x64* sur
   https://nodejs.org/en/download (« Windows Binary .zip », Node 22 LTS),
   dézipper dans `POS-Samer\runtime\node\` (on doit y trouver `node.exe`).
2. **PostgreSQL portable** : télécharger les *binaries ZIP* (pas l'installeur) sur
   https://www.enterprisedb.com/download-postgresql-binaries (PostgreSQL 16),
   dézipper dans `POS-Samer\runtime\pgsql\` (on doit y trouver `bin\pg_ctl.exe`).
3. **Le code** : copier le dépôt `pos-samer` dans `POS-Samer\app\`
   (ou `git clone` dedans).
4. **Assembler** : copier les 4 scripts de ce dossier à la racine `POS-Samer\`,
   puis clic droit sur **`preparer-app.ps1` → Exécuter avec PowerShell**.
   Il installe les dépendances, crée la base et charge les données.
5. **Clé SamerTrackly** : ouvrir `POS-Samer\app\apps\server\.env` et coller la
   clé dans `SAMTRACKLY_KEY=` (pour la synchro équipe / la liste des restaurants).

La clé master est prête : copier tout le dossier `POS-Samer\` sur une clé USB.

---

## PARTIE B — Déployer sur chaque PC-serveur

Sur chaque PC (aucune installation, aucun internet requis) :

1. **Copier** le dossier `POS-Samer\` de la clé vers le PC (ex. `C:\POS-Samer`).
2. Double-clic sur **`demarrer-pos.bat`** → la base démarre, le POS démarre, la
   caisse s'ouvre sur `http://localhost:5173`. (Laisser la fenêtre ouverte.)
3. Se connecter en **Propriétaire (PIN 852741)**.
4. **Configurer ce restaurant** : Réglages → **Restaurant** → choisir le bon
   restaurant dans la liste → **Configurer**. L'identité (nom, marque, couleur)
   et l'équipe se mettent en place automatiquement.
5. **Régénérer les QR avant de les imprimer** (sécurité) : Réglages → **Salle & QR**
   → **« Régénérer tous les QR »**. On obtient des jetons **frais et aléatoires**
   (non devinables), puis on **imprime** les QR à poser sur les tables. À refaire
   si un jour on soupçonne qu'un QR a fuité.
6. **Démarrage automatique** (recommandé) : clic droit sur
   **`installer-demarrage-auto.ps1` → Exécuter avec PowerShell** → le POS se
   lancera tout seul à chaque allumage.

Chaque installation devient **unique** grâce à l'étape 4, avec le **même**
dossier partout.

---

## PARTIE C — Imprimante thermique (Windows)

L'impression utilise `copy /b` vers une **imprimante partagée** :

1. Installer le pilote de l'imprimante thermique (USB/réseau).
2. Panneau de config → Imprimantes → clic droit → **Propriétés → Partage** →
   cocher « Partager » et donner un **nom de partage court**, ex. `POS80`.
3. Dans le POS : Réglages → Paramètres → « File d'impression » (paramètre
   `imprimante_thermique_queue`) = ce **nom de partage** (`POS80`).

Sans imprimante configurée, tout marche à l'écran (le ticket retombe en console).

---

## PARTIE D — Réseau (autres caisses, téléphones)

- **IP fixe** du PC-serveur (réservation DHCP sur la box) — sinon les QR imprimés
  et les autres caisses perdent l'adresse.
- **Pare-feu Windows** : autoriser les ports `3001` et `5173`–`5176` (Entrant).
- Autres caisses / téléphones (même WiFi) : `http://IP-du-serveur:5173`.

---

## Dépannage rapide

| Symptôme | Piste |
|---|---|
| « pg_ctl n'est pas reconnu » | `runtime\pgsql\bin` mal placé (chemin) |
| « pnpm n'est pas reconnu » | relancer `preparer-app.ps1` (corepack) |
| La caisse ne s'ouvre pas | attendre 10-20 s au 1er lancement ; rafraîchir |
| Liste des restaurants vide | `SAMTRACKLY_KEY` manquante dans `.env` + internet |
| Pas d'impression | imprimante partagée ? nom de partage == paramètre ? |

> Ces scripts sont à **roder sur une vraie machine Windows** : au premier essai,
> garde les fenêtres ouvertes pour lire les messages, et on ajuste ensemble.
