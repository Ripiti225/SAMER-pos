# Console du siège (`apps/siege`)

Vue de groupe sur les 7 restaurants, sans caisse. Elle ne remplace ni le POS,
ni SamerTrackly : elle les regarde tous les deux au même endroit, et diffuse
vers plusieurs restaurants en une action.

## Ce qu'elle est (et ce qu'elle n'est pas)

| | Où ça se décide | Ce que fait la console |
|---|---|---|
| Ventes, clôtures, dépenses | Sur chaque caisse | Lecture seule, consolidée |
| Employés | **SamerTrackly** (maître) | Façade : elle écrit chez lui, jamais à côté |
| Catalogue, prix, promotions | **Cloud POS** (maître) | Édite et diffuse vers les sites choisis |

L'employé est le point à ne pas rouvrir : `sync-samtrackly.ts` fait déjà
descendre l'équipe dans chaque POS, et **désactive** tout compte lié
(`externe_id` non nul) disparu de la liste SamerTrackly. Une seconde source
d'employés provoquerait des désactivations et des doublons silencieux.

## Architecture

```
   Navigateur (console)              Cloud POS                 SamerTrackly
   ┌──────────────┐          ┌──────────────────┐          ┌─────────────┐
   │  apps/siege  │          │  Edge Function   │          │ restaurants │
   │              │─ JWT ───▶│      siege       │─ REST ──▶│ travailleurs│
   │  clé ANON    │          │  (service_role)  │          │ congés      │
   └──────────────┘          └────────┬─────────┘          └─────────────┘
                                      │
                            tables cloud (RLS forcée)
```

**La console n'a aucun privilège.** Elle n'embarque que la clé `anon`, publique
par construction, et le jeton de la personne connectée. Tout le pouvoir est
dans la fonction. Vérifié : un appel présentant la clé anon comme jeton porteur
reçoit un 401.

`verifierSiege()` contrôle en deux temps — `auth.getUser()` **puis**
appartenance à `siege_utilisateurs`. Le premier seul ne suffirait pas : la clé
anon *est* un JWT valide, et elle est dans le JavaScript de la page.

## Le chaînon `restaurants`

Le cloud POS identifie un site par un UUID régénéré à la configuration du poste,
SamerTrackly par le sien. Rien ne les reliait : `parametres_locaux` (qui porte
`samtrackly_restaurant_id`) est une table de **descente**, elle ne remonte
jamais, et `sites_autorises` ne garde qu'un code texte.

D'où la table `restaurants`, remplie **à l'enrôlement** : `enroler-site.ts`
affiche désormais l'`INSERT` à coller en même temps que celui de
`sites_autorises`. C'est le seul moment où les deux identifiants sont connus
ensemble. Ne pas sauter cette ligne, sinon la console affichera un UUID au lieu
d'un nom de restaurant.

## Mise en service

1. **Migration** — `supabase/migrations/20260817000000_siege_console.sql` dans
   l'éditeur SQL. *(fait le 2026-08-17)*
2. **Fonction** — depuis `app/`, avec `runtime\node` dans le PATH :
   ```
   npx.cmd --yes supabase@latest functions deploy siege --project-ref vbsmxwlxlcgkodwkbhfa --use-api
   ```
   *(fait le 2026-08-17)*
3. **Secrets SamerTrackly** — dashboard → Project Settings → Edge Functions →
   Secrets → ajouter `SAMTRACKLY_URL` et `SAMTRACKLY_KEY` (mêmes valeurs que
   `apps/server/.env`). Sans eux, les écrans Équipe et la liste des restaurants
   répondent « SamerTrackly non configuré ».
4. **Compte de connexion** — Authentication → Users → Add user (e-mail + mot de
   passe), puis :
   ```sql
   INSERT INTO siege_utilisateurs (user_id, nom_complet, niveau)
   SELECT id, 'SAMER Zreik', 'ADMIN' FROM auth.users WHERE email = 'a@b.c'
   ON CONFLICT (user_id) DO UPDATE SET niveau = 'ADMIN', actif = TRUE;
   ```
   `niveau` : `ADMIN` voit et écrit, `LECTURE` voit seulement (comptable, associé).
