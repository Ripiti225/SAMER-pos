# Installation du POS depuis les sources (Windows)

Guide pour installer le POS **Chez Samer / Al Kayan** à partir du dépôt, sur un
poste de **développement ou de préparation de la clé master**. Le POS = un
**serveur local** (Node + PostgreSQL) + des **caisses en navigateur** (PWA) sur le
réseau local.

> ⚠️ **Pour installer un restaurant, ce n'est PAS ce document.** Un PC-serveur de
> restaurant reçoit le **dossier portable** (Node + PostgreSQL embarqués,
> `PosSamer.exe`) : rien à installer, pas d'internet requis. Procédure complète :
> **`../../README-DEPLOIEMENT.md`** (partie B, étapes B1→B8).
> Ce guide-ci sert à monter l'environnement qui **fabrique** ce dossier portable.

---

## 1. Ce dont on a besoin (à installer une fois)

| Logiciel | Version | Où | Rôle |
|---|---|---|---|
| **Node.js** | 22 LTS (ou +) | https://nodejs.org | Moteur du serveur + outils |
| **pnpm** | 11.9.0 | via corepack (voir §2) | Gestionnaire de paquets du monorepo |
| **PostgreSQL** | 16 | https://www.postgresql.org/download/windows/ | Base de données locale |
| **Git** *(optionnel)* | récente | https://git-scm.com | Récupérer / mettre à jour le code |
| **Navigateur** | Chrome ou Edge | déjà présent | Ouvrir la caisse (PWA) |

À l'installation de **PostgreSQL** : retenir le **mot de passe** du compte
`postgres` et garder le **port 5432** (par défaut). Pas besoin de créer la base à
la main : le POS la crée tout seul.

Pour **packager `PosSamer.exe`** (electron-builder), activer en plus le
**Mode développeur Windows** : Paramètres → Confidentialité et sécurité → Pour les
développeurs → Mode développeur (nécessaire pour créer des liens symboliques sans
droits admin).

Optionnels (plus tard) :
- **cloudflared** — QR clients joignables en 4G (voir `TUNNEL_CLOUDFLARE.md`).
- **Pilote de l'imprimante thermique** — voir §6.

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

> `corepack prepare` **télécharge** pnpm dans le cache du profil utilisateur
> (`%LOCALAPPDATA%\node\corepack`) — donc internet requis, et pnpm n'est **pas**
> transportable dans le dossier portable. C'est pourquoi les postes déployés
> n'utilisent jamais pnpm (ils appellent `node` + `tsx` directement).

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

Créer **`apps\server\.env`** à partir de **`apps\server\.env.example`** et y mettre
le mot de passe PostgreSQL choisi à l'installation :

```
DATABASE_URL=postgres://postgres:MON_MOT_DE_PASSE@localhost:5432/pos_samer
ADMIN_DATABASE_URL=postgres://postgres:MON_MOT_DE_PASSE@localhost:5432/postgres
PORT=3001

# Synchro équipe SamerTrackly (nécessaire pour la liste des restaurants) :
SAMTRACKLY_URL=https://wlwotzxnzowbkbfcpnyi.supabase.co
SAMTRACKLY_KEY=la_cle_service_role
```

`.env.example` documente les autres variables (synchro cloud `SUPABASE_SYNC_URL` /
`CLE_SITE`, intervalles). La **synchro cloud est inactive** tant que
`SUPABASE_SYNC_URL` et `CLE_SITE` sont vides — c'est le cas en prod aujourd'hui ;
seule la descente équipe SamerTrackly tourne.

> ⚠️ Écrire ce fichier en **UTF-8 sans BOM** : `Set-Content -Encoding UTF8`
> (PowerShell 5.1) ajoute un BOM qui corrompt le nom de la première variable lue
> par Node. Passer par un éditeur de texte ou `[System.IO.File]::WriteAllLines`.
>
> `.env` n'est jamais partagé ni committé (il contient des mots de passe/clés).

---

## 5. Installer, créer la base, lancer

Dans PowerShell, à la racine `pos-samer` :

```powershell
pnpm install          # installe les dépendances (quelques minutes la 1re fois)
pnpm db:migrate       # crée la base pos_samer + les tables automatiquement
pnpm db:seed          # données de départ (catalogue, salle, comptes de démo)
pnpm dev              # démarre le serveur + les 4 apps
```

Le serveur **n'auto-migre pas** au démarrage : après un `git pull` qui ajoute une
migration, relancer `pnpm db:migrate`.

Laisser cette fenêtre **ouverte** (elle fait tourner le POS). Puis dans le
navigateur :

| App | Adresse |
|---|---|
| **Caisse** | http://localhost:5173 |
| KDS cuisine | http://localhost:5174 |
| Tablette serveur | http://localhost:5175 |
| Menu client | http://localhost:5176 |
| API (serveur) | http://localhost:3001 |

