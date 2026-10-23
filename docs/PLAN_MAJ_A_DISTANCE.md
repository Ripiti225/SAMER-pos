# Plan — mise à jour à distance des postes (sans clé USB)

**Statut : plan validé par le propriétaire (23/10/2026). Lot L0 livré (voir § 6 bis), lots L3-L4 et côté caisse de L5 livrés (voir § 6 ter).**

Décisions déjà prises : mise à jour automatique des 8 sites ; téléchargement pendant
le service ; installation à une heure creuse **réglable par restaurant** (06h00 pour
Palmeraie, Al Kayan Yop, Samer Maroc, Angré 7E, À la Braise ; 05h00 pour Al Kayan KMS,
Samer Lavage, Samer Oasis) ; le shift n'a pas besoin d'être fermé (shift et sessions
en base) ; coupure de 2-3 min ; bouton « Pas maintenant » ; poste éteint → installation
au rallumage avant d'ouvrir la caisse ; « en retard » au siège après 24 h ; sauvegarde
de la base et retour arrière automatique ; paquets signés ; une dernière mise à jour
par clé USB pour installer le mécanisme.

### Règle d'installation par type de site (décidée le 21/10/2026)

| Type de site | Sites | Quand la mise à jour s'installe |
|---|---|---|
| **Ferme la nuit** | Al Kayan KMS, Samer Lavage, Samer Oasis | Téléchargée pendant le service, **installée au démarrage suivant du poste**, avant l'ouverture de la caisse. Filet de sécurité : si le poste n'a pas redémarré 24 h après la fin du téléchargement, installation à 05h00. |
| **24h/24** | Palmeraie, Al Kayan Yop, Samer Maroc, Angré 7E, À la Braise | Installée **à l'heure définie (06h00), même si le poste est en service**, shift ouvert. Coupure de 2-3 min avec « Mise à jour en cours ». |

Le type de chaque site est réglable dans la console siège.

## 1. Ce que le code impose

- Le **lanceur** (`apps/desktop/main.js`) est le parent de tout : PostgreSQL portable,
  migrations, serveur (tsx sur les sources), Vite pour KDS/serveur/client, page
  d'erreur locale. Un processus ne se remplace pas lui-même : **c'est le lanceur qui
  installe**.
- `main.js` est dans l'asar de `PosSamer.exe` : changer `apps/desktop` = refaire l'exe.
- La `cle_site` vit dans `.env` ou `parametres_locaux` : c'est le **serveur** qui parle
  au cloud (téléchargement, comptes rendus).
- La caisse est servie en statique depuis `apps/caisse/dist`.
- Drizzle n'avance que vers l'avant : le seul vrai retour arrière d'une base migrée est
  la sauvegarde.
- Le dépôt est public : la clé privée de signature ne doit jamais y entrer.
- À corriger au passage : `pg_ctl stop` sans `-w`, `serverProcess.kill()` qui coupe net.

## 2. Le paquet

- **Version** `AAAA.MM.JJ-n` + numéro entier croissant ; `app/VERSION.json`. Jamais de
  retour à un numéro inférieur (revenir en arrière = republier l'ancien code sous un
  nouveau numéro).
- **Arbre complet de `app/`** (quelques Mo), pas un différentiel : un site qui a sauté
  une version installe directement la dernière. Exclus : `.env*`, `.git`,
  `node_modules`, `data/`, `runtime/`, `apps/siege`, `supabase/`, `docs/`, `.claude/`.
- **Dépendances** dans un paquet séparé et rare, identifié par l'empreinte du
  `pnpm-lock.yaml` : inchangé → le site réutilise son `node_modules` (simple renommage).
- **`PosSamer.exe`** : mise à jour automatique seulement en phase 3, avec un processus
  de garde ; avant ça, l'outil de publication refuse un paquet qui change `apps/desktop`.
- Archive `.tar.gz` en **morceaux de 40 Mo** (limite Supabase, reprise après coupure),
  liens et chemins `..` refusés.
