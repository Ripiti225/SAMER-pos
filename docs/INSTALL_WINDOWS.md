# Installation du POS sur un ordinateur Windows

Guide pour installer et lancer le POS **Chez Samer / Al Kayan** sur le mini-PC
Windows d'un restaurant. Le POS = un **serveur local** (Node + PostgreSQL) + des
**caisses en navigateur** (PWA) sur le réseau local.

---

## 1. Ce dont on a besoin (à installer une fois)

| Logiciel | Version | Où | Rôle |
|---|---|---|---|
| **Node.js** | 22 LTS (ou +) | https://nodejs.org | Moteur du serveur + outils |
| **pnpm** | 11.x | via Node (voir §2) | Gestionnaire de paquets du projet |
| **PostgreSQL** | 16 | https://www.postgresql.org/download/windows/ | Base de données locale |
| **Git** *(optionnel)* | récente | https://git-scm.com | Récupérer / mettre à jour le code |
| **Navigateur** | Chrome ou Edge | déjà présent | Ouvrir la caisse (PWA) |

À l'installation de **PostgreSQL** : retenir le **mot de passe** du compte
`postgres` et garder le **port 5432** (par défaut). Pas besoin de configurer la
base à la main : le POS la crée tout seul.

Optionnels (plus tard) :
- **cloudflared** — QR clients joignables en 4G (voir `docs/TUNNEL_CLOUDFLARE.md`).
- **Pilote de l'imprimante thermique** — voir §6 (⚠️ adaptation nécessaire sur Windows).

---

## 2. Préparer Node + pnpm

1. Installer **Node.js 22 LTS** (installeur `.msi`, cocher « Add to PATH »).
2. Ouvrir **PowerShell** et activer pnpm :
   ```powershell
   corepack enable
   corepack prepare pnpm@11.9.0 --activate
   ```
   Vérifier :
   ```powershell
   node -v      # v22.x (ou +)
   pnpm -v      # 11.9.0
   ```

---

## 3. Récupérer le code

- Avec Git :
  ```powershell
  git clone <URL_DU_DEPOT> pos-samer
  cd pos-samer
  ```
- Ou copier le dossier `pos-samer` sur le PC, puis `cd pos-samer` dans PowerShell.

---

## 4. Configurer la connexion à la base (fichier `.env`)

Créer le fichier **`apps\server\.env`** (copier depuis `.env.example`) et y mettre
le mot de passe PostgreSQL choisi à l'installation :

```
DATABASE_URL=postgres://postgres:MON_MOT_DE_PASSE@localhost:5432/pos_samer
ADMIN_DATABASE_URL=postgres://postgres:MON_MOT_DE_PASSE@localhost:5432/postgres
PORT=3001

# Synchro équipe SamerTrackly (facultatif) :
SAMTRACKLY_URL=https://wlwotzxnzowbkbfcpnyi.supabase.co
SAMTRACKLY_KEY=la_cle_service_role
```

> `.env` n'est jamais partagé ni committé (il contient des mots de passe/clés).

---

## 5. Installer, créer la base, lancer

Dans PowerShell, à la racine `pos-samer` :

```powershell
pnpm install          # installe les dépendances (quelques minutes la 1re fois)
pnpm db:migrate       # crée la base pos_samer + les tables automatiquement
pnpm db:seed          # données de départ (restaurant, catalogue, équipe 7E)
pnpm dev              # démarre le serveur + les 4 apps
```

Laisser cette fenêtre **ouverte** (elle fait tourner le POS). Puis dans le navigateur :

| App | Adresse |
|---|---|
| **Caisse** | http://localhost:5173 |
| KDS cuisine | http://localhost:5174 |
| Tablette serveur | http://localhost:5175 |
| Menu client | http://localhost:5176 |
| API (serveur) | http://localhost:3001 |

Connexion caisse : **Propriétaire PIN 852741** ; équipe 7E : PIN 240101 → 240113.

---

## 6. ⚠️ Imprimante thermique — adaptation Windows nécessaire

Le code d'impression actuel envoie le ticket via **`lp -d <file> -o raw`**, une
commande **CUPS (macOS/Linux)** qui **n'existe pas sur Windows**. Tant que ce
n'est pas adapté, l'impression retombe sur la « console » (pas de ticket papier).

Pour imprimer sur Windows, il faudra brancher l'une de ces approches (petit
travail de dev à prévoir — je peux le faire) :
- imprimer en **RAW** vers l'imprimante partagée (`\\localhost\NomImprimante`),
- ou utiliser un module Node d'impression Windows (ex. `@thiagoelg/node-printer`),
- ou piloter l'imprimante USB en direct (ESC/POS USB).

Le reste (facture à l'écran, calculs, tickets Z…) fonctionne sans imprimante.

---

## 7. Réseau local (autres terminaux, téléphones)

Pour qu'une **autre tablette/PC** ou un **téléphone** accède à la caisse :

1. Trouver l'IP du mini-PC : `ipconfig` (ex. `192.168.1.20`).
2. **Autoriser les ports** dans le Pare-feu Windows (Entrant → Autoriser) :
   `3001` (API) et `5173`–`5176` (apps).
3. Sur l'autre appareil, ouvrir `http://192.168.1.20:5173` (même WiFi).
4. QR clients : dans Réglages → Salle & QR, l'adresse détectée est déjà l'IP LAN.

---

## 8. Pour la production (démarrage automatique)

`pnpm dev` lance des serveurs de **développement**. Pour un vrai déploiement sur
le mini-PC, prévoir :
- lancer le POS **au démarrage de Windows** (Planificateur de tâches, ou installer
  le serveur comme **service Windows** via *NSSM*),
- servir les apps **compilées** (`pnpm build`) plutôt que le mode dev,
- une **IP fixe** (réservation DHCP sur la box) pour que les QR imprimés restent
  valables.

Je peux préparer cette configuration « production » (build + démarrage auto +
impression Windows) quand tu voudras.

---

## Récapitulatif express

```powershell
# 1) Installer : Node 22, PostgreSQL 16 (retenir le mot de passe postgres)
corepack enable; corepack prepare pnpm@11.9.0 --activate
# 2) Code + .env (DATABASE_URL avec le mot de passe)
cd pos-samer
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
# 3) Ouvrir http://localhost:5173
```