Connexion caisse : **SAMER Zreik PIN 852741** ou **Admin Willy PIN 2212** (les
deux sont propriétaires ; ce sont les seuls comptes de l'image).

> Le seed est **volontairement neutre** : restaurant `A_CONFIGURER`, aucune équipe
> réelle, aucun `samtrackly_restaurant_id`. La même image part sur les 7 sites et
> chaque poste prend son identité via Réglages → Restaurant. Pour retrouver
> l'équipe du 7E en dev : `SEED_EQUIPE_7E=1 pnpm db:seed`.

---

## 6. Imprimante thermique (Windows)

L'impression Windows est **opérationnelle** : envoi **RAW via le spooler**, par
**nom d'imprimante** (P/Invoke `winspool`) — **aucun partage Windows requis**.
Un chemin UNC `\\host\partage` reste accepté en secours.

1. Installer le pilote de l'imprimante thermique (USB ou réseau).
2. Dans le POS : Réglages → **Imprimantes** → affecter une imprimante à chacun des
   3 postes **Caisse / Cuisine / Bar**, puis **Test** sur chacun.
   Paramètres correspondants : `imprimante_poste_caisse` / `_cuisine` / `_bar`
   (la Caisse retombe sur l'ancienne clé `imprimante_thermique_queue`).
3. Vérifier le **routage des catégories** (Cuisine / Bar / Caisse) : un routage
   par défaut est appliqué au seed et à l'import catalogue local.

Reçu, facture et rapport Z partent sur la Caisse ; les bons de préparation sont
groupés par poste à l'envoi cuisine. Sans imprimante configurée, tout marche à
l'écran (le ticket retombe en console).

---

## 7. Réseau local (autres terminaux, téléphones)

1. Trouver l'IP du PC : `ipconfig` (ex. `192.168.1.20`).
2. **Pare-feu Windows** (Entrant → Autoriser) : `3001` (API + caisse servie en
   statique) et `5174`–`5176` (KDS, serveur, client). Le `5173` n'existe qu'en
   mode dev (`pnpm dev`).
3. Sur l'autre appareil, ouvrir `http://192.168.1.20:3001` (même WiFi).
4. Raccordement rapide des tablettes : bouton **« Appareils »** dans le header de
   l'accueil caisse → un QR par plateforme ; l'employé fait ensuite son PIN.
5. QR clients : Réglages → Salle & QR, l'adresse détectée est déjà l'IP LAN —
   penser à **régénérer les QR** avant de les imprimer.

---

## 8. Tests

```powershell
pnpm --filter @pos/server test        # base dédiée pos_samer_test
```

La config de test code en dur `postgres://localhost:5432/pos_samer_test` **sans
utilisateur** : libpq utilise alors le nom de session Windows comme rôle. Sur une
instance qui n'a que `postgres`, créer une fois le rôle correspondant
(`CREATE ROLE "PC" SUPERUSER LOGIN;` — à passer via un fichier `.sql`, l'échappement
des guillemets casse en PowerShell). Cela n'affecte pas l'app, qui se connecte en
`postgres@` via `.env`.

---

## 9. Passer en production (dossier portable)

`pnpm dev` est un mode **développement**. Le déploiement réel se fait via le
**dossier portable** décrit dans `../../README-DEPLOIEMENT.md` :

- `preparer-app.ps1` assemble tout (deps, base, migrations, seed, build caisse) et
  produit **`PosSamer.exe`** (Electron plein écran kiosque) ;
- la caisse est alors servie **en statique** par Fastify depuis
  `apps\caisse\dist` — après toute modif de la caisse :
  **`pnpm --filter caisse build`**, sinon le kiosque affiche l'ancien build ;
- une modif du shell Electron (`apps\desktop\main.js`, preload) impose un
  repackaging : `pnpm --filter @pos/desktop build`, puis copier
  `apps\desktop\release\PosSamer.exe` à la racine du dossier portable ;
- une modif du **serveur** seul ne demande ni build ni repackaging : relancer
  l'exe suffit (tsx, sans watch) ;
- démarrage automatique à l'ouverture de session : `installer-demarrage-auto.ps1` ;
- **IP fixe** (réservation DHCP) pour que les QR imprimés restent valables.

---

## Récapitulatif express (poste de dev)

```powershell
# 1) Installer : Node 22, PostgreSQL 16 (retenir le mot de passe postgres)
corepack enable; corepack prepare pnpm@11.9.0 --activate
# 2) Code + .env (copié de .env.example, DATABASE_URL avec le mot de passe)
cd pos-samer
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
# 3) Ouvrir http://localhost:5173  (SAMER Zreik PIN 852741 / Admin Willy PIN 2212)
```
