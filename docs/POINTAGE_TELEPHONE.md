# Pointage par téléphone (sur le wifi du restaurant)

> Brief rédigé le 17/11/2026, **décisions prises et version 1 codée le 19/11/2026**
> (branche `feat/pointage-telephone`, partie de `main` GitHub du 06/11). Voir §9.

## 1. L'idée

Chaque travailleur pointe depuis **son propre téléphone**, avec **son propre compte**, à condition d'être **connecté au wifi du restaurant**. Le POS reçoit ces pointages comme il reçoit déjà ceux de la pointeuse, puis les fait remonter à Samtrackly par le pont habituel.

Deux règles demandées par le patron :
1. **Pointeuse OU téléphone, jamais les deux** pour un même pointage : le POS ne doit pas recevoir deux données à la fois.
2. **Un téléphone = un seul compte.** Si un téléphone a déjà servi pour un compte et qu'on essaie d'y mettre un 2ᵉ compte, un message s'affiche : « Ce téléphone est déjà rattaché à un compte. »

## 2. Ce qui existe déjà (vérifié le 17/11 dans les bases cloud)

### POS cloud (`pos-samer-cloud`), table `equipe_service`
Colonnes : `id, restaurant_id, service_id, utilisateur_id, poste_jour, pointe_le, reste, created_at, depart_le, secondes_absence, source`.
Index unique `(service_id, utilisateur_id)` : une seule ligne par personne et par service.

Valeurs de `source` sur les 14 derniers jours :

| Restaurant | Sources présentes |
|---|---|
| Al Kayan Yop | POINTEUSE (374), OUVERTURE (51) |
| Samer Palmeraie | POINTEUSE (326), OUVERTURE (108) |
| Samer Maroc | POINTEUSE (212), OUVERTURE (51), CAISSE (1) |
| Al Kayan KMS | POINTEUSE (43), OUVERTURE (11) |
| Samer Oasis | OUVERTURE seulement |
| Samer Angré 7E, Samer Lavage, À la Braise | source vide (POS plus ancien ?) |

Il y a donc **déjà une pointeuse branchée dans 4 restaurants**. Le pointage par téléphone doit passer par **le même chemin** que la pointeuse, avec une nouvelle valeur de source (`TELEPHONE`).

### Samtrackly, table `presences`
Elle a déjà `pointe_arrivee` et `pointe_depart` (timestamptz), remplis par le pont pour environ 1 083 lignes. **Côté Samtrackly, il n'y a rien à changer** tant que le téléphone écrit dans `equipe_service` exactement comme la pointeuse.

> ⚠️ Le code POS de ce Mac est périmé : le vrai code est sur le **master Windows**. Ce brief est à reprendre là-bas.

## 3. Architecture proposée

