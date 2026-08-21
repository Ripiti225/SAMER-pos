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

## Lancer

```
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