5. **`.env`** — `apps/siege/.env`, adresse du projet + clé `anon`.
6. **Migration livraisons partenaires** —
   `supabase/migrations/20260825030000_livraisons_partenaires.sql` dans
   l'éditeur SQL, **puis redéployer la fonction `siege`** (elle appelle la
   nouvelle `siege_livraisons_caissier`). Sans la migration, le bloc
   « Livraisons partenaires par caissier » arrive vide — le siège voit un trou,
   pas une erreur. `contact_client` ne vaudra que pour les commandes **à
   venir** : les lignes déjà montées ne sont pas republiées.

## Le front

**Rebâti le 2026-08-24.** Il n'existait nulle part — ni dans le dépôt, ni sur
aucune branche locale ou distante, ni sur la clé POSSAMER : seuls la fonction
`siege` et la migration étaient versionnés. Ce qui suit décrit ce qui est là
maintenant, au design « Duo contrasté » (DESIGN_V2 § 6.12).

| Écran | Ce qu'il montre | Action appelée |
|---|---|---|
| Connexion | e-mail + mot de passe Supabase | — |
| Tableau de bord | **Refondu le 2026-08-25** — six chiffres d'appel avec variation, CA quotidien empilé par restaurant, heures de pic, comparaisons, top des plats, modes de paiement, tables, canaux, retours, écarts par caissier, **livraisons partenaires par caissier**, dépenses, remises, annulations, inventaire, équipe et heures travaillées | `moi`, `tableau_bord` |
| Clôtures | fond, compté, théorique, **écart** coloré au-delà de 2 000 F, ticket Z complet à la demande (blocs nommés, tous les champs, JSON brut dépliable) | `restaurants`, `clotures`, `rapport_z` |
| Équipe | les travailleurs du groupe, filtrables par restaurant, **en lecture seule** | `equipe` |

### Le tableau de bord

Tout est agrégé **en SQL** (fonctions `siege_*` de
`20260825020000_tableau_bord_siege.sql`), jamais dans l'Edge Function : un mois
de ventes sur 7 restaurants fait ~10 000 lignes de `commandes`, les remonter
dans Deno pour les additionner serait lent et exposé à la troncature de
PostgREST. Une action, une réponse, quinze agrégats.

Un bloc dont la fonction SQL manque encore arrive **vide** au lieu de faire
échouer l'écran : le siège voit un trou, pas une page d'erreur.

#### Livraisons partenaires par caissier

Une ligne par caissier × partenaire : **commandes**, **contacts** (téléphone du
client) et **n° partenaire**. Le chiffre à regarder n'est pas le CA — il est
déjà dans « Canaux de vente » — mais l'écart entre les commandes et les
contacts : chaque unité manquante est une course qu'on ne saura rattacher à
personne si le client se plaint ou si Yango conteste. Le tableau est trié par
courses non rattachées, le caissier à reprendre est donc en haut.

Ces deux informations sont demandées sur la caisse dans une modale qui s'ouvre
au lancement en cuisine (DESIGN_V2 § 6.6 bis). Le caissier peut fermer sans rien
saisir : c'est un choix légitime, et c'est pourquoi on compte le trou plutôt que
de l'ignorer. La même paire de décomptes figure sur le ticket Z du site.

Deux limites à connaître, toutes deux écrites à l'écran :

- **Les absents** sont l'état COURANT de la fiche employé, pas un historique. On
  peut dire « qui est absent aujourd'hui », jamais « qui l'était mardi dernier » :
  le POS ne garde pas trace des disponibilités passées.
- **Les tables** remontent sans nom tant que `pnpm salle:republier` n'a pas
  tourné sur le site — le référentiel de salle ne monte pas tout seul (voir
  `docs/DEPLOIEMENT_CLOUD.md`, étape 4 bis). La console le détecte et le dit.