- **Signature Ed25519** du manifeste (qui contient les SHA-256 de chaque morceau et de
  chaque fichier). Clé privée chiffrée sur une **clé USB dédiée « signature »**, distincte
  de la clé master, branchée seulement pour publier. Clé publique embarquée dans le
  lanceur ; c'est elle qui fait foi.
- **Outil de publication** `scripts/maj/publier.mjs` sur le poste master : arbre git
  propre, installation, typecheck, tests, build caisse, contrôle des migrations (évite
  le piège de renumérotation 0034→0039), contrôle anti-Grenam + scan Defender, archive,
  signature, envoi au cloud via le compte siège ADMIN (pas de `service_role` sur le PC).
- Stockage : bucket Supabase **privé** `paquets-pos`, URL signées d'1 h, 3 dernières
  versions conservées.

## 3. Sur le site

- **Serveur** (nouveau module `apps/server/src/modules/maj/`) : consulte le cloud toutes
  les 15 min, télécharge en arrière-plan (débit bridé, reprise morceau par morceau,
  contrôle d'espace disque), vérifie signature et empreintes, prépare la nouvelle
  version dans `maj/pret/<numero>/`. Il ne touche jamais `app/` en place.
- **Lanceur** : décide quand installer, installe, reprend après coupure, décide du
  retour arrière. Il revérifie tout avec sa propre clé publique. Communication par
  fichiers dans `maj/` (le lanceur peut décider même si le serveur est mort).
- **À H-10 min** : bandeau sur la caisse « Mise à jour à 06h00 (2-3 min) » avec
  « Pas maintenant » (PIN manager, report d'1 h, tracé).
- **Installation** :
  1. revérification du paquet et de l'espace disque ;
  2. arrêt propre de l'API (503 « Mise à jour en cours »), des Vite, du serveur, puis de
     PostgreSQL ;
  3. **sauvegarde à froid** de `data/pgdata` ;
  4. échange de dossiers `app` → `app.precedente`, nouvelle version → `app` (le `.env` du
     site est recopié) ;
  5. PostgreSQL, migrations ;
  6. démarrage **en mode validation** (aucune vente, synchro ni ordre) et contrôle de
     santé : `/api/sante`, version attendue, caisse servie, serveur vivant ;
  7. bon → la caisse rouvre, le shift et les sessions sont intacts, compte rendu
     « INSTALLÉ » au siège ;
     mauvais → **retour arrière automatique** (ancienne base et ancien code), version
     marquée « refusée » localement, compte rendu d'échec au siège.
- **Coupure de courant pendant l'installation** : chaque étape est journalisée ; au
  démarrage, le lanceur reprend ou revient à l'ancienne version. 2 tentatives maximum
  par version.
- **Poste éteint à l'heure prévue** : au rallumage, installation avant d'ouvrir la caisse.

## 4. Cloud et console siège

- Tables `maj_versions` (statut BROUILLON → PILOTE → GENERALE, ou RETIREE),
  `maj_reglages_site` (heure creuse, anneau pilote/général, pause, version épinglée,
  « installer maintenant »), `maj_rapports` (historique par site).
- Fonction `maj` pour les sites (clé de site), actions `maj_*` dans la fonction `siege`,
  tracées.
- L'écran **Santé des sites** affiche : version installée / cible, état (à jour,
  téléchargement, prête pour 06h00, reportée, échec), « en retard » après 24 h, et une
  sentinelle Grenam (exe de 533 504 octets ou `g*.exe` caché).
- Droits : LECTURE voit ; ADMIN règle et promeut ; **publier exige en plus la clé privée
  hors ligne** — un compte siège compromis ne peut que cibler des versions déjà signées.

## 5. Pièges couverts

Migrations : règle « ajouter d'abord, supprimer une version plus tard » ; coupure
internet ; disque plein ; antivirus (renommages retentés, pas d'exclusion Defender) ;
Grenam (plus de clé USB, signatures, sentinelle) ; deux versions publiées de suite (on
ne prépare que la plus haute) ; horloge du PC fausse (remontée au siège).

## 6. Étapes de livraison

| Lot | Contenu |
|---|---|
| L0 | Fondations : manifeste, signature, archive, décision du créneau, reprise (tests unitaires) |
| L1 | Cloud : migration, bucket, fonction `maj`, actions siège |
| L2 | Outil de publication |
| L3 | Module serveur (téléchargement, préparation, mode validation) |
| L4 | Lanceur (installation, reprise, retour arrière, page « Mise à jour en cours ») |
| L5 | Bandeau caisse + « Pas maintenant », colonnes de la Santé des sites |
| L6 | Banc d'essai : coupures à chaque étape, migration qui plante, disque plein, mauvaise signature… |
| L7 | Dernière clé USB, site par site (7E d'abord) |
| L8 | Pilote Angré 7E : une version sans changement, puis une petite migration, puis les 7 autres |
| L9 | Phase 3 : mise à jour automatique de `PosSamer.exe` avec garde |

## 6 bis. Lot L0 — livré (23/10/2026)

**Emplacement** : `apps/desktop/maj/*.cjs` (CommonJS pur, aucune dépendance, `node:crypto`
et `zlib` natifs), types dans `apps/desktop/maj/index.d.cts`.
- Le **lanceur** les embarque dans l'asar (`"maj/*.cjs"` dans `build.files`, vérifié sur un
  build `--dir`) et fera `require('./maj/index.cjs')` en L4. C'est sa copie, avec sa clé
  publique, qui fait foi.
- Le **serveur** les importe via `apps/server/src/modules/maj/fondations.ts`
  (`export * from '../../../../desktop/maj/index.cjs'`), vérifié avec tsc, tsx et vitest.
  Sur site, le chemin relatif reste valable : `apps/desktop` fait partie de l'arbre livré.

| Module | Contenu |
|---|---|
| `manifeste.cjs` | format `manifeste.json` (types APP et DEPENDANCES), validation stricte écrite à la main, `problemeChemin` (absolu, `..`, `\`, lecteur, `:`, noms réservés Windows, doublons de casse), `ouvrirManifesteSigne` (signature vérifiée AVANT tout parsing), `problemesCompatibilite` |
| `signature.cjs` | Ed25519 sur les octets exacts ; trousseau `{ actuelle, suivante }` pour la rotation ; clé publique en PEM ou en forme courte (32 octets en base64) |
| `archive.cjs` | tar ustar + gzip maison, morceaux de 40 Mo (paramétrable) avec SHA-256, `verifierMorceaux` (pour la reprise), `extraireArchive` (liens, types spéciaux, `..`, absolus refusés ; chaque fichier comparé au manifeste ; dossier supprimé en cas d'échec), `verifierArbre` (revérification avant installation) |
| `creneau.cjs` | `deciderCreneau` : règles du 21 et du 23/10 (ferme la nuit / 24h/24, filet de 05h00, report unique de 30 min avec rappel, rattrapage de 2 h, poste éteint) |
| `installation.cjs` | étapes, journal `installation.json` atomique, `deciderReprise` (2 tentatives par version), exécuteur générique `executerInstallation` / `executerRetour` à opérations injectées |
| `retention.cjs` | sauvegardes : 7 jours, toujours les 2 dernières |
| `version.cjs` | `VERSION.json` (repli `dev` = numéro 0), `AAAA.MM.JJ-n`, `deciderMontee` (jamais de numéro inférieur) |
| `scripts/maj/generer-cle.mjs` | paire Ed25519, clé privée PKCS#8 chiffrée par phrase de passe, refuse d'écrire dans le dépôt |

**Tests** (114, sans base de données, clés jetables) :
`node --test "apps/desktop/maj/test/*.test.cjs"` depuis la racine, ou `pnpm --filter @pos/desktop test`.
Ils passent aussi sous le runtime Electron (`ELECTRON_RUN_AS_NODE=1 electron --test …`).
Test de raccordement côté serveur : `apps/server/test/maj-fondations.test.ts` (vitest).

**Reste pour la suite** :
- L1 : tables, bucket, fonction `maj` (le manifeste et la signature sont publiés tels quels) ;
- L2 : `scripts/maj/publier.mjs` = liste des fichiers + `ecrireArchive` + `serialiserManifeste` + `signer` ;
- L3 : téléchargement, `verifierMorceaux` pour la reprise, `ouvrirManifesteSigne` + `extraireArchive` vers `maj/pret/<numero>/` ;
- L4 : numéro du lanceur (`lanceur_min`), clés publiques réelles dans `main.js` (à générer par le
  propriétaire avec `generer-cle.mjs`), opérations disque réelles des étapes, appel de
  `deciderReprise` puis `deciderCreneau` au démarrage, `choisirSauvegardesASupprimer`.

## 6 ter. Lots L3-L4 — livrés (23/10/2026)

Branche `agent/maj-site`. Contrat suivi : `docs/MAJ_CONTRAT.md` (écarts listés plus bas).

### L3 — serveur (`apps/server/src/modules/maj/`)

| Fichier | Rôle |
|---|---|
| `config.ts` | `POS_RACINE` (absent = module inactif : postes de développement, tests), `POS_JETON_LANCEUR`, `POS_LANCEUR_NUMERO`, débit (`MAJ_DEBIT_MAX_KO_S`, 512 Ko/s par défaut), intervalle (`MAJ_INTERVALLE_S`, 15 min), version démarrée (`VERSION.json` de l'arbre qui tourne) |
| `client.ts` | Edge Function `maj` : `consulter`, `rapporter` (détail borné à ~7 Ko) |
| `telechargement.ts` | client HTTP dédié : délai d'INACTIVITÉ de 60 s (pas de délai global), reprise morceau par morceau et `Range` dans un morceau (`.partiel`), lien expiré (400/401/403) → nouvelle consultation, débit bridé, SHA-256 contrôlé avant renommage |
| `moteur.ts` | boucle 15 min ; signature (clé de l'arbre, `apps/desktop/maj/cles-publiques.json`), `problemesCompatibilite`, dépendances seulement si l'empreinte diffère de `node_modules/.empreinte-deps`, contrôle d'espace (paquets + pgdata + 500 Mo), extraction via `.partiel` puis renommage, `etat.json` atomique (verrou interne), seule la cible gardée, comptes rendus une fois chacun (y compris ceux tirés du journal du lanceur : INSTALLE, ECHEC_RETOUR_ARRIERE, REFUSEE, BLOQUE), tick 60 s du créneau (événement `maj`, compte rendu AVERTI), report, bloc `sante.maj`, sentinelle Grenam (toutes les 6 h) |
| `mode.ts` | NORMAL / VALIDATION (`POS_MODE_VALIDATION=1`) / ARRET : 503 « Mise à jour en cours » sur `/api/*` sauf `/api/sante*` et `/api/maj/*`, compteur des requêtes en cours, tâches de fond différées jusqu'à la validation |
| `routes.ts` | `/api/maj/lanceur/arret` et `/valider` (jeton + localhost, 404 sinon), `/api/sante/version`, `/api/maj/etat`, `/api/maj/reporter` (PIN gérant, un seul report, audit `REPORT_MAJ`) |

Raccordements : `app.ts` (hook + routes), `index.ts` (aucune boucle de fond en mode
validation), `battement.ts` (bloc `maj` facultatif), `version.ts` (`VERSION.json` avant
git), `ws.ts` (événements `maj`, `maj_debut`, `maj_terminee`), `audit.ts` (`REPORT_MAJ`).

### L4 — lanceur (`apps/desktop`)

| Fichier | Rôle |
|---|---|
| `maj/cles-publiques.json` | trousseau `{ actuelle, suivante }` embarqué dans l'asar (`build.files`). **Vide** : mise à jour désactivée, motif remonté au siège |
| `maj/cles.cjs` | `chargerTrousseau` (ne lève jamais) |
| `maj/site.cjs` | chemins du dossier portable, `etat.json` (serveur), `lanceur.json` (jetons traités par le lanceur), empreinte des dépendances, taille, espace libre, sentinelle Grenam |
| `maj/operations.cjs` | opérations RÉELLES des étapes : revérification (signature avec la clé DU LANCEUR, arbre, dépendances, espace), arrêt (API → Vite → serveur → `pg_ctl stop -m fast -w`), sauvegarde à froid avec marqueur `COMPLET`, échange (`.env*` recopiés, node_modules déplacés ou paquet de dépendances, copies `@pos/*` régénérées depuis `packages/`, renommages retentés ~60 s), migrations, contrôle de santé 90 s, finalisation (qui ne revient jamais en arrière), retour arrière idempotent, nettoyage et rétention |
| `maj/lanceur.cjs` | `auDemarrage` (`deciderReprise`, puis installation si `deciderCreneau` le veut), `verifierCreneau` (60 s), jetons « installer maintenant » / « réessayer » ; `situationInstallation`, partagée avec le serveur |
| `main.js` | `NUMERO_LANCEUR = 1`, jeton tiré à chaque lancement, variables passées au serveur, `sequenceDemarrage` avant la caisse, surveillance 60 s, page « Mise à jour en cours — 2 à 3 minutes, ne pas éteindre », fermeture refusée pendant une installation, arrêt de PostgreSQL attendu à la fermeture |

Comportement du lanceur :

| Cas | Ce qui se passe |
|---|---|
| 24h/24, poste allumé à 06h00 | à H-10 bandeau sur la caisse ; à 06h00 (vérification toutes les 60 s) page « Mise à jour en cours », installation, caisse rechargée |
| « Pas maintenant » (une fois) | installation à 06h30, rappel sans bouton à 06h28 |
| 24h/24, poste éteint à 06h00 | au rallumage, installation AVANT d'ouvrir la caisse |
| 24h/24, redémarrage en journée avant l'heure | rien, la caisse s'ouvre |
| Ferme la nuit | installation au démarrage suivant ; filet 05h00 si pas de redémarrage 24 h après « prête » |
| Migration ou contrôle de santé raté | retour arrière (ancien code, base restaurée), version refusée, compte rendu au prochain démarrage du serveur |
| Fichier verrouillé, disque plein | retour arrière sans refus : seconde chance au créneau suivant (2 tentatives par version) |
| Signature invalide, lanceur trop ancien | refus avant tout arrêt |
| Coupure de courant | au démarrage, reprise ou retour selon le journal ; un retour coupé est rejoué |
| Retour arrière impossible (3 fois) | écran d'erreur « appelez le support » ; « Réessayer » ouvre la caisse sans retenter |
| Sans clé publique | rien n'est jamais installé |

### L5 côté caisse

`components/BandeauMaj.tsx`, `stores/maj.ts`, `temps-reel.ts` : bandeau à H-10, « Pas
maintenant » (PIN gérant, une fois), rappel, écran « Mise à jour en cours » sur
`maj_debut`, rechargement après `maj_terminee` dès que la caisse est au repos (accueil,
tables, mes ventes, supervision), avec repli par interrogation de `/api/maj/etat`.
**Caisse non recompilée.**

### Tests

- `node --test "apps/desktop/maj/test/*.test.cjs"` : 166 (114 L0 + 52 du banc d'essai
  `banc-lanceur.test.cjs` : nominale, dépendances, migration ratée, santé ratée, serveur
  qui meurt, signature, fichier modifié, sans clé, lanceur trop ancien, disque plein,
  EBUSY passager et permanent, poste éteint, ferme la nuit, jetons du siège, rétention,
  coupure à 24 points de l'installation et à 9 points du retour arrière, deux coupures).
  Le banc passe aussi sous le runtime Electron 33 (Node 20.18).
- Serveur : `test/maj-serveur.test.ts` (14), `test/maj-routes.test.ts` (7).
- Build de contrôle `electron-builder --win dir` : `maj/*.cjs` et `cles-publiques.json`
  présents dans l'asar et chargés.

### Écarts au contrat (à reporter dans `MAJ_CONTRAT.md` d'un commun accord)

1. `etat.json` porte des champs EN PLUS du minimal : `pret.dependances.manifeste` et
   `.signature` (le lanceur revérifie aussi les dépendances), `report.numero` et
   `report.par_id`, `rapports_envoyes`, `consulte_le`.
2. Nouveau fichier `ROOT/maj/lanceur.json` (seul écrivain : le lanceur) : jetons
   « installer maintenant » / « réessayer » traités ; le serveur le recopie dans
   `etat.json.jetons_traites`.
3. Mode validation : les fichiers statiques de la caisse et `/ws` restent servis (le
   contrôle de santé exige justement « la caisse servie ») ; seule l'API `/api/*` est en 503.
4. `GET /api/maj/etat` est public (bandeau visible dès l'écran de connexion).
5. « Réessayer » ne porte pas de numéro : le lanceur lève TOUS les refus locaux.
6. Paquet DEPENDANCES : chemins supposés relatifs à `app/` (`node_modules/…`,
   `apps/<a>/node_modules/…`), extraits dans `maj/pret/deps-<e>/`. **À confirmer avec L2.**
7. DEBUT est rapporté par le serveur à l'arrêt, INSTALLE à la validation ; les autres
   issues de l'installation partent du journal au démarrage suivant du serveur.
8. `integrite.suspects_grenam` vaut `null` avant la première analyse (2 min après le
   démarrage) ; Node ne lit pas l'attribut « caché » : la sentinelle compte les `.exe`
   de 533 504 octets et les paires `g<nom>.exe` / `<nom>.exe`.

### Ce que la dernière clé USB (L7) devra contenir

- un **nouveau `PosSamer.exe`** repackagé depuis cette branche (lanceur n° 1), avec la
  **vraie clé publique** du propriétaire dans `apps/desktop/maj/cles-publiques.json` ;
- `app/VERSION.json` (numéro et version de l'arbre de la clé, écrit par l'outil L2) ;
- `app/node_modules/.empreinte-deps` = SHA-256 du `pnpm-lock.yaml` de la clé (sans lui,
  la première mise à jour retélécharge tout le paquet de dépendances) ;
- le code de cette branche (module serveur, caisse recompilée avec le bandeau) et les
  copies `@pos/*` à jour dans `apps/*/node_modules/@pos/*` ;
- le dossier `maj/` se crée tout seul (inutile de le copier).

### Reste

- Clé du propriétaire (`generer-cle.mjs`), puis repackaging ; rebuild de la caisse.
- L6, suite : banc sur un vrai poste (vrai PostgreSQL, Defender, vraie coupure secteur).
- L'installation « au démarrage » suppose que la session Windows s'ouvre seule (la tâche
  `POS-Samer` démarre à l'ouverture de session) : vérifier l'ouverture automatique sur
  chaque site « ferme la nuit ».
- Pendant les 2-3 min, KDS, tablettes et écran client (Vite) sont arrêtés eux aussi.

## 7. Réponses du propriétaire (23/10/2026)

1. « Pas maintenant » : **un seul report**, de 30 min ; à la fin, rappel à l'écran puis
   installation. (PIN gérant pour reporter.)
2. Supabase : **forfait payant**.
3. Clé de signature : **le propriétaire seul**.
4. `PosSamer.exe` : **mis à jour à distance aussi** (phase 3, avec garde).
5. Règle « ajouter d'abord, supprimer une version plus tard » pour les migrations : **oui**.
6. Pilote **48 h sur Angré 7E** ; **publication réservée au propriétaire**.
7. Sauvegardes de base avant mise à jour : **gardées 7 jours, au moins les 2 dernières**.

## 7 bis. Questions initiales

1. « Pas maintenant » : 3 reports par jour au maximum, puis report au lendemain
   (signalé au siège) ? Avec PIN gérant ?
2. ~~Poste rallumé en plein service avec une mise à jour en attente ?~~ **Tranché le
   21/10** : voir « Règle d'installation par type de site » en tête.
3. Forfait Supabase (taille max par fichier, stockage, bande passante) et débit internet
   réel des sites ?
4. Qui garde la clé USB de signature et sa phrase de passe ? Une seconde personne de
   secours ?
5. Mise à jour automatique de `PosSamer.exe` (phase 3), ou passage manuel exceptionnel ?
6. Accord sur la règle « ajouter d'abord, supprimer une version plus tard » ?
7. Pilote : 48 h d'observation sur le 7E avant les autres ? Publier réservé au
   propriétaire, ou ouvert à tout ADMIN siège ?
8. Sauvegardes de base gardées 7 jours ou 2 versions ?
