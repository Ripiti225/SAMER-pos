# Commandes à passer sur un poste

Note d'exploitation : ce qu'on tape sur le mini-PC d'un restaurant, et pourquoi.

Sur un poste il n'y a **ni `pnpm`, ni Node installé, ni PostgreSQL installé** : tout est
portable, dans le dossier `POS-Samer\`. D'où des commandes qui ne ressemblent pas à
celles du dépôt.

---

## La règle qui fait rater la moitié des commandes

**Tout se lance depuis la RACINE du dossier portable** — celui qui contient `runtime`,
`app`, `data` et `PosSamer.exe`. Les chemins commencent par `.\runtime\...` et ne veulent
rien dire ailleurs.

```powershell
cd C:\POS-Samer          # ou le vrai chemin du poste
```

> Le chemin change d'un poste à l'autre (`C:\POS-Samer`, `C:\Users\...\Documents\POS\POS-Samer`…).
> Pour le retrouver sans le connaître, depuis n'importe où dans l'arborescence :
> ```powershell
> $r=(Get-Location).Path; while($r -and -not(Test-Path "$r\runtime\pgsql\bin\psql.exe")){$r=Split-Path $r -Parent}; if($r){cd $r; "Racine: $r"} else {"Pas dans un dossier POS-Samer"}
> ```

**Une seule commande fait exception** : celle des migrations, qui descend dans
`app\apps\server` — et t'y laisse. Après elle, `cd ..\..\..` pour remonter.

Deux autres pièges de PowerShell :

- **Coller une seule ligne à la fois.** Un collage multi-ligne fait apparaître `>>` :
  PowerShell attend la suite. Appuyer sur Entrée pour vider.
- **Ce sont des commandes PowerShell, pas du `.bat`.** `set "PATH=..."` et `%PATH%` ne
  marchent pas ici ; c'est `$env:Path`.

---

## Démarrer et arrêter la base toute seule

`PosSamer.exe` démarre la base **et** le serveur POS **et** la caisse. Pour une opération
de maintenance on veut la base **seule** : rien ne doit écrire pendant qu'on travaille
dessus.

```powershell
.\runtime\pgsql\bin\pg_ctl.exe -D "$PWD\data\pgdata" -l "$PWD\data\pg.log" -w start
```

Attendu : `serveur démarré`.

```powershell
.\runtime\pgsql\bin\pg_ctl.exe -D "$PWD\data\pgdata" -m fast -w stop
```

> **Toujours arrêter la base avant de relancer `PosSamer.exe`.** S'il la trouve déjà
> démarrée à la main, son propre démarrage part de travers.

Si une commande répond `Connection refused ... port 5432`, c'est que la base n'est pas
lancée : soit `PosSamer.exe` est ouvert, soit on la démarre comme ci-dessus.

---

## Vider les transactions en gardant les réglages et les comptes

Sert à remettre un poste à zéro commercialement — fin de tests, reprise d'un site —
**sans le reconfigurer**.

> À ne pas confondre avec `scripts\preparer-base-master.sql`, qui va bien plus loin :
> il efface aussi l'équipe, l'identité du restaurant et les noms d'imprimante, parce
> qu'il fabrique l'image neutre destinée à tous les sites.

### Ce qui part, ce qui reste

| Effacé | Conservé |
|---|---|
| commandes, lignes de commande, paiements | comptes, rôles, sessions |
| notes partagées, notations, appels de table | **tous** les réglages : imprimantes, entête et pied de ticket, clé de site, calibration |
| points de fidélité | **fiches** clients de fidélité (les points repartent de zéro, le client reste) |
| services de caisse et leur équipe, séquences de caisse | identité du restaurant (nom, marque, couleur, identifiant) |
| inventaires de service, entrées de stock, dépenses | catalogue, plan de salle |
| file de synchro, journal d'audit | produits d'inventaire et leurs recettes |
| les 3 compteurs repartent à 1 → prochain ticket n° 1 | |

### La marche à suivre

**0.** Base démarrée seule (voir plus haut), personne sur la caisse.

**1. Sauvegarde — ne pas sauter cette étape.**

```powershell
.\runtime\pgsql\bin\pg_dump.exe -U postgres -d pos_samer -F c -f "$PWD\sauvegarde-avant-purge.dump"
```

Vérifier que le fichier existe et n'est pas vide avant de continuer :

```powershell
Get-Item .\sauvegarde-avant-purge.dump | Select-Object Name, Length, LastWriteTime
```

**2. La purge.**

```powershell
.\runtime\pgsql\bin\psql.exe -U postgres -d pos_samer -v ON_ERROR_STOP=1 --single-transaction -c "DELETE FROM points_fidelite; DELETE FROM paiements; DELETE FROM notes_split; DELETE FROM commande_items; DELETE FROM notations; DELETE FROM appels_table; DELETE FROM commandes; DELETE FROM entrees_stock; DELETE FROM inventaire_lignes; DELETE FROM inventaires_service; DELETE FROM depenses; DELETE FROM equipe_service; DELETE FROM services_caisse; DELETE FROM sequences_caisse; DELETE FROM sync_outbox; DELETE FROM actions_recues; DELETE FROM sync_etat; ALTER TABLE audit_log DISABLE TRIGGER audit_immutable; DELETE FROM audit_log; ALTER TABLE audit_log ENABLE TRIGGER audit_immutable; ALTER SEQUENCE seq_numero_ticket RESTART WITH 1; ALTER SEQUENCE audit_log_seq_seq RESTART WITH 1; ALTER SEQUENCE sync_outbox_seq_seq RESTART WITH 1"
```

`--single-transaction` avec `ON_ERROR_STOP=1` : **tout passe, ou rien n'est effacé.** Il
n'y a pas d'état intermédiaire où la moitié des ventes serait partie.

**3. Contrôle.** Première moitié à zéro, seconde moitié intacte.

```powershell
.\runtime\pgsql\bin\psql.exe -U postgres -d pos_samer -c "SELECT (SELECT count(*) FROM commandes) AS commandes, (SELECT count(*) FROM paiements) AS paiements, (SELECT count(*) FROM services_caisse) AS shifts, (SELECT count(*) FROM audit_log) AS audit, (SELECT count(*) FROM utilisateurs) AS comptes, (SELECT count(*) FROM parametres_locaux) AS reglages, (SELECT count(*) FROM articles) AS articles, (SELECT code FROM restaurant) AS identite"
```

**4.** Arrêter la base, relancer `PosSamer.exe`.

### Pourquoi ces tables-là, dans cet ordre

L'ordre n'est pas cosmétique : il suit les **clés étrangères**. Supprimer une ligne encore
référencée ailleurs fait échouer la transaction entière.

- **`points_fidelite` en premier.** Elle référence `commandes` **et** `notes_split`. Tant
  qu'elle porte des lignes, la suppression de l'une ou l'autre échoue.
- **`note_split_items` n'est pas dans la liste** : elle est en `ON DELETE CASCADE` sur
  `notes_split`, donc emportée automatiquement.
- **`entrees_stock`, `inventaire_lignes`, `inventaires_service`, `depenses`,
  `equipe_service`** sont en cascade sur `services_caisse`. Elles sont écrites quand même,
  pour ne pas dépendre d'une cascade qu'un futur changement retirerait en silence.
- **`produits_inventaire` et `inventaire_consommations` ne sont JAMAIS touchées** : ce
  sont des réglages — le catalogue de ce qu'on compte et les recettes. Les effacer
  casserait le calcul d'écart d'inventaire.
- **`sync_outbox` est vidée** sinon le poste remonterait au cloud des lignes dont
  l'original vient d'être effacé ici.
- **`audit_log`** est protégée par un déclencheur append-only (`audit_immutable`) qu'on
  désactive le temps de la purge — et qu'on **remet** juste après.
- **Les 3 séquences** ne sont pas touchées par les `DELETE` : sans le `RESTART`, le
  premier ticket après la purge reprendrait le numéro d'avant.

> ⚠️ **Ce qui est déjà monté au cloud n'est pas effacé là-haut.** Cette purge ne touche
> que la base locale du poste. Les ventes déjà arrivées chez SamerTrackly y restent.

### Si ça tourne mal

La sauvegarde de l'étape 1 se restaure ainsi, base démarrée seule :

```powershell
.\runtime\pgsql\bin\pg_restore.exe -U postgres -d pos_samer --clean --if-exists ".\sauvegarde-avant-purge.dump"
```

---

## Appliquer les migrations

À faire sur **tout poste installé depuis une clé antérieure au 10/09/2026**, sinon la
caisse s'ouvre sur un **menu vide**, sans message d'erreur. C'est la panne du 10/09 :
deux migrations manquaient à la base de la clé, et le code lisait des colonnes qui
n'existaient pas encore.

Base démarrée (ou `PosSamer.exe` ouvert), **depuis la racine** :

```powershell
$env:Path = "$PWD\runtime\node;$env:Path"; cd app\apps\server; node "..\..\node_modules\tsx\dist\cli.mjs" "src\db\migrate.ts"
```

Attendu : `Migrations appliquées ✔`. Puis `cd ..\..\..`, arrêter la base, relancer l'exe.

**Sans risque et rejouable** : une base déjà à jour ne change pas. Dans le doute, la
lancer.

Pour vérifier où en est la base — doit donner **33** :

```powershell
.\runtime\pgsql\bin\psql.exe -U postgres -d pos_samer -c "SELECT count(*) FROM drizzle.__drizzle_migrations"
```

Un menu vide vient presque toujours de là. Pour lever le doute : si `count(*)` sur
`categories` renvoie des lignes alors que la caisse n'affiche rien, ce sont les colonnes
qui manquent, pas les produits.

```powershell
.\runtime\pgsql\bin\psql.exe -U postgres -d pos_samer -c "SELECT (SELECT count(*) FROM categories) AS cat, (SELECT count(*) FROM articles) AS art, (SELECT count(*) FROM commande_items) AS ventes"
```

---

## Mettre le code du poste à jour depuis la clé

`PosSamer.exe` **fermé**. Depuis la racine du poste, la lettre du lecteur est détectée
toute seule :

```powershell
$c = (Get-Volume -FileSystemLabel POSSAMER).DriveLetter; robocopy "${c}:\POS-Samer" "$PWD" /E /XJ /R:2 /W:2 /NP /XD "${c}:\POS-Samer\data" "${c}:\POS-Samer\app\node_modules"
```

> 🔴 **`data` est exclu, et ce n'est pas négociable.** C'est la base du restaurant, avec
> ses ventes et son identité. La recopier depuis la clé effacerait tout et remettrait le
> poste en `A_CONFIGURER`.

`node_modules` est exclu aussi : identique de part et d'autre, et 900 Mo à traverser l'USB
pour rien.

Pour ne copier **que les fichiers absents**, sans toucher à ce qui existe déjà, ajouter
`/XC /XN /XO`. Attention : le code déjà présent ne sera alors **pas** mis à jour.

**Cette copie ne fait pas revenir un menu vide** : elle apporte les fichiers, pas l'état
de la base. C'est la section des migrations qui corrige ça.

---

## Le cas À la Braise

Son menu **n'est pas** dans la base de la clé : le seed commun reste neutre. Il vit dans
`config\restaurants\a-la-braise\profil.json` et ne se charge que par un import dédié —
voir [INSTALLATION_A_LA_BRAISE.md](INSTALLATION_A_LA_BRAISE.md).

Piège : passer par **Réglages → Restaurant** avant l'import écrit
`restaurant.code = A_LA_BRAISE`, alors que le profil s'appelle `ALA_BRAISE` — sans le
premier tiret bas. L'import refuse alors le poste :

> `Ce poste appartient déjà au restaurant A_LA_BRAISE.`

Réaligner le code, puis importer (**avant toute vente**, l'import est refusé dès qu'une
ligne de commande existe) :

```powershell
.\runtime\pgsql\bin\psql.exe -U postgres -d pos_samer -c "UPDATE restaurant SET code='ALA_BRAISE'"
```

```powershell
$env:Path = "$PWD\runtime\node;$env:Path"; cd app\apps\server; node "..\..\node_modules\tsx\dist\cli.mjs" "src\scripts\importer-profil-restaurant.ts" --code=ALA_BRAISE
```

Passer par `ALA_BRAISE` plutôt que par `A_CONFIGURER` n'est pas cosmétique : quand les
codes correspondent, l'import **réutilise l'identifiant de restaurant existant** au lieu
d'en tirer un neuf — l'enrôlement cloud déjà fait reste valide. Relancer quand même
`enroler-ce-poste.bat` ensuite, il est idempotent.
