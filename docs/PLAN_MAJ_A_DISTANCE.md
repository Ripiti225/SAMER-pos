# Plan — mise à jour à distance des postes (sans clé USB)

**Statut : plan à valider par le propriétaire (21/10/2026). Rien n'est codé.**

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
