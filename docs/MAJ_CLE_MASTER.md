# MAJ de la clé master

**Journal des modifications faites APRÈS la création de la clé master USB.**

La clé a été copiée le **2026-08-17 à 05h01:32**, avec l'identité neutre `A_CONFIGURER`
et les deux seuls comptes propriétaire. Tout ce qui est écrit ici est **postérieur**.

> **Report effectué le 2026-08-21 à 15h48** via `mettre-a-jour-cle.ps1` (`data\` exclu,
> la base neutre de la clé est intacte). **Toutes les entrées ci-dessous sont désormais
> sur la clé**, code et `apps/caisse/dist` compris. Les entrées ajoutées après cette
> date ne le seront pas : recommencer le report avant tout nouveau déploiement.

Le poste **Samer Angré 7E** (`C:\Users\PC\Documents\POS-Samer-deploiement`) est le
**site de test** du groupe : c'est ici qu'on essaie, qu'on casse et qu'on corrige
avant que les 6 autres restaurants ne reçoivent quoi que ce soit.

## Comment lire ce fichier

- Chaque entrée dit **ce qui a changé**, **pourquoi**, et **ce qu'il faut faire pour
  le déployer ailleurs**.
- « Rebuild caisse » = `pnpm --filter caisse build`. **Obligatoire après toute modif
  de `apps/caisse`** : le kiosque sert la caisse en STATIQUE depuis `apps/caisse/dist`.
- « Relancer l'exe » = quitter `PosSamer.exe` (`Ctrl+Alt+Q`) et le relancer. Suffit
  pour toute modif SERVEUR (tsx lit les sources, sans watch).
- « Repackager » = `pnpm --filter @pos/desktop build` — seulement si `apps/desktop`
  change. **Aucune entrée de ce journal ne l'exige à ce jour.**
- **Une migration a été ajoutée depuis la clé** : la **0026**, écrite le 21/08. La
  clé s'arrête à la 0025. Tout poste qui reçoit cette mise à jour doit passer
  `pnpm db:migrate` — c'est la seule entrée de ce journal qui l'exige.

## État de synthèse

| | |
|---|---|
| Dernière migration | **0027** (`0027_contact_livraison.sql`) — **pas sur la clé** |
| Migrations ajoutées depuis la clé | **2 — la 0026 et la 0027** (`pnpm db:migrate` obligatoire) |
| Rebuild caisse | **À REFAIRE** — `dist` du 18/08 23h30, antérieur aux sources d'`apps/caisse` |
| Report du code sur la clé master | **à refaire** — dernier report le 21/08 15h48 ; la clé s'arrête à la migration 0025 |
| Repackaging `PosSamer.exe` nécessaire | non |
| Redéploiement Edge Function | **OUI — `siege`** (nouvelle action `siege_livraisons_caissier`), plus `sync-push` (fait le 17/08) et `samtrackly-points` (à confirmer déployée) |
| Migrations CLOUD à appliquer | **3** — `20260817140000_pont_samtrackly`, `20260821150000_inventaire_snapshot_produit`, `20260825030000_livraisons_partenaires` |
| Tests | **42 fichiers, 263 tests verts** (POS) + **103 tests** du pont (`pnpm test:functions`) |

> **Trou de journal à combler.** Ce fichier s'arrête au 21/08 ; les commits du
> 22 au 25/08 (séquences, ordres du siège, console du siège, republication des
> rôles et de la salle, reçu PDF, correctif UUID en contexte non sécurisé) n'y
> ont pas d'entrée. Ils sont dans le dépôt, pas ici : relire `git log` avant un
> déploiement plutôt que de se fier à ce seul journal.

---

## 2026-08-17 — Enrôlement : `enroler-ce-poste.bat`

**Fichier** : `POS-Samer\enroler-ce-poste.bat` (racine du dossier portable, hors `app`).

Créé à 05h50, soit **49 minutes après la copie de la clé — il n'est donc pas dessus.**
Sans lui, l'opérateur d'un nouveau site doit connaître Node, pnpm et les variables
d'environnement, qu'aucun poste n'a.

Ce que le script fait :

- met `runtime\node` dans le `PATH` (les postes n'ont ni Node ni pnpm installés) ;
- pose `SUPABASE_SYNC_URL` ;
- **vérifie `pg_isready` AVANT de lancer quoi que ce soit** — sans ce contrôle,
  l'opérateur recevait une trace Drizzle de 30 lignes au lieu de la vraie consigne
  (« Lance d'abord PosSamer.exe ») ;
- `pause` à la fin pour laisser le temps de copier le SQL affiché.

**À faire pour un nouveau site** : copier ce `.bat` à la racine du dossier POS-Samer
du poste, ou l'inclure dans la prochaine clé.

**Rappel de la procédure d'enrôlement** (rien ne se recopie d'un poste à l'autre) :

1. Copier le dossier de la clé vers le **disque dur**, lancer `PosSamer.exe`.
2. **Réglages → Restaurant** → choisir le restaurant dans la liste (lue chez
   SamerTrackly). Ce clic **génère un `restaurant.id` neuf** et efface `cle_site` :
   c'est ce qui empêche les 7 sites de remonter leurs ventes dans le même seau.
3. Lancer `enroler-ce-poste.bat`.
4. Coller les **deux** `INSERT` affichés — `sites_autorises` **et** `restaurants` —
   puis relancer `PosSamer.exe`.

> On ne « retrouve » pas l'identifiant d'un site : on **relance le script**.
> `enroler-site.ts` est idempotent, il réutilise la clé déjà posée et réaffiche le
> même SQL.

---

## 2026-08-17 — Synchro cloud : un refus silencieux ne peut plus geler un site

**Fichiers** : `apps/server/src/modules/sync/{cloud-client,montee,moteur,etat}.ts`,
`supabase/functions/sync-push/index.ts`, `apps/caisse/src/components/SanteSync.tsx`,
`apps/server/test/sync-pannes.test.ts`.

### Le symptôme

« Synchroniser » laissait **tout en attente**, rien n'arrivait dans SamerTrackly, et
le voyant restait **vert**.

### La cause

Le code **réellement déployé** de `sync-push` était une version antérieure au 08/08 :
elle faisait `upsert(..., { onConflict: 'id' })` alors que le cloud est en **PK
composite `(restaurant_id, id)`** depuis le 09/08. PostgreSQL répondait
*there is no unique or exclusion constraint matching the ON CONFLICT specification*,
la fonction `break`ait sur la première ligne et renvoyait **HTTP 200 avec
`acquitte_jusqua_seq: 0`**. La file locale étant strictement ordonnée par `seq`,
**tout ce qui suivait restait bloqué à jamais**.

### PIÈGE À RETENIR — `functions list` MENT

Il annonçait `sync-push` en v3 puis v4 « mise à jour le 16/08 » alors que le paquet en
ligne avait deux mois (un deploy était parti d'un arbre périmé). **La seule
vérification qui vaut** :

```
npx.cmd --yes supabase@latest functions download <nom> --project-ref <ref>
```

**dans un dossier jetable** — il écrase le `supabase/functions/` du répertoire courant,
et chaque téléchargement réécrit `_shared/` avec SA copie (donc : une fonction à la
fois). Puis comparer les `Get-FileHash` aux sources.

### Les correctifs

| Où | Ce qui change |
|---|---|
| `montee.ts` | lève une `ErreurSync` quand un lot **non vide** revient acquitté à 0. Avant, c'était compté comme un succès — d'où le voyant vert et la file figée. |
| `sync-push` | trace le blocage dans `sync_rejets` (dédoublonné par site/seq/raison, **sans acquitter**) et renvoie `blocage: { seq, table_name, raison }`. |
| `etat.ts` | n'affiche plus « Hors ligne » quand le cloud répond très bien : il affiche **la raison** du blocage. |
| `SanteSync.tsx` | la pilule de la caisse affiche la même raison. |
| `sync-pannes.test.ts` | **Panne 7** ajoutée : le faux cloud ne simulait jamais « 200 sans rien appliquer », c'est par ce trou que le bug est passé. |

### Résultat vérifié sur le 7E

2 220 lignes vidées en ~5 min. Recoupé : 9 commandes, 18 items, 7 paiements
(33 500 F), 2 services, 15 `utilisateurs_site`, **0 `sync_rejets`**.

**À faire pour un nouveau site** : rien de particulier — le correctif Edge Function est
**déjà déployé sur le cloud**, il est partagé par tous les sites. Côté poste, les
sources modifiées doivent être sur la clé (rebuild caisse pour `SanteSync.tsx`).

---

## 2026-08-18 — Une table ouverte par erreur reste une table LIBRE

**Fichiers** : `apps/server/src/modules/tables/etat.ts`,
`apps/server/src/modules/commandes/{routes,service}.ts`,
`apps/server/src/modules/services/routes.ts`, `apps/server/src/modules/audit/audit.ts`,
`apps/caisse/src/screens/Commande.tsx`, `apps/server/test/table-ouverte-par-erreur.test.ts`.

### Le problème constaté sur le terrain

Le caissier ouvre une table (mauvais numéro, client qui repart), ne tape **aucun
produit** et ressort. La table restait **OCCUPÉE** : le plan de salle se remplissait de
fausses tables que personne ne pouvait encaisser, et « J'ai fini » se bloquait sur
« encaissez ou annulez les N commandes en cours » — pour une commande à 0 F jamais
saisie, dont l'annulation manuelle réclamait en plus un PIN manager.

### La règle posée

> **Une commande à ZÉRO ligne d'article n'existe pas pour la salle.**

- `deriverEtat` (source unique de calcul, jamais dupliquée dans les apps) **écarte les
  commandes vides**. Elles n'apparaissent ni en `commande_id`, ni dans
  `commandes_ouvertes` (tables virtuelles Yango/Glovo/Kdo), et `ouverte_par` n'est pas
  exposé — sinon la table paraîtrait libre **tout en restant verrouillée** pour les
  autres serveurs.
- Sortir de l'écran commande sans rien taper appelle
  **`POST /api/commandes/:id/abandonner`** : statut `ANNULEE`, table libérée,
  **numéro de ticket CONSERVÉ** (la séquence ne fait jamais de trou), audit
  `ABANDON_COMMANDE_VIDE`. **Aucun PIN manager** : rien n'a été tapé, aucun franc n'a
  bougé — l'exiger apprendrait au personnel à laisser traîner les fausses tables.
  La route est **idempotente** et **refuse de toucher** une commande qui a la moindre
  ligne : c'est le serveur qui revérifie, jamais le client qui décide.
- **Rouvrir** une table qui porte déjà une commande vide la **REPREND** au lieu d'en
  créer une seconde : pas de numéro de ticket gaspillé, pas d'empilement de fantômes.
  La commande reprise change de caissier et de service (elle appartient à qui la
  remplit).
- **« J'ai fini »** abandonne d'abord les commandes vides du shift, puis seulement
  vérifie les commandes en cours.

### Nuance à connaître

Le critère est **« aucune ligne du tout »**, pas « aucune ligne active ». Un article
tapé puis annulé (motif + trace) laisse la table occupée : c'est un **retour**, et il
doit rester visible.

### Filet de sécurité

Les deux mécanismes se doublent : même si l'abandon échoue (coupure réseau, exe tué),
l'état dérivé côté serveur montre la table **LIBRE** — la commande vide n'occupe rien.

**À faire pour déployer** : rebuild caisse + relancer l'exe. Aucune migration.

---

## 2026-08-18 — Une séquence est une JOURNÉE, et le gérant choisit ses shifts

**Fichiers** : `apps/server/src/modules/services/sequences.ts`,
`packages/shared/src/{types,schemas}.ts`,
`apps/server/src/printer/{ConsolePrinter,escpos}.ts`,
`apps/caisse/src/screens/Sequence.tsx`, `apps/server/test/sequence.test.ts`.

### Le problème

Le rasage refusait de se faire tant qu'un shift était ouvert. Or une séquence, c'est
**une journée de travail** (logique SamerTrackly), et le shift de nuit tourne encore
quand le gérant fait sa journée.

### Ce que dit le métier (et pourquoi aucune règle d'horloge ne suffit)

- Une journée commence au premier point : `00h-08h` pour un resto 24 h, `08h-16h` pour
  un resto du matin — **mais le créneau n'est pas figé** : un 24 h peut démarrer sa
  journée à `03h-08h35`.
- Elle se termine quand le **dernier point** se termine : 00 h, 01 h, 03 h — ça dépend
  de l'heure à laquelle on a rasé.
- **Un shift commencé la veille et fini le lendemain appartient à la VEILLE.**

### La décision : sélection des SHIFTS, la journée servant de proposition

Le choix était entre « sélection du jour » et « sélection des shifts ». **On a retenu
la sélection des shifts**, pour trois raisons :

1. Le créneau n'étant pas figé, une règle automatique se tromperait régulièrement — et
   une erreur sur un ticket Z est une **erreur d'argent**.
2. La sélection est un **sur-ensemble** : tout ce qu'une règle de jour ferait, le
   gérant peut le faire, et le corriger.
3. Elle répond directement au cas « il y a 5 shifts, j'en veux 3 dans cette séquence ».

La journée n'est pas perdue pour autant, elle fait le travail dans le cas courant :

- `ShiftSequence.journee` (AAAA-MM-JJ) est calculée **SERVEUR** sur l'heure
  d'**OUVERTURE** du shift — un point 16h→01h reste donc de la veille. Abidjan est à
  UTC+0 toute l'année (pas d'heure d'été) : la date ISO **est** la date locale, quelle
  que soit l'horloge du poste.
- L'écran **groupe les shifts par journée**, **pré-coche la première journée présente**
  et offre un bouton **« Raser la journée du jj/mm/aa »** par groupe → la journée
  complète en un geste.
- Les cases individuelles restent là pour les exceptions.

### Le comportement

- `POST /api/sequences/cloturer` accepte `{ service_ids? }` — omis = **tous les shifts
  clôturés** (le cas normal, rétro-compatible).
- **Un shift ouvert ne bloque plus rien.** Il n'est simplement pas *rasable* : sans
  comptage aveugle ni rapport Z, l'inclure **inventerait un chiffre de vente**. Le
  cocher renvoie une erreur explicite nommant le caissier.
- Tout ce qui n'est pas retenu (shift ouvert, ou shift clôturé rangé dans le lendemain)
  est **REPORTÉ** : une nouvelle séquence s'ouvre dans la foulée et les récupère.
  Rien ne se perd, rien ne bloque.
- Rasage refusé si **aucun** shift clôturé n'est retenu (« la séquence serait vide »).
- `RapportSequence.shifts_reportes` est **imprimé sur le récap papier** : sans cette
  ligne, un total amputé des shifts laissés pour le lendemain passerait pour un manque
  en caisse.
- Le journal d'audit `CLOTURE_SEQUENCE` note qui a été reporté et si le choix était
  manuel.

> **Piège technique** : l'index unique partiel `un_sequence_ouverte` n'autorise qu'une
> séquence `OUVERTE`. Le passage de l'ancienne à `CLOTUREE` doit donc précéder
> l'`INSERT` de la suivante, sinon l'insertion est refusée.

### Aperçu des totaux : calculé serveur

Le total affiché suit les cases cochées. Il est demandé au serveur
(**`POST /api/sequences/apercu`**) à chaque changement de coche, avec la valeur
précédente conservée pendant l'aller-retour. **La caisse n'additionne aucun montant** —
même règle que l'addition d'une commande (§ CLAUDE.md).

**À faire pour déployer** : rebuild caisse + relancer l'exe. Aucune migration.

---

## 2026-08-18 — La pastille « commande prête » ne reste plus collée

**Fichiers** : `apps/server/src/modules/salle/routes.ts`,
`apps/caisse/src/components/NotificationsCaisse.tsx`,
`apps/serveur/src/components/NotificationsServeur.tsx`.

### Le problème

Quand la cuisine ou un serveur marquait une commande **servie**, la pastille verte
« Table X — commande prête » **restait affichée sur l'écran du caissier**, jusqu'au
rechargement de la page.

### La cause

La liste des commandes prêtes était un **état local du navigateur**, alimenté par le
WebSocket et vidé **uniquement** quand la caisse cliquait elle-même sur « Servie ».
Tout ce qui se passait ailleurs (cuisine, tablette serveur, encaissement, annulation)
lui échappait.

### Le correctif

Nouvelle route **`GET /api/commandes/pretes`** : la liste devient une **lecture
serveur**, pas une mémoire d'écran. La pastille disparaît dès que la commande n'est
plus prête — **qui que soit celui qui l'a servie, encaissée ou annulée**.

Le ciblage serveur/caisse est **recalculé à chaque lecture** (même règle qu'au moment
où la cuisine a dit « prête ») : la commande appartient à son serveur s'il est
connecté, à la caisse sinon. Conséquence utile : **si le serveur se déconnecte, la
commande retombe d'elle-même sur la caisse.**

Le WebSocket ne sert plus qu'à faire **biper** et à déclencher la relecture immédiate.

**Le même défaut existait sur la tablette serveur** — corrigé de la même façon.

**À faire pour déployer** : rebuild caisse + relancer l'exe (la tablette serveur est
servie depuis les sources, rien à construire).

---

## 2026-08-18 — Un caissier peut enchaîner deux tranches

**Fichiers** : `apps/server/src/modules/services/routes.ts`,
`apps/caisse/src/screens/Cloture.tsx`,
`apps/server/test/shift-enchaine-et-notifs.test.ts`.

### Le problème

Un caissier fait `16h-00h` **puis** `00h-08h`. Pour clôturer sa première tranche il
doit vider ses tables ; mais « Transférer » **refusait de le choisir lui-même**
(« Choisissez un autre caissier que vous-même »). Il était donc coincé : soit il
liquidait ses tables, soit il les prêtait à un collègue absent.

### Le correctif

Le receveur d'un transfert **peut être le donneur lui-même**.

- Ses commandes sont alors **DÉTACHÉES** du shift qui se ferme (`service_id` mis à
  `NULL`) au lieu d'y être remises — sans ça la clôture restait bloquée, puisque le
  seul service ouvert du « receveur » est précisément celui qu'on vide.
- Elles se **rattachent automatiquement** au shift suivant qu'il ouvre (mécanique déjà
  en place pour les transferts reçus hors service).
- **Le PIN reste demandé** : c'est le sien, et il protège contre un tiers qui ferait le
  geste à sa place.
- L'audit `TRANSFERT_COMMANDES` porte `meme_caissier: true` — un enchaînement de
  tranches n'est **pas** une relève, il faut pouvoir les distinguer.

Dans l'écran de clôture, il apparaît **en tête de liste** :
*« J'enchaîne — je garde mes tables pour mon prochain shift »*.

**À faire pour déployer** : rebuild caisse + relancer l'exe. Aucune migration.

---

## 2026-08-18 — Vider une table, et donner un toit aux commandes à emporter

**Fichiers** : `apps/server/src/modules/salle/routes.ts`,
`apps/server/src/modules/commandes/routes.ts`,
`packages/shared/src/{types,schemas}.ts`,
`apps/caisse/src/screens/{Tables,Commande,Accueil}.tsx`,
`apps/server/test/liberer-table.test.ts`.

### Les deux problèmes signalés par le boss

1. **Aucun bouton ne rendait une table à la salle.** Ni celle ouverte par erreur (rien
   de tapé), ni surtout celle qui porte des produits : une table ne se vidait qu'en
   encaissant. Client parti, mauvais numéro, commande tapée deux fois → la table
   restait affichée occupée jusqu'à la clôture.
2. **Les commandes à emporter n'apparaissaient NULLE PART.** Elles n'occupent aucune
   table : une fois l'écran de saisie quitté, plus rien à l'écran. Le caissier qui
   revenait donner la facture ne les voyait plus, croyait n'avoir rien tapé, **et
   retapait toute la commande** — deux tickets, deux fois les plats en cuisine.

### 1. Libérer une table — une porte, deux régimes, tranchés par le SERVEUR

Nouvelle route **`POST /api/caisse/tables/:id/liberer`** (permission
`caisse.annuler_envoye`, celle de l'annulation) :

| Ce que porte la table | Ce qu'il faut | Ce qui est écrit |
|---|---|---|
| Aucun article | **rien** — ni PIN ni motif | audit `ABANDON_COMMANDE_VIDE` |
| Au moins un article | **PIN manager + motif** | audit `ANNULATION_COMMANDE` par commande |

C'est le serveur qui compte les lignes, jamais l'écran. Un article ajouté pendant la
manœuvre fait **refuser** la libération (409) plutôt que d'annuler des produits sans
PIN. Les numéros de ticket sont conservés (statut `ANNULEE`) : la séquence ne fait
jamais de trou. Les **appels client encore en attente sont soldés** — sinon la table
repartait aussitôt en « Addition demandée » alors qu'elle ne portait plus rien.

> **La trace est le cœur de la demande.** Une commande annulée dont les plats étaient
> déjà partis en cuisine devient un **RETOUR** : `envoye_le` renseigné + commande
> `ANNULEE`, exactement le discriminant du § Retours de `CLAUDE.md`. Vider une table
> n'efface donc jamais ce qui a été produit — ça apparaît à la clôture, sur le ticket
> Z, dans Mes ventes et en Supervision, avec **le motif et le manager** relus dans le
> journal d'audit. Un plat tapé mais **jamais envoyé en cuisine** n'est pas un retour
> (rien n'a été produit) : sa trace est l'entrée d'audit, comme avant.

**Dans la caisse** :

- **Plan de salle** : une corbeille sur chaque table occupée (et sur toute table restée
  marquée occupée en base). Elle ouvre la confirmation qui va bien : simple sur une
  table vide, PIN manager + motif dès qu'il y a des produits, montant annulé affiché
  dans le titre. Les tables virtuelles (Yango, Glovo, Kdo) en sont exclues : elles
  portent plusieurs commandes à la fois, on y annule commande par commande.
- **Écran commande** : troisième bouton à côté de Remise et Facture — **« Libérer »**
  s'il n'y a rien de tapé (aucun PIN), **« Vider »** sinon (PIN manager + motif). Il est
  volontairement **loin du bouton Encaisser**.

### 2. Les commandes à emporter ont enfin un endroit

`GET /api/commandes/ouvertes` renvoie désormais `code_commande`, `partenaire` et surtout
**`nb_items`** (une commande sans article est une commande ouverte par erreur, écartée
partout, § entrée du 18/08). Type partagé `CommandeEnCoursVue`.

Elles sont visibles à **trois endroits**, tous les trois sur le chemin du caissier :

1. **Plan de salle → pseudo-zone « À emporter »**, sous les zones de la salle, avec son
   compteur. Une carte par commande (code, statut, montant, ancienneté) ; on la touche
   pour la reprendre, imprimer la facture ou encaisser. Toujours affichée, même vide :
   c'est un endroit, il ne doit pas se déplacer.
2. **Coup d'œil salle** : une ligne « À emporter — n ».
3. **Accueil → Nouvelle commande → À emporter** : s'il y en a déjà en cours, la liste
   s'affiche **avant** d'en créer une nouvelle. C'est là que naissaient les doublons,
   c'est là qu'on les arrête. La tuile Tables l'annonce aussi (« Plan de salle · n à
   emporter »).

### Tests

`apps/server/test/liberer-table.test.ts` (7 tests) : libération sans PIN d'une table
vide, refus sans PIN puis sans motif quand il y a des produits, libération complète
avec sa trace d'audit nominative, **présence du plat lancé dans les retours du jour**,
et la liste des commandes à emporter avec `nb_items`.

**À faire pour déployer** : rebuild caisse + relancer l'exe. **Aucune migration.**

---

## 2026-08-18 — `preparer-base-master.sql` refuse de tourner sur le cloud

**Fichier** : `scripts/preparer-base-master.sql`.

Ce script purge les ventes, l'équipe et l'identité d'une base pour en faire un
master neutre. Le 18/08 il a été lancé **par erreur dans l'éditeur SQL Supabase**,
c'est-à-dire sur la base **CLOUD** — celle des 7 restaurants à la fois.

Il s'est arrêté seul sur `appels_table`, une table locale absente du cloud : la
transaction n'a jamais atteint son `COMMIT`, donc rien n'a été effacé. **C'est un
hasard, pas une protection.** Une table de plus dans le cloud et les 7 sites
perdaient leurs ventes.

Le script commence désormais par un bloc `DO` qui **refuse explicitement de
s'exécuter**, AVANT le moindre `DELETE` :

- si `sites_autorises` existe → c'est le cloud, refus ;
- si `restaurant`, `appels_table` ou `sync_outbox` manquent → ce n'est pas une base
  POS locale complète, refus.

Le message nomme la base concernée, pour qu'on voie tout de suite où on était.

**À faire pour déployer** : rien — un script d'outillage, lu au moment où on s'en
sert. Il doit simplement être **sur la clé** dans cette version.

---

## 2026-08-21 — Le pont inventaire : un snapshot produit sur chaque ligne

**Fichiers** : `apps/server/drizzle/0026_inventaire_snapshot_produit.sql`,
`apps/server/src/db/schema/index.ts`,
`supabase/functions/_shared/samtrackly-{api,shift,detail,inventaire,rattrapage}.ts`
(+ leurs tests), `supabase/functions/samtrackly-points/index.ts`,
`supabase/migrations/{20260817140000_pont_samtrackly,20260821150000_inventaire_snapshot_produit}.sql`,
`supabase/config.toml`, `scripts/diagnostic-pont-samtrackly.sql`.

> **Ce travail a été fait sur le Mac, pas sur le 7E.** Contrairement aux six
> entrées précédentes, il n'a **jamais tourné sur un vrai service**. Il passe
> d'abord une journée sur le 7E avant de partir sur la clé master — c'est le rôle
> du site de test, et une migration de base ne s'improvise pas sur 6 restaurants.

### Le problème

`CATALOGUE_INVENTAIRE` ne porte que des `code` : chaque mini-PC sème donc
`produits_inventaire` avec **ses propres uuid**, générés localement. Deux sites
n'ont pas le même id pour « Pain chawarma ». Or le cloud reçoit
`inventaire_lignes.produit_id` — un uuid local qu'il ne sait traduire avec **rien**,
sa table `produits_inventaire` étant une table de DESCENTE, jamais remontée.

Constaté le 21/08 : **4 services transférés ont écrit chez SamerTrackly un
inventaire « validé, 0 à déduire »** dont les **34 lignes avaient toutes été
écartées**, faute de correspondance. Un inventaire vide d'apparence saine lève la
bannière « Inventaire du jour requis » en affirmant qu'il n'y a rien à retenir sur
la paie. C'est une erreur d'argent, silencieuse.

### Le correctif

- **Migration 0026** : `produit_code`, `produit_nom`, `produit_prix` sur
  `inventaire_lignes` (et `produit_code`/`produit_nom` sur `entrees_stock`),
  remplis par **trigger** à chaque écriture. Le `produit_prix` retenu est celui qui
  a servi au **comptage**, pas celui du catalogue au moment du transfert.
- La migration **rattrape l'existant** puis **réinjecte les lignes corrigées dans
  `sync_outbox`** : l'historique déjà monté est republié avec son snapshot, sinon
  les inventaires passés restaient intraduisibles à jamais.
- Côté cloud, `20260821150000` ajoute les mêmes colonnes.
- Le pont **refuse d'écrire un inventaire dont aucune ligne ne se traduit** — mieux
  vaut un transfert en échec, visible et rejouable, qu'un « 0 à déduire » mensonger.

### À faire pour déployer

1. **`pnpm db:migrate`** sur le poste — seule entrée de ce journal qui l'exige.
2. Appliquer les **2 migrations cloud** (`supabase/migrations/`).
3. Déployer l'Edge Function **`samtrackly-points`** — et la **vérifier par
   `functions download` dans un dossier jetable**, jamais par `functions list`
   (voir le piège de l'entrée du 17/08).
4. Relancer l'exe. **Pas de rebuild caisse** : aucun fichier de `apps/caisse` n'est
   touché par cette entrée.

---

## Procédure de report sur les autres sites

0. **Récupérer l'arbre fusionné.** Depuis le 21/08 le code de référence n'est plus
   celui du 7E seul : les 7 correctifs du site ont été fusionnés sur le Mac avec le
   pont inventaire, et poussés sur **GitHub (`Ripiti225/SAMER-pos`, branche `main`)**.
   Le 7E part donc de là — la clé, en NTFS, est en lecture seule côté Mac et ne peut
   plus servir de courroie de retour. Sur le poste : récupérer `main`, puis
   `pnpm install`, **`pnpm db:migrate`** (la 0026 est nouvelle pour lui), `pnpm test`.
1. **Sur ce poste master (7E)** : `pnpm --filter caisse build` — sans ça le kiosque
   sert un vieux `dist`.
2. Refaire la clé USB **depuis une base repassée par `preparer-base-master.sql`**
   (identité `A_CONFIGURER` + les 2 comptes propriétaire seulement). **Ne jamais
   copier la base du 7E telle quelle** : elle porte son identité, ses 17 utilisateurs
   et sa `cle_site`, qui partiraient sur tous les autres restaurants.
3. Vérifier que `enroler-ce-poste.bat` est bien à la racine du dossier copié.
4. Sur le site cible, suivre la procédure d'enrôlement en 4 étapes rappelée plus haut.
5. `node_modules` sans liens symboliques (`nodeLinker: hoisted`), clé en **NTFS**,
   PostgreSQL **arrêté** au moment de la copie.

## Points ouverts

- **Sécuriser la clé `service_role` SamerTrackly** — demandé le 2026-08-13, toujours en
  attente. La console siège ouvre la voie pour la sortir du `.env` des postes.
- **Console siège** (`apps/siege`) : écrite, **rien n'est encore déployé**.
- Ligne orpheline `SAMER_ANGRE7E` dans `sites_autorises` (test du 05/07), sans effet,
  à supprimer un jour.
- Trou connu dans le catalogue de permissions : **Dépenses / Inventaire / Pointage**
  n'y figurent pas encore.
- **Le pont inventaire (0026) attend sa journée sur le 7E.** Décidé le 21/08 : il ne
  part sur la clé master qu'après avoir tourné sur un vrai service. Tant que cette
  ligne est là, **ne pas graver de nouvelle clé**.
- `pnpm-lock.yaml` : le lock du 7E référençait un workspace `apps/siege` qui n'existe
  dans aucun arbre. Le lock retenu est celui du Mac, sans ce bloc. Si un
  `pnpm install --frozen-lockfile` ronchonne sur un poste, c'est de là que ça vient.

---

## 2026-08-25 — Stock à l'instant T : tirer le stock sans rien clôturer

**Fichiers** : `apps/server/src/modules/inventaire/etat-stock.ts` (nouveau),
`modules/inventaire/routes.ts`, `printer/PrinterService.ts`, `printer/ConsolePrinter.ts`,
`printer/escpos.ts`, `apps/caisse/src/screens/Inventaire.tsx`,
`packages/shared/src/{types,constantes}.ts`.

**Le problème** : « combien il me reste de pain, là, maintenant ? » — la question du
gérant qui passe commande à 16 h. L'écran d'inventaire n'y répondait pas : il est fait
pour le comptage de fin de service, pas pour la lecture.

Un bouton **« Stock à l'instant T »** dans l'en-tête de l'écran Inventaire tire une
photo, présentée comme une facture — nom à gauche, stock à droite, points de conduite
entre les deux, détail (initial / entrées / sorties) en petit dessous. Le même papier
sort sur l'imprimante de la caisse.

- **Lecture pure** : ne valide rien, ne fige rien, la clôture n'avance pas d'un pas.
  Reste accessible même après validation de l'inventaire.
- Le chiffre de droite est le **compté** dès qu'il est saisi, sinon le théorique. Les
  lignes théoriques sont annoncées en tête et marquées d'une `*` sur le papier.
- Les lignes de consommation sont exclues : ce sont des sorties calculées, pas de la
  marchandise en réserve — les imprimer compterait deux fois le même stock.

**Pour déployer** : rien de particulier. **Rebuild caisse obligatoire** (`apps/caisse`
a changé), puis relancer l'exe.

---

## 2026-08-25 — Contact client des livraisons partenaires

**Fichiers** : migration **0027**, `apps/server/src/modules/commandes/routes.ts`,
`modules/services/rapport.ts`, `modules/audit/audit.ts`, `printer/{ConsolePrinter,escpos}.ts`,
`apps/caisse/src/screens/Commande.tsx`, `packages/shared/src/{types,schemas}.ts`,
côté cloud `supabase/migrations/20260825030000_livraisons_partenaires.sql`,
`supabase/functions/_shared/tables.ts`, `supabase/functions/siege/index.ts`,
`apps/siege/src/{api.ts,components/TicketZ.tsx,screens/TableauBord.tsx}`.

**Le problème** : une course Yango, Glovo ou Samer Delly partait en cuisine sans rien
qui permette de la rattacher à un client. `ref_partenaire` existait depuis le début
mais **aucun écran ne le demandait**, et le numéro du client n'était nulle part : un
litige (« cette commande n'est jamais arrivée ») se réglait de mémoire.

Au clic sur « Envoyer en cuisine » d'une commande partenaire, une modale demande le
**n° de commande partenaire** et le **contact du client**. Elle s'ouvre **APRÈS
l'envoi** — la cuisine ne doit jamais attendre après un formulaire — et une seule
fois, si rien n'est déjà saisi. Le caissier peut **Fermer** : c'est un choix légitime,
et c'est pourquoi le ticket Z compte les commandes **et** les contacts.

```
Yango (5)                                 25 000 F
   contacts 4/5  no partenaire 5/5
```

Tant que rien n'est saisi, le panneau d'addition porte un bouton ambre « Contact client
manquant » : on peut y revenir tant que le shift est ouvert. Après clôture, le serveur
refuse — le Z est figé. Chaque saisie passe au journal d'audit (`INFOS_LIVRAISON`).

La console du siège montre le décompte **par caissier** (bloc « Livraisons partenaires
par caissier », trié par courses non rattachées).

**Pour déployer, dans cet ordre** :

1. `pnpm db:migrate` sur le poste — **la 0027 est obligatoire**, sans elle le serveur
   plante à la première commande partenaire (`contact_client` inconnue).
2. **Rebuild caisse** (`pnpm --filter caisse build`), puis relancer l'exe.
3. **Cloud** : passer `20260825030000_livraisons_partenaires.sql` dans l'éditeur SQL de
   pos-samer-cloud, **puis redéployer la fonction `siege`** (elle appelle la nouvelle
   `siege_livraisons_caissier`). Sans la migration, le bloc du siège arrive vide — pas
   en erreur.

**À savoir** : `contact_client` ne vaudra que pour les commandes **à venir**. Les lignes
déjà montées au cloud ne sont pas republiées, elles resteront à NULL.

## 2026-08-28 — Le billet reçu, la monnaie rendue, et le fond de monnaie

Trois choses tenaient en une seule plainte : « le champ nombre, on ne voit que les
premiers chiffres », « on ne peut pas taper la somme reçue directement sur l'écran
sans clavier », et « le reçu ne garde aucune trace de ce que le client a donné ni de
ce qu'on lui a rendu ».

**Le champ était condamné par sa mise en page.** « Reçu du client » était un `<input>`
posé en `flex-1` sur une ligne partagée avec son étiquette et la monnaie calculée : dès
que la monnaie s'affichait, la case rétrécissait et coupait le nombre au troisième
chiffre. Surtout, c'était un champ texte sur un **kiosque sans clavier** — le pavé
numérique de l'écran n'alimentait que « Montant ». Le champ était donc, en pratique,
impossible à remplir.

Il est remplacé par **deux cases que le pavé peut viser**. On appuie sur « À encaisser »
ou sur « Reçu du client » pour choisir où tapent les chiffres ; la case active porte la
bordure de marque. Les cases prennent toute la largeur et **la police rétrécit au lieu
de tronquer** : un chiffre saisi est toujours un chiffre lu. `C` et la touche d'effacement
suivent la case active, comme les chiffres.

Sur « Reçu du client », les raccourcis deviennent les **coupures qui circulent
réellement** — +500, +1 000, +2 000, +5 000, +10 000 — plus un bouton **Compte juste**
qui recopie le montant. On appuie sur ce que le client a posé au lieu de composer
1-0-0-0-0. La monnaie à rendre s'affiche en grand, en vert ; si le billet ne couvre pas
la note, elle passe au rouge (« Il manque … ») et l'encaissement est bloqué : on
n'enregistre pas un rendu négatif.

**La trace, ensuite.** `paiements` porte deux colonnes (migration **0030**) :
`montant_recu` et `monnaie_rendue`. La caisse ne transmet **que le billet** — le rendu
est calculé par le serveur, comme tout montant, et un `CHECK` en base interdit qu'il
mente (`monnaie_rendue = montant_recu − montant`, et `montant_recu >= montant`). Les
deux colonnes restent NULL hors espèces, et NULL sur tout l'historique : la monnaie
rendue avant aujourd'hui n'a jamais été saisie, on ne l'invente pas.

Les deux lignes s'impriment sous le mode de paiement, sur le **ticket**, sur le **reçu
individuel** d'un paiement par articles et sur le **reçu PDF** du QR — la même pièce
partout. Sans elles, un « je vous ai donné 10 000 » n'avait rien à lui opposer.

**Le fond de monnaie, enfin.** Rendre la monnaie ne crée **ni vente ni écart de
caisse** : le billet entre dans le tiroir à l'instant où la monnaie en sort. Le chiffre
ne sert qu'à une chose — savoir de combien de petites coupures un restaurant a besoin
pour travailler. Il apparaît :

- sur le **ticket Z**, sous les dépenses, marqué « hors vente et hors écart » ;
- sur le **récap de séquence**, par caissier puis en total de la journée, avec
  « à prévoir en coupures demain » ;
- sur l'écran **Fermeture de séquence**, à côté des Kdo et des dépenses ;
- sur **Supervision**, en bande « Monnaie à prévoir » : moyenne, pire journée, et le
  montant recommandé.

`GET /api/rapports/besoin-monnaie?jours=14` (permission `rapports.z`) rend le détail
journée par journée. Le regroupement se fait sur la **journée d'exploitation** du shift
(sa date d'ouverture), pas sur l'horloge : un service 16h→01h reste une seule journée.
La recommandation cale sur la **pire journée observée**, arrondie au multiple de 5 000 F
supérieur — tenir la moyenne laisserait la caisse à sec un jour sur deux. Elle ne se
calcule que sur les journées qui portent la trace : `jours_traces` compte celles-là, et
une journée à 0 F d'avant aujourd'hui veut dire « non renseigné », pas « aucune monnaie
rendue ».

**Pour déployer, dans cet ordre** :

1. `pnpm db:migrate` sur le poste — la **0030** ajoute les deux colonnes et le `CHECK`.
2. **Rebuild caisse** (`pnpm --filter caisse build`), puis relancer l'exe.
3. **Cloud** : passer `supabase/migrations/20260828000000_monnaie_rendue.sql` dans
   l'éditeur SQL de pos-samer-cloud, **puis redéployer `sync-push`** (les deux colonnes
   sont ajoutées à `_shared/tables.ts`). Sans la migration, les paiements du poste mis à
   jour sont refusés et l'outbox s'accumule.

**À savoir** : la trace ne vaut que pour les encaissements **à venir**, et seulement si
le caissier saisit le billet. Rien n'est obligatoire — un caissier qui ne tape pas le
billet enregistre un paiement sans trace, exactement comme avant. C'est voulu : mieux
vaut pas de trace qu'une trace inventée.

## 2026-08-28 — Deux correctifs sur le paiement par articles

**Le partage était devenu obligatoire.** Depuis la 0028, l'écran de paiement exigeait
une sous-note avant de laisser encaisser : `resteCible` valait 0 tant qu'aucune note
n'était sélectionnée, et le bouton « Ajouter » restait éteint. Le caissier ne pouvait
donc plus régler une addition d'un bloc — il devait passer par « Payer par articles »
même pour un client seul. C'était un défaut de l'ÉCRAN seul : le serveur, lui, a
toujours accepté un encaissement sans `note_id` (il crée alors tout seul une sous-note
couvrant le ticket entier, pour que les quantités payées soient tracées comme dans un
partage).

L'écran distingue désormais les deux situations. Une sous-note unique qui couvre le
ticket entier est de la **comptabilité interne** : ni pastilles de convives, ni
sélection réclamée, l'ardoise dit simplement « Reste à payer ». Un partage RÉEL —
plusieurs notes, ou une note qui ne couvre pas tout — affiche les pastilles et exige
qu'on choisisse qui on encaisse. « Payer par articles » redevient ce qu'il devait être :
un bouton sur lequel on appuie **quand on en a besoin**.

L'invariant dont dépend cette distinction (`note.montant === commande.total` pour la
note implicite) est désormais tenu par deux tests dans
`apps/server/test/paiement-par-articles.test.ts` — s'il se rompait, le caissier
retomberait à devoir sélectionner un convive pour un ticket qui n'en a qu'un.

**Le reçu individuel sortait minuscule.** `imprimerSousNote` avait sa propre mise en
page, écrite à la main : pas de logo, pas d'entête, pas de code commande en gros, et
surtout les articles et le TOTAL en caractères NORMAUX là où un ticket les imprime en
double hauteur. À côté d'un vrai reçu, il avait l'air d'un brouillon.

Il emprunte maintenant **exactement** le chemin du ticket : `entete` puis
`corpsArticles`, sur une vue restreinte à la sous-note. Cette vue est une fonction pure
partagée, `vueSousNote` dans `packages/shared/src/recu.ts` — le PDF du QR l'utilisait
déjà sous une forme recopiée, il utilise maintenant la même. Le repli console suit
(`lignesRecu`, partagée ticket / sous-note). Conséquence voulue : **toute évolution du
reçu profite aux deux sans qu'on y pense**, et aucune ne pourra plus oublier le reçu
individuel.

Rien à migrer, rien à passer au cloud : `pnpm --filter caisse build` puis relancer l'exe.

## 2026-08-28 — Le pavé de paiement tenait mal, et deux opérateurs portaient la mauvaise couleur

**La dernière rangée du pavé n'était pas affichée.** Le poste de caisse est en
**1024 × 768**, ce qui laisse 672 px à la grille de paiement une fois l'entête et les
marges retirés. La colonne du milieu en réclamait bien davantage : sept tuiles de mode
sur trois colonnes (3 × 84 px = 252 px) et quatre rangées de touches à
`min-height: 64px` — 280 px **incompressibles**, imposés par la classe `.touche` du
thème. Le parent étant en `overflow-hidden`, le surplus n'était pas repoussé, il était
**découpé** : d'où une rangée absente plutôt qu'écrasée.

Les modes passent sur **quatre colonnes** (deux rangées de 68 px) et les rangées du pavé
**se partagent** désormais la place restante, avec un plancher de 44 px posé en style en
ligne — qui bat la classe à coup sûr, sans parier sur l'ordre des feuilles de style.

**Un second piège, plus sournois** : les trois colonnes ne s'affichaient côte à côte
qu'à partir de `lg`, soit **1024 px** — exactement la largeur du poste. À un pixel près,
tout s'empile sur une colonne et déborde massivement ; une barre de défilement (1024 − 15
= 1009) suffisait à basculer dedans, et le piège se referme seul : ça déborde, donc une
barre apparaît, donc ça déborde plus. Le seuil passe à `md` (768 px) : le kiosque est
maintenant largement au-dessus au lieu d'être en équilibre dessus. Un `overflow-y-auto`
sur la colonne sert de filet — pas de fonctionnalité : l'assurance que plus rien ne
pourra jamais être invisible sans qu'une barre le dise.

**Moov et Djamo portaient la mauvaise couleur.** La règle du § 4.2 est la couleur de la
MARQUE — Wave au bleu, Orange Money à l'orange, MTN au jaune, Moov au vert, Djamo au
noir. Deux jetons ne la respectaient pas : `--pay-moov` était **bleu** (`#0057b8`) et
`--pay-djamo`, ajouté après la rédaction du tableau, **violet** (`#6d28d9`). Corrigés en
`#00a94f` et `#101828`. Le commentaire de `Paiement.tsx` annonçait « le caissier
reconnaît Wave au violet » — faux depuis toujours, et probablement ce qui a laissé
passer les deux.

Djamo est le seul aplat qui ne traverse pas les deux modes : un noir disparaît sur fond
sombre. Il s'y inverse en blanc cassé (`#e6eaf2`), et le vert de Moov y remonte d'un cran
(`#2fbf6a`) sans quoi il vire au sapin boueux. Le tableau du § 4.2 de `DESIGN_V2.md` porte
désormais la colonne « aplat en sombre » et la ligne Djamo qui manquait.

Les jetons vivent dans `packages/theme/theme.css` et n'ont que deux consommateurs, tous
deux par variable CSS : la caisse et la console du siège. Une seule correction suffit
donc pour les deux — et **jamais de couleur en dur dans un écran**.

**Et la couleur ne s'affichait qu'APRÈS le clic.** Elle ne servait donc qu'à marquer la
sélection, alors que le § 4.2 demande l'inverse : « le caissier reconnaît le bouton à la
couleur **avant** de lire le mot ». Une couleur qui n'apparaît qu'une fois le choix fait
n'aide plus à choisir.

Les sept tuiles portent désormais leur couleur **en permanence** — aplat très dilué (8 %)
et filet teinté, pour que la marque se reconnaisse sans que sept tuiles crient ensemble.
La sélection se lit maintenant à l'**aplat plein** avec halo, et non plus à l'apparition
de la couleur.

Cet aplat plein a réveillé la colonne « texte sur aplat » du § 4.2, écrite dès l'origine
mais jamais utilisée faute d'aplat : elle devient un jeu de jetons `--pay-*-sur`. Ce
n'est pas toujours du blanc — sur le cyan de Wave et le jaune de MTN, seule une encre
sombre se lit. Le LIBELLÉ, lui, garde l'encre normale quand la tuile n'est pas
sélectionnée : « MTN MoMo » écrit en jaune sur blanc serait illisible. C'est l'icône et
le filet qui portent la reconnaissance, pas le texte.

**Point ouvert** : Espèces (`#16a34a`) et Moov (`#00a94f`) sont deux verts, et la grille
à quatre colonnes les place l'un SOUS l'autre (positions 1 et 5). Tant que la couleur
n'apparaissait qu'à la sélection, les deux n'étaient jamais visibles ensemble ; ce n'est
plus le cas. Espèces est la seule tuile dont la couleur n'est pas imposée par un
partenaire — c'est donc elle qui peut bouger, si le gérant juge la confusion réelle.

Rien à migrer, rien à passer au cloud : `pnpm --filter caisse build` puis relancer l'exe.
Attention, `packages/theme` a changé : sur la clé, relancer `propager-paquets.ps1`.

## 2026-08-29 — Le pavé numérique volait les frappes des champs de saisie

Deux plaintes du terrain, une seule cause.

**« Lors des annulations de tables, espace valide alors qu'on n'a pas mis toute
l'explication. »** Le gérant tape son motif ; au premier espace entre deux mots,
l'annulation part — avec une explication tronquée, et sans même que l'espace ait été
inséré dans le texte.

**« Quand on veut taper le montant d'une remise, c'est le code qui se remplit. »** Chaque
chiffre frappé dans « Montant (FCFA) » atterrissait dans le PIN. Or un montant est un
chiffre : il n'y avait aucun moyen d'en saisir un au clavier.

Le `Numpad` écoutait le clavier sur la **fenêtre entière** (`window.addEventListener`)
sans jamais regarder où se trouvait le curseur. Dans la modale PIN manager — celle des
annulations et des remises — il y a pourtant deux champs texte au-dessus du pavé. Le pavé
les vidait de leurs frappes : les chiffres partaient dans le PIN, `preventDefault()`
empêchait l'espace d'être écrit, et la branche de validation acceptait l'espace au même
titre qu'Entrée.

Deux corrections dans `apps/caisse/src/components/Numpad.tsx` :

- une garde sur la cible de l'événement — si le curseur est dans un `INPUT`, un
  `TEXTAREA` ou un bloc éditable, le pavé se tait **complètement** (chiffres, Retour
  arrière, Échap et Entrée) ;
- l'espace ne valide plus jamais. Seul Entrée valide, et seulement hors champ de saisie.

L'espace est un caractère de texte avant d'être un raccourci : sur un formulaire où l'on
demande une explication écrite, en faire une validation garantit qu'on valide à moitié.

Audit des deux autres écouteurs clavier globaux de la caisse : `Paiement.tsx` avait déjà
la garde, `Login.tsx` n'affiche aucun champ de saisie. Rien d'autre à corriger.

Rien à migrer, rien à passer au cloud : `pnpm --filter caisse build` puis relancer l'exe.
