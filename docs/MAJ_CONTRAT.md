# Contrat site ↔ cloud de la mise à jour à distance

Fixé le 23/10/2026 avant les lots L1-L4, pour que le côté cloud (L1 + L2) et le côté
site (L3 + L4) puissent avancer en parallèle. Toute évolution de ce contrat se fait
ICI d'abord. Les formats de manifeste, signature, archive et journal sont ceux du lot
L0 (`apps/desktop/maj/*.cjs`, `index.d.cts`) — ce document ne les redéfinit pas.

## 1. Stockage (Supabase Storage, bucket PRIVÉ `paquets-pos`)

```
versions/<numero>/manifeste.json         octets EXACTS signés
versions/<numero>/manifeste.json.sig     signature Ed25519, base64
versions/<numero>/<nom du morceau>       un objet par morceau du manifeste
deps/<empreinte>/manifeste.json          paquet DEPENDANCES (même règles)
deps/<empreinte>/manifeste.json.sig
deps/<empreinte>/<nom du morceau>
```

## 2. Edge Function `maj` (authentifiée par clé de site, comme `ordres`)

`POST /functions/v1/maj`, corps JSON, toujours `cle_site`.

### `action: "consulter"`

Requête :
```json
{ "cle_site": "…", "action": "consulter",
  "installee": { "numero": 2026102301, "version": "2026.10.23-1" },
  "lanceur_numero": 3 }
```
Réponse 200 :
```json
{
  "cible": null | {
    "numero": 2026102401,
    "version": "2026.10.24-1",
    "manifeste": "<texte exact de manifeste.json>",
    "signature": "<base64>",
    "morceaux": [ { "nom": "code-00.part", "url": "<URL signée, 1 h>" } ],
    "dependances": null | {
      "empreinte": "<sha256>",
      "manifeste": "<texte exact>",
      "signature": "<base64>",
      "morceaux": [ { "nom": "deps-00.part", "url": "<URL signée, 1 h>" } ]
    }
  },
  "reglages": {
    "type_site": "FERME_LA_NUIT" | "H24",
    "heure_installation": "06:00",
    "heure_filet": "05:00",
    "pause": false,
    "installer_maintenant": null | "<jeton>",
    "reessayer": null | "<jeton>"
  },
  "migration_absente": false
}
```
- `cible` = la version que CE site doit avoir (résolution § 3.1 du plan : épinglée,
  sinon plus haute GENERALE, ou PILOTE/GENERALE pour l'anneau pilote ; jamais RETIREE).
  `null` si rien à faire ou si `cible.numero <= installee.numero`.
- `dependances` n'est rempli que si l'empreinte de la cible diffère de celle que le site
  annonce… le site ne l'annonçant pas, le cloud la renvoie TOUJOURS quand la cible en a
  une ; c'est le site qui compare avec `node_modules/.empreinte-deps` et ne télécharge
  que si elle diffère.
- `installer_maintenant` / `reessayer` : jetons opaques ; le site agit une seule fois
  par jeton (il retient le dernier jeton traité).
- Tables absentes (migration non passée) : `{ "cible": null, "reglages": <défauts>,
  "migration_absente": true }`, jamais une erreur.
- Clé de site invalide : 401. Le cloud ne vérifie PAS la signature pour le site : c'est
  le site (et le lanceur) qui la vérifient avec LEUR clé publique.

### `action: "rapporter"`

```json
{ "cle_site": "…", "action": "rapporter",
  "numero": 2026102401, "evenement": "INSTALLE", "detail": { … } }
```
Réponse `{ "ok": true }`. Événements :
`TELECHARGEMENT`, `PRET`, `AVERTI`, `REPORTE`, `DEBUT`, `INSTALLE`,
`ECHEC_RETOUR_ARRIERE`, `REFUSEE`, `BLOQUE`, `ESPACE_INSUFFISANT`,
`LANCEUR_TROP_ANCIEN`, `SIGNATURE_INVALIDE`, `ERREUR`.
`detail` : objet libre ≤ 8 Ko (cause, étape, durée de coupure, dernières lignes de
stderr…). Le cloud tronque au-delà.

## 3. Battement de cœur (déjà livré, champ ajouté)

Le corps de `sync-pull` porte déjà `sante` (lot « Santé des sites »). On y ajoute un
bloc FACULTATIF `sante.maj` — un ancien cloud l'ignore, un ancien site ne l'envoie pas :
```json
"maj": {
  "etat": "A_JOUR" | "TELECHARGEMENT" | "PRETE" | "REPORTEE" | "INSTALLATION" | "ECHEC" | "REFUSEE",
  "numero_installe": 2026102301,
  "numero_prete": 2026102401 | null,
  "installation_prevue": "<ISO>" | null,
  "report_jusqua": "<ISO>" | null,
  "derniere_erreur": "<texte court>" | null,
  "espace_libre_mo": 51234,
  "taille_pgdata_mo": 70,
  "integrite": { "suspects_grenam": 0 }
}
```
Le cloud (L1) stocke ce bloc dans `sites_sante` (colonnes à ajouter) et l'écran
« Santé des sites » l'affiche ; le site (L3) le remplit.

## 4. Fichiers locaux du site (`ROOT` = dossier de `PosSamer.exe`)

```
ROOT/maj/etat.json            écrit par le SERVEUR (atomique) : version prête, chemin,
                              créneau calculé, report, réglages reçus, jetons traités
ROOT/maj/installation.json    journal du LANCEUR (format L0)
ROOT/maj/telechargement/<n>/  morceaux en cours
ROOT/maj/pret/<n>/app/        arbre extrait et vérifié, prêt à échanger
data/sauvegardes/             sauvegardes de pgdata (nom L0 `nomSauvegarde`)
```
`etat.json` minimal :
```json
{ "format": 1, "pret": null | { "numero": …, "version": "…", "dossier": "maj/pret/<n>/app",
  "pret_le": "<ISO>", "manifeste": "<texte>", "signature": "<base64>",
  "dependances": null | { "empreinte": "…", "dossier": "maj/pret/deps-<e>/node_modules" } },
  "reglages": { …même forme que la réponse consulter… },
  "report": null | { "demande_le": "<ISO>", "par": "<utilisateur>" },
  "jetons_traites": { "installer_maintenant": null, "reessayer": null } }
```
Le lanceur revérifie TOUJOURS signature et empreintes avant d'installer : `etat.json`
n'est qu'une indication.

## 5. Routes locales serveur ↔ lanceur (localhost, jeton `POS_JETON_LANCEUR`)

- `POST /api/maj/lanceur/arret` → le serveur passe en 503 « Mise à jour en cours »,
  diffuse `maj_debut`, répond quand les requêtes en cours sont finies.
- `POST /api/maj/lanceur/valider` → le serveur sort du mode validation, démarre ses
  boucles, rapporte `INSTALLE`.
- `GET /api/sante/version` → `{ numero, version, commit }` de la version qui tourne.
- Mode validation : variable `POS_MODE_VALIDATION=1` passée par le lanceur au démarrage
  après échange → aucune boucle (synchro, ordres, SamerTrackly), 503 sauf `/api/sante*`
  et `/api/maj/*`.
- Côté caisse : `POST /api/maj/reporter` (PIN gérant, un seul report de 30 min),
  `GET /api/maj/etat` (bandeau), événements WebSocket `maj`, `maj_debut`, `maj_terminee`.
