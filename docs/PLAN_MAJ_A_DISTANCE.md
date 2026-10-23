# Plan — mise à jour à distance des postes (sans clé USB)

**Statut : plan validé par le propriétaire (23/10/2026). Lot L0 livré (voir § 6 bis).
Lots L1-L2 et L5 côté siège livrés, NON déployés (voir § 6 ter).**

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

## 6 ter. Lots L1-L2 — livrés (23/10/2026), rien d'appliqué dans le cloud

Contrat suivi : `docs/MAJ_CONTRAT.md` (non modifié).

### L1 — cloud

- **Migration** `supabase/migrations/20261023000000_maj_postes.sql` (rejouable, testée sur
  une base vierge avec toutes les migrations cloud) : `maj_versions` (BROUILLON → PILOTE →
  GENERALE, ou RETIREE ; manifeste et signature recopiés au caractère près),
  `maj_dependances` (paquets DEPENDANCES par empreinte du lock — 4ᵉ table, une version APP
  n'en est qu'un renvoi), `maj_reglages_site` (pré-remplie par `sites_autorises.code` :
  FERME_LA_NUIT pour AL_KAYAN_KMS, SAMER_LAVAGE, SAMER_OASIS ; H24 à 06:00 pour les cinq
  autres ; anneau PILOTE pour SAMER_ANGRE_7E ; `ON CONFLICT DO NOTHING`, un réglage changé
  au siège n'est jamais écrasé), `maj_rapports`, colonnes `maj_*` de `sites_sante`,
  `siege_sante_sites()` recréée avec ces colonnes, `siege_utilisateurs.proprietaire`,
  bucket PRIVÉ `paquets-pos` (50 Mo par objet) créé par `storage.buckets`.
- **Fonction `maj`** (clé de site) : `consulter` / `rapporter` du contrat § 2. Cible =
  épinglée si servable, sinon plus haute PILOTE|GENERALE (anneau pilote) ou GENERALE ;
  jamais un brouillon ni une retirée ; une épingle sur une version retirée est ignorée.
  URL signées d'1 h. Tables absentes → défauts + `migration_absente: true`.
- **`sync-pull`** : bloc `sante.maj` lu par `lireBlocMaj` et écrit APRÈS le battement, à
  part — sans la migration, seul ce bloc est perdu.
- **Fonction `siege`** (`siege/maj.ts`) : `maj_preparer_envoi`, `maj_enregistrer` (relit
  manifeste et signature DANS LE STOCKAGE, vérifie Ed25519 par WebCrypto avec le secret
  `MAJ_CLE_PUBLIQUE`, contrôle numéro ↔ version et présence/taille des morceaux),
  `maj_promouvoir` (48 h de pilote, sinon confirmation `forcer`), `maj_retirer` (motif
  obligatoire) — **propriétaire seulement** ; `maj_reglages_site` (ADMIN, jeton neuf par
  « installer maintenant » / « réessayer ») ; `maj_historique` (LECTURE). Tout est tracé
  dans `siege_audit` (`MAJ_*`). Rétention : après chaque promotion, les morceaux sortis
  des 3 dernières versions et cibles de personne sont effacés du bucket.
- **Propriétaire** : drapeau `siege_utilisateurs.proprietaire` + `exigeProprietaire`
  (= ADMIN ET drapeau). `verifierSiege` lit la ligne par `select('*')` pour que la console
  reste ouverte tant que la colonne n'existe pas.
- Logique pure et tests (Node) : `_shared/maj-cible.ts`, `maj-signature.ts`,
  `maj-siege.ts`, `sante-sites.ts` — la vérification WebCrypto est testée contre des
  signatures produites par le lot L0.

### L5 côté siège

Santé des sites : colonnes « Version installée / cible » et « Mise à jour » (état, « en
retard » après 24 h de disponibilité de la cible hors pause, sentinelle Grenam). Écran
« Mises à jour » : versions, envoyer au pilote / à tous, retirer (propriétaire), réglages
par restaurant (ADMIN), comptes rendus.

### L2 — outil de publication `scripts/maj/publier.mjs`

`node scripts/maj/publier.mjs --aide`. Étapes et refus décrits en tête du script ;
bibliothèques testées dans `scripts/maj/lib/` (`node --test "scripts/maj/test/*.test.mjs"`).
Sur ce poste (pas de pnpm) : mode par défaut = `node_modules` du dépôt relié par jonction
au dossier temporaire, après contrôle que son `.pnpm/lock.yaml` est identique au
`pnpm-lock.yaml` du commit ; `--pnpm <chemin vers pnpm.cjs>` pour une installation neuve.

- **Paquet APP** : arbre du commit (`git archive`) + `apps/caisse/dist` construit + les
  `node_modules` LOCAUX des apps et paquets (`@pos/*` rematérialisés depuis `packages/` du
  commit, plus les rares dépendances propres à une app comme `idb` d'`apps/serveur`).
  Écart assumé au § 2 (« exclus : node_modules ») : sur les sites ces copies sont de vrais
  fichiers et doivent suivre le code (incident du 22/10). Exclus : `.env*`, `.git`,
  `node_modules` racine, `data/`, `runtime/`, `apps/siege`, `supabase/`, `docs/`,
  `.claude/`, `publications/`, caches `.vite`, `apps/desktop/release`,
  `apps/caisse/dist.avant-optimisation`. Aucun binaire (`.exe`, `.dll`…) accepté.
- **Paquet DEPENDANCES** : construit seulement si l'empreinte SHA-256 du `pnpm-lock.yaml`
  n'est pas déjà publiée (cloud) ou forcé par `--dependances`. Contenu : le `node_modules`
  RACINE vérifié contre le lock, chemins `node_modules/…` (extrait dans
  `maj/pret/deps-<e>/`, il donne `deps-<e>/node_modules` du contrat § 4), SANS `electron`,
  `electron-builder`, `app-builder-*`, `7zip-bin`, `@electron`, `dmg-builder`,
  `builder-util*`, `.bin`, caches (≈ 400 Mo au lieu de 900) : `PosSamer.exe` embarque déjà
  Electron. Pas de liens (nodeLinker hoisted). Contrôle anti-Grenam et Defender dessus.
  `node_modules/.empreinte-deps` n'est PAS dans l'archive : c'est au site (L3/L4) de
  l'écrire après installation.
- Numéro `AAAAMMJJnn` (rang du jour ≤ 99), version `AAAA.MM.JJ-n`.
- Migrations : journal ↔ fichiers, `when` strictement croissants, tag = index, migrations
  déjà livrées (commit `--depuis`) intactes, nouvelles après la dernière livrée ; `DROP`
  (hors contrainte/index/déclencheur/fonction/politique/défaut/NOT NULL) et `RENAME`
  refusés sans `--migrations-destructives`.
- `apps/desktop` modifié depuis la version des sites (hors `maj/test/`) : refus sans
  `--desktop-modifie` (phase 3 pas encore là).
- Vérifié de bout en bout en simulation sur ce poste avec une clé JETABLE : paquet signé,
  relu par `ouvrirManifesteSigne` + `verifierMorceaux` + `extraireArchive` du lot L0.

### À faire dans le cloud (dans cet ordre, rien n'est fait)

1. Appliquer la migration `20261023000000_maj_postes.sql`. Vérifier le bucket privé
   `paquets-pos` ; s'il manque, le créer privé (limite 50 Mo). Vérifier que la limite
   globale de taille de fichier du projet (Storage → Settings) est ≥ 50 Mo.
2. `UPDATE siege_utilisateurs SET proprietaire = true, niveau = 'ADMIN' WHERE user_id =
   (SELECT id FROM auth.users WHERE email = '<adresse du propriétaire>');`
3. Le propriétaire génère SA paire (`node scripts/maj/generer-cle.mjs --sortie <clé USB
   signature>`), puis secret de la fonction `siege` : `MAJ_CLE_PUBLIQUE` = forme courte
   imprimée (et plus tard `MAJ_CLE_PUBLIQUE_SUIVANTE` pour une rotation). La même clé
   publique part dans le lanceur (L4).
4. Déployer les fonctions `maj` (nouvelle, `verify_jwt = false` dans `config.toml`),
   `sync-pull`, `siege`.
5. Publier la console siège (Vercel).

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