**Aucun bénéfice n'est calculé.** CA et dépenses sont montrés côte à côte,
jamais soustraits : le POS ne connaît que les sorties de caisse (marché,
légumes, fruits, annexes, salaires), ni loyer ni facture fournisseur payée hors
caisse. Un « bénéfice » calculé ici serait systématiquement optimiste, et
quelqu'un déciderait dessus. Le bénéfice reste l'affaire de SamerTrackly, qui a
la structure de coûts complète.

L'action **`equipe_service`** (ajoutée le 2026-08-24, déployée le 2026-08-25)
rend l'équipe NOMINATIVE d'un service : nom, poste, heure d'arrivée, heure de
départ, salaire payé, Reste/Parti. Elle croise `equipe_service` (qui remonte),
`utilisateurs_site` pour les noms, et les lignes de dépense catégorie
`SALAIRES` pour l'heure de paie.

**L'heure de départ n'existe nulle part en base** — seul `reste` (booléen) est
enregistré. La règle appliquée, donnée le 2026-08-24 :

- payé à la journée → **l'heure de paie**, celle de la ligne de dépense
  `SALAIRES`, datée par le système au clic sur « Payer » ;
- sinon → **l'heure de clôture** du service, affichée « *(clôture)* » : elle est
  présumée, pas pointée, et l'écran ne doit pas laisser croire l'inverse.

Le ticket Z lit cette action à l'ouverture plutôt que de figer la liste dans
`rapport_z` : ainsi elle vaut aussi pour les **clôtures déjà passées**.

**Tous les onglets portent un filtre par restaurant** — et ceux qu'on ajoutera
aussi. Le choix est tenu dans `App` et conservé d'un onglet à l'autre : on suit
un restaurant du tableau de bord à ses clôtures puis à son équipe sans jamais le
resélectionner. Il transporte le `samtrackly_id`, seul identifiant que possèdent
les 7 restaurants — un site non enrôlé n'a pas d'UUID POS et doit rester
sélectionnable.

Le seuil de 2 000 F est celui du POS (`parametres_locaux.seuil_alerte_ecart_caisse`),
repris tel quel : la console ne doit pas alerter sur un autre seuil que celui qui
a déclenché l'entrée d'audit `ECART_CAISSE` sur le site.

L'écran Équipe porte à l'écran la raison de sa lecture seule, pour qu'on ne
cherche pas un bouton « Ajouter » qui manquerait par oubli.

## Lancer

```
cp apps/siege/.env.example apps/siege/.env   # puis y coller la clé anon
pnpm install
pnpm --filter @pos/siege dev        # http://localhost:5180
```

Le port 5180 évite le 5173 de la caisse. La console **n'est pas une PWA** :
aucun intérêt hors ligne, aucun service worker, donc aucun cache à purger — le
piège du kiosque ne s'applique pas ici.

## Tant qu'aucun site n'est enrôlé

Ventes, clôtures et dépenses affichent zéro : le cloud ne reçoit rien. La
console l'écrit à l'écran plutôt que de laisser croire à une journée blanche.
L'écran Équipe, lui, fonctionne immédiatement — il lit SamerTrackly.

Rien n'est perdu pendant ce temps : chaque caisse empile ses ventes dans
`sync_outbox` et remonte tout au premier enrôlement.

## Reste à faire

- Écran **Catalogue** : créer/modifier un plat, cocher les restaurants
  destinataires, ajuster le prix par restaurant. La voie existe déjà côté cloud
  (`admin-catalogue` + descente en moins de 5 min) ; il manque la boucle
  multi-restaurants et l'interface.
- Écran **Dépenses & inventaire** : les tables cloud existent depuis le 16/08.
- **Sortir `SAMTRACKLY_KEY` du `.env` des 7 postes** (dette du 13/08). La clé
  vivant désormais en secret de fonction, le POS pourra passer par un proxy au
  lieu d'appeler SamerTrackly en direct. Attention : retirer la clé des postes
  **avant** que ce proxy existe couperait la synchro équipe de chaque site.
