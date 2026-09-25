# Comparaison au tableau de bord + période personnalisée — console du siège

Date : 2026-09-25
Écran : `apps/siege` → onglet **Tableau de bord**

## 1. Le problème

Le siège regarde les 7 restaurants sur une période et se pose aussitôt deux
questions que la console ne sait pas répondre :

- « Angré fait mieux que Riviera ? » — il faut aujourd'hui changer le filtre
  restaurant, retenir les chiffres de tête, rebasculer, comparer de mémoire.
- « On est au-dessus du mois dernier ? » — les flèches de variation des tuiles
  donnent un pourcentage, mais jamais le détail : quels plats, quels modes de
  paiement, quelles heures ont bougé.

Et une troisième, indépendante des deux premières : **on ne peut pas regarder
un mois passé.** Les cinq chips (Aujourd'hui, Hier, 7 j, 30 j, Ce mois-ci) ne
remontent pas au-delà de 30 jours. En février, les chiffres d'octobre sont
inaccessibles depuis la console.

## 2. Périmètre

Inclus :

1. Un **sélecteur de période personnalisée** (deux dates libres), ajouté au
   `SelecteurPeriode` partagé — il profite donc aussi à l'onglet Clôtures.
2. Un **bouton « Comparer »** au tableau de bord, qui passe l'écran en deux
   colonnes A | B.
3. Deux modes stricts : **2 restaurants** (une seule période) et
   **2 périodes** (un seul restaurant).
4. **Tous les blocs** du tableau de bord comparés, pas seulement les chiffres
   d'appel.
5. Une **bande de synthèse** en tête, suivie des écarts bloc par bloc.
6. Le découpage de `TableauBord.tsx`, rendu nécessaire par le point 4.
7. Des tests Vitest sur les fonctions pures extraites.

Exclus :

- Aucune nouvelle RPC, aucune modification de `supabase/functions/siege/` ni
  des fonctions SQL `siege_*`.
- Comparaison à trois termes ou plus.
- Croisement libre restaurant × période (A = Angré/octobre contre
  B = Riviera/novembre) : deux variables qui changent ensemble n'expliquent
  rien. Voir § 4.
- Export, impression, partage d'une comparaison.
- Persistance du choix dans l'URL ou le stockage local.

Hors comparaison et sans période personnalisée choisie, **l'écran ne change
pas d'un pixel**.

## 3. Période personnalisée

### 3.1 L'interaction

Une sixième chip, **« Personnalisée »**, à la suite des cinq existantes. Au
clic, deux champs `<input type="date">` se déploient sous les chips :

```
[Aujourd'hui] [Hier] [7 derniers jours] [30 derniers jours] [Ce mois-ci] [▪Personnalisée▪]

  Du [01/10/2025]   au [31/10/2025]        → 1er → 31 oct. 2025 · 31 jours
```

Les deux dates sont **inclusives pour qui les saisit** : « du 1er au 31
octobre » contient le 31 octobre en entier. La chip reste active et affiche la
plage retenue tant qu'on ne reprend pas une chip relative.

### 3.2 Les bornes envoyées

`fin` est EXCLUE côté cloud (`< p_fin`), exactement comme pour les chips
existantes. La conversion est donc :

```
debut = `${du}T00:00:00.000Z`
fin   = minuit du LENDEMAIN de `au`, en UTC
```

Abidjan est à UTC+0 toute l'année : un jour civil est un jour UTC, aucun
décalage à gérer — c'est déjà l'hypothèse de `periode.ts` et des RPC.

### 3.3 Les garde-fous

| Cas | Comportement |
|---|---|
| `Du` > `Au` | Message : « La date de début est après la date de fin. » Aucune requête n'est lancée. |
| Un seul champ rempli | Aucune requête ; la période précédente reste affichée. |
| Plage > 366 jours | Message : « Choisissez une plage d'un an au maximum. » La console agrège ligne à ligne : au-delà, la requête devient longue pour une lecture que personne ne fait. |
| `Au` dans le futur | Autorisé, sans message : cela revient à « jusqu'à aujourd'hui », les jours à venir sont vides. |

### 3.4 L'API

**Rien à changer.** `periode(corps)` dans `supabase/functions/siege/index.ts`
accepte déjà des bornes ISO libres, et toutes les fonctions `siege_*` prennent
`p_debut` / `p_fin`. Le `debut_precedent` calculé par la fonction (`debut −
durée`) reste juste pour une période personnalisée, quelle que soit sa durée.

### 3.5 Le code

`src/periode.ts` gagne :

```ts
/** Une plage saisie à la main. `du` et `au` sont des 'YYYY-MM-DD' INCLUSIFS. */
export function personnalisee(du: string, au: string): Periode
```

Elle rend un `Periode` de clé `'perso'`, avec un `libelle` écrivant les vraies
dates (« 1er → 31 oct. 2025 »), l'année étant omise quand c'est l'année en
cours. `CLES_PERIODE` et `periodes()` ne bougent pas : `'perso'` n'est pas une
chip relative et n'a rien à faire dans le Record.

`SelecteurPeriode` rend la chip « Personnalisée » à part de `listePeriodes()`,
active quand `valeur.cle === 'perso'`, et porte les deux champs de date.

## 4. Les deux modes de comparaison

Le bouton **« Comparer »** siège à côté du filtre restaurant. Cliqué, il
déploie la barre de comparaison et passe l'écran en deux colonnes. Recliqué
(« Comparer ✕ »), il rend l'écran à son état d'origine.

| Mode | Ce qui varie | Ce qui est verrouillé |
|---|---|---|
| **2 restaurants** | A = un restaurant, B = un autre | une seule période, commune aux deux |
| **2 périodes** | A = la période choisie, B = **calculée** | un seul restaurant (ou « tous ») |

Les modes sont **stricts** : en mode « 2 restaurants », il n'existe qu'un seul
sélecteur de période ; en mode « 2 périodes », qu'un seul sélecteur de
restaurant. On ne peut pas faire varier les deux à la fois, parce qu'une telle
comparaison n'explique rien — si Angré/octobre bat Riviera/novembre, on ne sait
pas si c'est le restaurant ou le mois.

```
Comparer  ( 2 restaurants )  ( 2 périodes )
Période   [Auj.][Hier][▪7j▪][30j][Mois][Personnalisée]
A [Angré ▾]           contre           B [Riviera ▾]
```

```
Comparer  ( 2 restaurants )  ( 2 périodes )
Restaurant [Angré ▾]
A  [Auj.][Hier][7j][30j][Mois][▪Personnalisée▪]  →  1er → 31 oct. 2025
B  les 31 jours précédents                       →  31 août → 30 sept. 2025
```

### 4.1 La période B n'est pas choisie, elle est déduite

B = **les mêmes jours, juste avant A**. C'est-à-dire exactement
`periode.debut_precedent → periode.debut`, que la fonction `siege` calcule
déjà pour alimenter les flèches de variation des tuiles. Aucun sélecteur
supplémentaire, et une garantie : **A et B ont toujours la même durée**, donc
les pourcentages d'écart veulent dire quelque chose.

Le libellé de B écrit toujours les vraies dates. Deux cas demandent une phrase
explicite, sans quoi on lit autre chose que ce qui est affiché :

- **« Ce mois-ci »** un 25 septembre : A couvre 25 jours, B couvre les 25 jours
  précédents — pas le mois d'août entier. Le bandeau l'écrit : *« 25 jours
  contre les 25 précédents (31 août → 24 sept.) — pas le mois d'août
  entier. »*
- **Période personnalisée** de longueur quelconque : même phrase, avec le
  nombre de jours.

**B a toujours la même durée que A — y compris pour une période
personnalisée.** Une comparaison octobre contre septembre « au mois exact »
n'est donc pas possible : A = 1er → 31 octobre (31 jours) donne B = 31 août →
30 septembre, pas le mois de septembre entier (30 jours). C'est un choix, pas
un manque : deux périodes de durées différentes rendent tout pourcentage
d'écart faux, et c'est cette erreur-là qu'on refuse de rendre possible. Le
bandeau écrit les vraies dates de B, jamais un nom de mois.

Pour qui veut néanmoins septembre entier, la période personnalisée le donne en
lecture simple, hors comparaison.

### 4.2 Qui remplit A et B, et ce que devient le filtre global

Au premier clic sur « Comparer » :

- Mode « 2 restaurants » : A prend le restaurant du filtre global s'il y en a
  un, sinon le premier enrôlé ; B prend le suivant, différent de A.
- Mode « 2 périodes » : le restaurant est celui du filtre global — « Tous les
  restaurants » compris, comparer le groupe à lui-même est légitime.

**Le filtre restaurant global ne bouge plus ensuite.** Choisir A ou B dans la
barre de comparaison ne le réécrit pas : il est commun à tous les onglets et
doit survivre au changement d'onglet (règle en place dans `App`). Le repeindre
depuis la comparaison ferait suivre au hasard l'un des deux termes jusque dans
les Clôtures ou l'Inventaire. En mode comparaison, le filtre global est donc
masqué au profit des sélecteurs A / B ; il reprend sa place à la sortie, à la
valeur qu'il avait à l'entrée.

Deux refus côté sélecteur :

- **A = B** en mode « 2 restaurants » : comparer un restaurant à lui-même sur
  la même période afficherait des zéros partout. Choisir pour B la valeur de A
  échange les deux termes au lieu de les confondre.
- **Moins de deux restaurants dans la liste** : le mode « 2 restaurants » est
  désactivé, avec la raison écrite (« Il faut au moins deux restaurants pour
  les comparer »). Le mode « 2 périodes » reste disponible.

## 5. Les données : zéro nouvelle requête… ou presque

| Mode | Requêtes |
|---|---|
| **2 restaurants** | **Aucune de plus.** La réponse `tableau_bord` porte déjà les 7 restaurants, chaque ligne de chaque bloc portant son `restaurant_id`. On dérive deux vues de la même charge utile. |
| **2 périodes** | **Une seule de plus** : un second `useQuery` sur `['tableau_bord', debutPrec, debut]` — même action, autres bornes. TanStack Query le met en cache comme le reste. |

`refetchInterval: 60_000` reste sur la requête A (l'écran de veille doit se
tenir à jour). La requête B, en mode « 2 périodes », porte sur du passé figé :
elle n'a pas de `refetchInterval`.

## 6. Ce qu'on lit : synthèse d'abord, écarts ensuite

### 6.1 La bande de synthèse

En tête des deux colonnes, une phrase puis trois écarts majeurs :

```
┃ Riviera fait 260 000 FCFA de moins qu'Angré sur 7 jours (−21 %).
┃ • 57 commandes de moins ▼ 14 %   • Panier plus faible ▼ 8 %
┃ • Dépenses de caisse ▲ 38 %
```

La phrase d'en-tête porte toujours sur le **chiffre d'affaires**. Les trois
lignes suivantes sont les trois plus gros écarts **relatifs** parmi les autres
indicateurs suivis :

| Indicateur | Monter est… |
|---|---|
| Chiffre d'affaires | bon |
| Commandes payées | bon |
| Panier moyen | bon |
| Heures travaillées | neutre — jamais dans la synthèse, seulement au détail |
| Dépenses de caisse | mauvais |
| Retours | mauvais |
| Écart de caisse réconcilié (valeur absolue) | mauvais |
| Salaires payés en caisse | neutre — jamais dans la synthèse |

La polarité décide de la couleur et de rien d'autre : la flèche et le signe
redisent l'information, pour qui ne distingue pas le vert du rouge. C'est la
grammaire déjà en place dans `TuileChiffre`.

### 6.2 Les écarts bloc par bloc

Chaque tuile et chaque ligne de la colonne B porte son écart contre A :
`▼ 21 % / −260 000`. A reste la référence, lue telle quelle.

**Les tuiles de A ne portent pas de flèche en mode comparaison.** Leur
variation contre leur propre passé est une troisième information qui entrerait
en collision avec l'écart B↔A dans le même coup d'œil. Hors comparaison, elles
la gardent.

### 6.3 Les blocs, un par un

| Bloc | Rendu en comparaison |
|---|---|
| 6 tuiles de chiffres | A sans flèche, B avec écart % + écart absolu |
| Chiffre d'affaires jour par jour | `BarresEmpilees`, une série par colonne, **échelle partagée** |
| Heures de pic | `BarresHeures` par colonne, **échelle partagée** |
| Top des plats | deux top-10 indépendants, **échelle partagée** |
| Modes de paiement | idem, couleurs d'opérateur conservées |
| Tables les plus utilisées | idem |
| Canaux de vente | idem |
| Retours | idem |
| Écarts par caissier | `BarresEcarts` par colonne, **échelle partagée** |
| Dépenses par catégorie | idem |
| Remises et annulations | le bloc mixte, rendu une fois par colonne |
| Livraisons partenaires | le tableau, rendu une fois par colonne |
| Inventaire | rendu une fois par colonne |
| Équipe + absents | rendu une fois par colonne |

Les blocs « CA par restaurant » et « Panier moyen par restaurant » (couche 3,
déjà conditionnés à `!choisi`) **disparaissent en mode comparaison** : ils
classent les 7 restaurants, ce que la comparaison à deux remplace.

Les listes des deux colonnes n'ont pas les mêmes libellés — le top des plats
d'Angré n'est pas celui de Riviera. C'est voulu : c'est justement ce qu'on veut
voir. L'échelle partagée permet de comparer les longueurs d'une colonne à
l'autre malgré des libellés différents.

## 7. Les quatre règles de correction

Ce sont les points où une implémentation naïve ment à l'utilisateur.

### 7.1 Échelle partagée entre les deux colonnes — obligatoire

Deux graphes côte à côte avec chacun son échelle sont un **mensonge visuel** :
une barre à 980 000 monte aussi haut qu'une barre à 1 240 000, et l'œil conclut
l'égalité. `BarresHorizontales` accepte déjà un `max` imposé.
`BarresEmpilees`, `BarresHeures` et `BarresEcarts` ne l'ont pas : on leur
ajoute le même `max?: number` optionnel, et la comparaison passe
`Math.max(maxA, maxB)` des deux côtés.

Trois props. Sans elles, la fonctionnalité est fausse.

### 7.2 Un site non enrôlé n'est pas un effondrement

Les sites non enrôlés restent sélectionnables (règle existante du filtre : les
retirer laisserait croire que le groupe compte moins de restaurants qu'en
vrai). Mais s'il est choisi comme A ou comme B, la colonne affiche son encart
explicite au lieu de ses zéros :

> **Ce site ne synchronise pas encore.** Tout est à zéro parce que le cloud ne
> reçoit rien — pas parce que la semaine a été blanche.

Et **aucun pourcentage n'est calculé** contre lui, dans un sens comme dans
l'autre : un `−100 %` se lirait comme une catastrophe commerciale.

### 7.3 A à zéro ne produit jamais de pourcentage

`(b − a) / a` avec `a = 0` est une division par zéro. La synthèse écrit alors
une phrase — *« Angré n'a rien vendu sur cette période »* — et l'écart absolu
reste affiché. Le cas arrive pour de bon : un restaurant fermé un jour férié,
un bloc vide (aucune remise, aucun retour).

### 7.4 Une période partielle le dit

Voir § 4.1 : « Ce mois-ci » et les périodes personnalisées écrivent le nombre
de jours réellement couvert de part et d'autre.

## 8. Structure du code

`src/screens/TableauBord.tsx` fait aujourd'hui ~450 lignes où la dérivation des
données et le rendu sont entrelacés dans une vingtaine de `useMemo`. Le rendre
bicolonne en l'état voudrait dire dupliquer les deux. On le découpe — c'est le
refactor qu'appelle le travail, pas un chantier à côté.

| Fichier | Rôle |
|---|---|
| `src/periode.ts` | + `personnalisee(du, au)` |
| `src/bord.ts` **(nouveau)** | `vueBord(data, restaurantId, restos) → VueBord` — **pure**, reprend tous les `useMemo` actuels, testable sans React |
| `src/comparaison.ts` **(nouveau)** | `ecarts(a, b)` et `synthese(a, b)` — **pures** : polarité, division par zéro, choix des trois écarts majeurs |
| `src/components/BlocsBord.tsx` **(nouveau)** | les blocs de présentation, chacun prenant une `VueBord` |
| `src/components/BarreComparaison.tsx` **(nouveau)** | le mode et les sélecteurs A / B |
| `src/components/Synthese.tsx` **(nouveau)** | la bande de verdict |
| `src/screens/TableauBord.tsx` | orchestration seule : filtres, requêtes, une colonne ou deux |
| `src/components/SelecteurPeriode.tsx` | + la chip « Personnalisée » et ses deux champs de date |
| `src/components/Graphes.tsx` | + `max?` sur `BarresEmpilees`, `BarresHeures`, `BarresEcarts` |
| `src/components/Chiffre.tsx` | + l'écart absolu à côté du pourcentage |

`VueBord` est l'interface qui tient tout : ce qu'une colonne a besoin de
savoir, dérivé et rien de plus. `BlocsBord` ne connaît pas l'existence de la
comparaison ; il reçoit une `VueBord` et un `max` facultatif. C'est ce qui rend
la colonne unique et la colonne A ou B strictement le même code.

### 8.1 Disposition

Deux colonnes à partir de `xl` (`xl:grid-cols-2`), empilées en dessous — A en
entier, puis B en entier, chacune sous son en-tête. Sur un écran étroit, la
bande de synthèse porte seule la comparaison, ce qui est justement son rôle.

Les en-têtes de colonne (`A · ANGRÉ` / `19 → 25 sept.`) reprennent la couleur
de série du restaurant, prise sur la liste **complète et stable** des
restaurants — jamais sur une liste filtrée, règle déjà en place dans
`couleurSerie`.

## 9. Tests

`apps/siege` n'a pas encore de runner (`"test": "exit 0"`). On ajoute Vitest,
qui est la stack du monorepo, et on couvre les deux modules purs — c'est
précisément pour cela qu'ils sont purs.

`src/periode.test.ts` :
- `personnalisee('2025-10-01', '2025-10-31')` → `fin` au 1er novembre minuit UTC (le 31 octobre est inclus).
- `Du` après `Au` → rejeté.
- Plage de 367 jours → rejetée ; 366 jours → acceptée.
- Le libellé omet l'année en cours et l'écrit sinon.

`src/bord.test.ts` :
- Filtrage par `restaurant_id` : une charge utile à trois restaurants donne trois vues disjointes.
- Cumuls par jour, par heure, par plat, par mode.
- Un bloc absent de la réponse (migration pas passée) donne une vue vide, jamais une exception.
- Un restaurant sans `restaurant_id` (non enrôlé) est reconnu comme tel.

`src/comparaison.test.ts` :
- A à zéro : aucun pourcentage, la phrase de remplacement à la place.
- B à zéro : `−100 %` légitime, affiché.
- Polarité inversée : dépenses en hausse = mauvais, CA en hausse = bon.
- Site non enrôlé d'un côté : aucun pourcentage produit.
- La synthèse retient bien les trois plus gros écarts **relatifs**, pas absolus.
- Écart nul : « = stable », jamais `▲ 0 %`.

## 10. Définition de « terminé »

- `pnpm build` passe sans erreur TypeScript (strict, `noUncheckedIndexedAccess`).
- `pnpm --filter @pos/siege test` est vert.
- Période personnalisée : en septembre, saisir « du 1er au 31 octobre 2025 »
  affiche les chiffres d'octobre 2025 au tableau de bord **et** aux clôtures.
- Mode « 2 restaurants » : deux restaurants côte à côte sur 7 jours, sans
  requête supplémentaire (vérifiable dans l'onglet Réseau).
- Mode « 2 périodes » : « du 1er au 31 octobre 2025 » pour un restaurant, B calculée
  aux 31 jours précédents (31 août → 30 sept.) et libellée avec ces vraies dates.
- Un site non enrôlé choisi d'un côté affiche son encart et aucun pourcentage.
- Les graphes de A et de B partagent visiblement leur échelle.
- Bouton « Comparer ✕ » : l'écran revient exactement à son état d'origine.
