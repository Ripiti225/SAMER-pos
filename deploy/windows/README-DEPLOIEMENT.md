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
├── demarrer-pos.bat     <- lancement manuel (dépannage)
├── arreter-pos.bat      <- arrêt manuel (dépannage)
├── preparer-app.bat              <- DOUBLE-CLIQUER (fabrique PosSamer.exe)
├── preparer-app.ps1              <- appelé par le .bat, pas à lancer seul
├── installer-demarrage-auto.bat  <- DOUBLE-CLIQUER (démarrage auto + raccourci)
├── installer-demarrage-auto.ps1  <- appelé par le .bat, pas à lancer seul
└── PosSamer.exe         <- généré par preparer-app.ps1 (voir 4) : app desktop plein écran
```

1. **Node.js portable** : télécharger le ZIP *Windows x64* sur
   https://nodejs.org/en/download (« Windows Binary .zip », Node 22 LTS),
   dézipper dans `POS-Samer\runtime\node\` (on doit y trouver `node.exe`).
2. **PostgreSQL portable** : télécharger les *binaries ZIP* (pas l'installeur) sur
   https://www.enterprisedb.com/download-postgresql-binaries (PostgreSQL 16),
   dézipper dans `POS-Samer\runtime\pgsql\` (on doit y trouver `bin\pg_ctl.exe`).
3. **Le code** : copier le dépôt `pos-samer` dans `POS-Samer\app\`
   (ou `git clone` dedans).
4. **Assembler** : copier **tous** les scripts de ce dossier à la racine
   `POS-Samer\` (les `.bat` et les `.ps1` : chaque `.bat` appelle son `.ps1`
   voisin), puis **double-cliquer `preparer-app.bat`**.
   Il installe les dépendances, crée la base, charge les données, build la
   caisse et produit `POS-Samer\PosSamer.exe` (l'application desktop).
5. **Clé SamerTrackly** : ouvrir `POS-Samer\app\apps\server\.env` et coller la
   clé dans `SAMTRACKLY_KEY=` (pour la synchro équipe / la liste des restaurants).

La clé master est prête : copier tout le dossier `POS-Samer\` sur une clé USB.

> ⚠️ **Ne jamais refabriquer la clé USB à partir d'un PC en service.** Le dossier
> contient `data\pgdata`, donc **toute la base** du restaurant : commandes,
> tickets, services, journal d'audit. Le nouveau site démarrerait avec
> l'historique de l'ancien. On repart toujours d'un master fraîchement préparé
> (partie A) — c'est-à-dire d'une base neutre, sans identité ni équipe.

---

## PARTIE B — Déployer sur chaque PC-serveur

Sur chaque PC (aucune installation, aucun internet requis) :

1. **Copier** le dossier `POS-Samer\` de la clé vers le PC (ex. `C:\POS-Samer`).
2. Double-clic sur **`PosSamer.exe`** → la base et le serveur démarrent tout
   seuls, puis la caisse s'affiche en plein écran (aucune bordure, aucune
   barre d'adresse). Quitter avec le raccourci **Ctrl+Alt+Q** (utile pour la
   maintenance : le mode plein écran bloque parfois Alt+F4).
3. **Mettre la base à jour — À FAIRE SI LA CLÉ EST ANTÉRIEURE AU 10/09/2026.**
   Le dossier copié embarque une base toute faite : si elle est plus ancienne que
   le code, **la caisse s'ouvre sur un menu VIDE**, sans le moindre message
   d'erreur. Le 10/09, deux migrations manquaient à la clé et tous les postes
   neufs sont sortis sans catalogue. Ouvrir PowerShell **à la racine du dossier
   copié** (celui qui contient `runtime`, `app`, `data`), `PosSamer.exe` lancé,
   et coller cette ligne :

   ```powershell
   $env:Path = "$PWD\runtime\node;$env:Path"; cd app\apps\server; node "..\..\node_modules\tsx\dist\cli.mjs" "src\db\migrate.ts"
   ```

   Réponse attendue : `Migrations appliquées ✔`. Puis **Ctrl+Alt+Q** et relancer
   `PosSamer.exe`. C'est sans risque et **rejouable** : une base déjà à jour ne
   change pas. Dans le doute, la lancer.

   > Un menu vide vient presque toujours de là. Pour en avoir le cœur net :
   > `.\runtime\pgsql\bin\psql.exe -U postgres -d pos_samer -c "SELECT count(*) FROM drizzle.__drizzle_migrations"`
   > doit donner **33**.

4. Se connecter en **SAMER Zreik (PIN 852741)** ou **Admin Willy (PIN 2212)** — les deux comptes propriétaire de l'image.
5. **Configurer ce restaurant — ÉTAPE OBLIGATOIRE, AVANT TOUTE VENTE** :
   Réglages → **Restaurant** → choisir le bon restaurant dans la liste →
   **Configurer**. L'identité (nom, marque, couleur), l'**identifiant de site**
   et l'équipe se mettent en place automatiquement.
   Tant qu'elle n'est pas faite, la caisse affiche « **Restaurant à
   configurer** », aucune équipe ne descend de SamerTrackly et l'enrôlement
   cloud (`pnpm site:enroler`) est refusé : c'est voulu. Toutes les copies
   sortent de la même image, c'est cette étape qui rend le poste unique et
   empêche deux restaurants de partager leurs données.
   Si un jour on **réaffecte un poste** à un autre restaurant, refaire cette
   étape : le poste reçoit un identifiant neuf et il faut **ré-enrôler** le site
   côté cloud (l'ancienne clé est effacée exprès).
6. **Régénérer les QR avant de les imprimer** (sécurité) : Réglages → **Salle & QR**
   → **« Régénérer tous les QR »**. On obtient des jetons **frais et aléatoires**
   (non devinables), puis on **imprime** les QR à poser sur les tables. À refaire
   si un jour on soupçonne qu'un QR a fuité.
7. **Démarrage automatique** (recommandé) : **double-cliquer
   `installer-demarrage-auto.bat`**, puis valider la fenêtre Windows qui demande
   les droits administrateur → `PosSamer.exe` se lancera tout seul à chaque
   ouverture de session, et un raccourci est ajouté sur le Bureau.

> **Pourquoi des `.bat` et pas les `.ps1` directement ?** Trois obstacles se
> cumulent sur un Windows par défaut, et aucun ne donne de message clair :
> la stratégie d'exécution est *Restricted*, donc tout `.ps1` est refusé ;
> l'entrée « Exécuter avec PowerShell » du clic droit **n'existe pas sur toutes
> les machines** (là où elle manque, le `.ps1` s'ouvre dans le Bloc-notes et il
> ne se passe rien) ; et l'installation du démarrage auto exige une élévation
> que ce menu ne demande pas. Chaque `.bat` traite les trois. **Ne pas toucher
> à `Set-ExecutionPolicy`** : ce serait desserrer un réglage de sécurité de tout
> le poste, alors que le `-ExecutionPolicy Bypass` des `.bat` ne vaut que pour
> leur propre processus.

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
- **Pare-feu Windows** : autoriser les ports `3001` (API + caisse) et `5174`–`5176`
  (KDS, serveur, client). Le `5173` n'est utile qu'en mode dépannage
  (`demarrer-pos.bat`, voir tableau ci-dessous).
- Autres caisses / téléphones (même WiFi) :
  - Caisse (si un 2e poste caisse est nécessaire) : `http://IP-du-serveur:3001`
  - KDS (cuisine) : `http://IP-du-serveur:5174`
  - Serveur (tablette) : `http://IP-du-serveur:5175`
  - Client (QR table) : `http://IP-du-serveur:5176`

---

## Dépannage rapide

| Symptôme | Piste |
|---|---|
| « pg_ctl n'est pas reconnu » | `runtime\pgsql\bin` mal placé (chemin) |
| « pnpm n'est pas reconnu » | relancer `preparer-app.bat` (corepack) |
| Un `.ps1` s'ouvre dans le Bloc-notes, ou « l'exécution de scripts est désactivée » | normal : lancer le `.bat` du même nom, jamais le `.ps1` (voir encadré ci-dessous) |
| La caisse ne s'ouvre pas | attendre 10-20 s au 1er lancement ; rafraîchir |
| Liste des restaurants vide | `SAMTRACKLY_KEY` manquante dans `.env` + internet |
| Pas d'impression | imprimante partagée ? nom de partage == paramètre ? |
| Besoin de dépanner sans le plein écran kiosque | utiliser `demarrer-pos.bat` / `arreter-pos.bat` (mode terminal, conservés pour la maintenance) au lieu de `PosSamer.exe` |

> Ces scripts sont à **roder sur une vraie machine Windows** : au premier essai,
> garde les fenêtres ouvertes pour lire les messages, et on ajuste ensemble.