### Preuve « sur le wifi du restaurant »
Un site web **ne peut pas lire le nom du wifi** (le navigateur l'interdit). La solution :
**la page de pointage est servie par le mini-PC du POS lui-même**, par exemple `http://<ip-du-pos>/pointage`.
- Elle n'est joignable que depuis le réseau local du restaurant. Si la page s'ouvre, le téléphone est sur place.
- Elle fonctionne **sans internet**, comme le reste du POS.
- Le pointage est écrit directement dans la base locale, puis synchronisé normalement vers le cloud et Samtrackly.
- Si le mini-PC est éteint, personne ne peut pointer : le pointage manuel par le caissier (CAISSE / OUVERTURE) reste le **secours**.

À éviter : un site sur Vercel qui vérifierait l'adresse internet du restaurant. Ces adresses changent souvent et ce serait fragile.

### Connexion du travailleur
- Identifiant + PIN, comme dans le reste du POS (argon2id, verrou anti-force brute existant, audit `ECHEC_PIN`).
- Le compte = l'`utilisateurs` du POS déjà descendu depuis Samtrackly (matricule = identifiant du travailleur).

## 4. Garde-fou « un téléphone = un compte »

Une page web ne peut pas lire l'IMEI. On ne peut que déposer une **clé d'appareil** (aléatoire, générée par le serveur) dans le navigateur à la première connexion. Limites connues :
- Vider les données du navigateur, passer en navigation privée ou changer de navigateur (Safari ↔ Chrome) donne un téléphone qui paraît **neuf**.
- **iPhone / Safari** efface ces données après **7 jours sans visite**, sauf si l'icône est posée sur l'écran d'accueil. Pendant un congé, la clé peut donc se perdre.

Pour que le garde-fou tienne malgré ça, il faut un **verrou dans les deux sens, tenu par le serveur** :
1. **Appareil → compte** : une clé d'appareil connue et liée au compte A refuse le compte B. Message : « Ce téléphone est déjà rattaché à un compte. »
2. **Compte → appareil** : un compte déjà lié refuse toute autre clé d'appareil.
3. **Tout premier rattachement et tout changement de téléphone passent par une validation** du gérant (sur le POS) ou de la RH. C'est ce qui empêche le contournement « je vide mon navigateur et je pointe pour un collègue ».
4. Chaque rattachement, refus ou changement est écrit dans `audit_log`.

Table suggérée (côté POS local, avec écriture `sync_outbox` dans la même transaction) :
`appareils_pointage(id, utilisateur_id UNIQUE, cle_hash UNIQUE, libelle, statut EN_ATTENTE|ACTIF|REVOQUE, demande_le, valide_par, valide_le)`.
On ne stocke que le **hash** de la clé, jamais la clé en clair.

Faille restante : quelqu'un qui garde sur lui le téléphone d'un collègue absent. Pour la fermer, on peut prendre une **photo au moment du pointage**, visible par le gérant (option à décider).

## 5. Règle « pointeuse OU téléphone, pas les deux »

L'index unique `(service_id, utilisateur_id)` donne déjà le comportement naturel : **le premier pointage gagne**.
- Arrivée : si `pointe_le` est déjà rempli (pointeuse ou téléphone), le second pointage est refusé avec un message clair, par exemple « Déjà pointé à 8 h 02 (pointeuse) ».
- Départ : même règle sur `depart_le`.
- Alternative : une seule source autorisée par restaurant, réglée dans le POS (Réglages → Pointage : Pointeuse / Téléphone / Les deux, premier arrivé).

**À vérifier dans le code Windows** : comment la pointeuse gère un pointage quand **aucun service n'est encore ouvert** (`service_id` obligatoire). Le téléphone doit faire exactement pareil.

## 6. Décisions à trancher (à poser en QCM au patron)

1. Règle « pas les deux » : premier pointage gagne, **ou** une seule source par restaurant ?
2. Pointer **l'arrivée seulement**, ou **arrivée + départ** (+ pauses, puisque `secondes_absence` existe) ?
3. **Photo** au pointage : oui ou non ?
4. Qui valide un nouveau téléphone : le **gérant sur le POS**, la **RH dans Samtrackly**, ou les deux ?
5. Restaurants sans pointeuse (Oasis, 7E, Lavage, À la Braise) : y démarrer le téléphone en premier ?

## 7. Points de vigilance

- **Paies hors équipe** : un salaire versé à quelqu'un absent de `equipe_service` est perdu par le pont. Le téléphone doit donc écrire **dans `equipe_service`**, jamais dans une table à part.
- Toute action sensible passe par `audit_log` (append-only) et `sync_outbox` dans la même transaction.
- Interface et messages en **français courant**, boutons ≥ 48 px, pas de code technique affiché.
- La page doit rester ultra simple : connexion PIN → un gros bouton « Je pointe mon arrivée » / « Je pointe mon départ » → confirmation avec l'heure.

## 8. Côté Samtrackly

Rien à coder pour l'instant : `presences.pointe_arrivee` et `pointe_depart` existent déjà et sont remplis par le pont. Plus tard, si on veut savoir **d'où** vient chaque pointage (pointeuse / téléphone / caisse), il faudra ajouter une colonne `source_pointage` à `presences` et la faire passer par le pont.

## 9. Décisions du 19/11/2026 et version 1 codée

Décisions du patron :
1. **Pointeuse et téléphone actifs ensemble, le premier pointage gagne.** Le second est refusé avec l'heure et l'origine (« Votre arrivée est déjà pointée à 8 h 02 (à la pointeuse) »).
2. **Arrivée + départ**, pas de pause au téléphone. Après le départ, plus rien jusqu'au shift suivant.
3. **Premier téléphone rattaché automatiquement** ; un **changement** de téléphone attend le gérant (PIN manager).
4. **Selfie obligatoire** à chaque pointage, visible par le gérant.

Ce qui est codé :
- **Base** : migration `0051_pointage_telephone.sql`, avec la table `appareils_pointage` (empreinte de la clé du téléphone, statut ACTIF / EN_ATTENTE / REMPLACE / REFUSE), la table `photos_pointage` (selfie JPEG, purgé à 60 jours) et la source `TELEPHONE` dans `equipe_service`. Le miroir est fait dans `sql/schema.sql` et dans le schéma Drizzle.
- **Serveur** : module `modules/pointage-telephone/`. Les pointages passent par `appliquerEvenement` (même journal que la pointeuse, appareil `TELEPHONE:<id>`). Les arrivées pointées avant l'ouverture sont reprises à l'ouverture, **aussi sur un site sans pointeuse**. Toutes les actions sont tracées dans l'audit.
- **Page téléphone** : `http://<ip du mini-PC>:3001/pointage.html`, deuxième page de l'app caisse, sans nouveau programme ni nouveau port. Parcours : choix du nom → PIN (ou création du premier PIN avec le code temporaire) → « Je pointe mon arrivée / mon départ » → selfie → envoi.
- **Caisse** : Réglages › Pointage par téléphone (interrupteur, QR à afficher, téléphones rattachés). Dans le bandeau d'équipe : 📱 sur les arrivées au téléphone, selfies en touchant la fiche, bouton « N changements de téléphone » (accepter ou refuser avec le PIN manager).
- **Pont SamerTrackly** (`supabase/functions/_shared/samtrackly-detail.ts`) : les heures `TELEPHONE` remontent dans `pointe_arrivee` / `pointe_depart` comme celles de la pointeuse. **À redéployer** (`samtrackly-points`) pour que ce soit effectif.
- **Tests** : `apps/server/test/pointage-telephone.test.ts` (9 tests) et un test du pont. Suite serveur complète verte (564 tests).

À faire au déploiement (sur le PC Windows) :
1. Récupérer la branche, fusionner dans `main` en tenant compte des commits Windows non poussés.
2. `pnpm --filter caisse build`, puis relancer le POS (la migration 0051 passe au démarrage).
3. Redéployer la fonction cloud `samtrackly-points`.
4. Sur chaque site : Réglages › Pointage par téléphone › Activer, puis afficher le QR.
