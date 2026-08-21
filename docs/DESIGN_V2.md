# DESIGN_V2 — « Duo contrasté »

> **Statut : validé et porté dans la caisse (2026-08-16).** Ce document est LA
> référence de design du POS — il remplace `DESIGN.md` (« Culinary Commerce »),
> réduit à un renvoi vers ici.
>
> Il accompagne la maquette cliquable
> [`maquette_nouveau_design_caisse.html`](maquette_nouveau_design_caisse.html)
> — un fichier autonome, sans aucune requête réseau, qui s'ouvre par double-clic.
>
> **Règle de travail** : la maquette fait foi, **à la lettre**, mise en page ET
> couleurs. Pas de repli responsive ajouté de sa propre initiative : la caisse
> tourne sur un kiosque dont l'écran fait **1024 × 768** — c'est à cette largeur
> que tout écran nouveau se vérifie. Quand la maquette et l'application divergent,
> c'est ce document qui est mis à jour, le jour même.
>
> **Portage** : fait pour la caisse (connexion, accueil, tables, commande,
> paiement, clôture, dépenses, inventaire). Le KDS, la tablette serveur et l'app
> client tournent encore sur les anciens jetons (alias de compatibilité dans
> `packages/theme/theme.css`).

---

## 1. Pourquoi un nouveau design

Le design actuel, « Culinary Commerce », a été refusé. Reproches retenus :

1. **L'ambiance beige/crème** (`#fff8f2` en fond, surfaces beiges) — lue comme jaunie, pas nette.
2. **Les ornements décoratifs** — dégradés sur les boutons, halos flous en fond d'écran, icônes filigranes à 140 px, ombres teintées de brun.
3. **Un rendu daté**, pas « logiciel professionnel ».

L'orange de marque n'était **pas** en cause.

Demande complémentaire : plus de couleur, et une interface plus **fluide** — au sens du mouvement (transitions, retour tactile), pas du parcours.

---

## 2. Le parti pris

**Ossature ardoise + plan de travail clair.**

Les barres, la colonne des catégories/zones et le panneau latéral droit restent
sombres dans les deux modes ; la zone de travail centrale est claire (ou ardoise
en mode sombre). Le contraste structure l'écran : on reconnaît la caisse d'un
coup d'œil, et la couleur fonctionnelle ressort violemment sur les deux fonds.

**La couleur informe, elle ne décore pas.** C'est ce qui permet d'en mettre
beaucoup sans retomber sur le reproche du « trop fardé » : chaque teinte répond
à une question du caissier (quelle catégorie ? quel opérateur ? quel état de table ?).

### Ce qui disparaît

| Supprimé | Remplacé par |
|---|---|
| Dégradés sur les boutons | Aplats francs |
| Halos flous (`blur-3xl`) sur les écrans de travail | Rien |
| Icônes filigranes 140 px derrière les cartes | Rien |
| Ombres teintées de brun | Ombres neutres, 2 niveaux |
| Rayons 16 px | 12 px (le 16 donnait un côté « bonbon ») |
| Fond papier `#fff8f2` | `#f4f6f9` |

---

## 3. Jetons de design

Copiables tels quels. Dans l'application, ils remplacent le contenu de
`packages/theme/theme.css`.

### 3.1 Mode clair (défaut)

```css
:root {
  /* Ossature ardoise (chrome) */
  --ard-900: #10151d;  --ard-850: #141a24;  --ard-800: #171d27;
  --ard-750: #1c2431;  --ard-700: #212a37;  --ard-650: #283344;  --ard-600: #2e3a4b;
  --ard-txt: #f2f5f8;  --ard-txt-doux: #9aa8bb;  --ard-txt-faible: #6b7a90;

  /* Plan de travail */
  --plan: #f4f6f9;  --carte: #ffffff;  --carte-douce: #eef1f6;
  --filet: #e4e8ee;  --filet-fort: #d3d9e2;
  --txt: #131820;  --txt-doux: #5b6675;  --txt-faible: #8994a5;

  /* Marque — Chez Samer */
  --marque: #ef9f27;        /* aplats, états actifs */
  --marque-txt: #9a5b00;    /* texte de marque sur fond CLAIR */
  --marque-clair: #ffb95d;  /* texte de marque sur fond ARDOISE */
  --marque-tint: #fdf1de;
  --sur-marque: #1a1205;    /* texte posé sur un aplat de marque */
  --marque-sur-plan: var(--marque-txt);

  /* Sémantique */
  --ok: #16a34a;      --ok-tint: #e7f6ec;     --ok-txt: #10653a;
  --alerte: #dc2626;  --alerte-tint: #fdeaea; --alerte-txt: #96201e;
  --info: #3b82f6;    --info-tint: #e8f0fe;   --info-txt: #1e4a94;
  --attente: #d97706; --attente-tint: #fdf0dd;--attente-txt: #7c4a04;

  /* Écrans vitrine (connexion, accueil) */
  --vitrine-fond: #f4f6f9;      --vitrine-surface: #ffffff;
  --vitrine-surface-2: #eef1f6; --vitrine-bordure: #e4e8ee;
  --vitrine-txt: #131820;       --vitrine-txt-doux: #5b6675;
  --vitrine-txt-faible: #8994a5;
  --vitrine-ombre: var(--ombre-2);
  --halo-opacite: .5;

  /* Élévation — NEUTRE, jamais teintée */
  --ombre-1: 0 1px 2px rgba(16,21,29,.06), 0 2px 8px rgba(16,21,29,.05);
  --ombre-2: 0 8px 24px rgba(16,21,29,.12), 0 2px 6px rgba(16,21,29,.06);
  --ombre-ard: 0 10px 30px rgba(0,0,0,.35);

  /* Formes */
  --r: 12px;  --r-btn: 10px;  --r-sm: 7px;

  /* Mouvement */
  --ease: cubic-bezier(.22,.61,.36,1);
  --ease-sortie: cubic-bezier(.4,0,.68,.5);
  --dur: 220ms;  --dur-lent: 380ms;
}
```

### 3.2 Marque Al Kayan

Une seule bascule, sur `<html data-marque="AL_KAYAN">` :

```css
html[data-marque="AL_KAYAN"] {
  --marque: #2d7d46;
  --marque-txt: #1c5c33;
  --marque-clair: #6fd18f;
  --marque-tint: #e6f3ea;
  --sur-marque: #ffffff;
}
```

Les couleurs fonctionnelles (catégories, opérateurs, états de table) sont
**identiques pour les deux marques** — elles ne relèvent pas de l'identité mais
de la lecture de l'écran.

### 3.3 Mode sombre

Le duo **descend d'un cran** : l'ossature ne devient pas claire et le plan ne
devient pas noir, les deux glissent ensemble vers le bas. L'ossature reste plus
sombre que le plan, les cartes restent plus claires que le plan.

> **Attribut `data-mode`, pas `data-theme`.** La maquette est publiée dans un hôte
> qui pose déjà `data-theme` sur la racine ; le nom distinct évite la collision.
> À conserver au portage, ça ne coûte rien.

```css
:root[data-mode="sombre"] {
  --ard-900: #05080d;  --ard-850: #080c12;  --ard-800: #0b1017;
  --ard-750: #10161f;  --ard-700: #161d28;  --ard-650: #1d2532;  --ard-600: #26303f;

  --plan: #171d27;  --carte: #212a37;  --carte-douce: #1a2230;
  --filet: #2c3748; --filet-fort: #3a4658;
  --txt: #eef2f7;   --txt-doux: #a3b0c2;  --txt-faible: #7d8b9e;

  --marque-sur-plan: var(--marque-clair);
  --marque-tint: color-mix(in srgb, var(--marque) 20%, var(--carte));

  --ok-tint:      color-mix(in srgb, var(--ok) 20%, var(--carte));      --ok-txt: #6ee7a0;
  --alerte-tint:  color-mix(in srgb, var(--alerte) 22%, var(--carte));  --alerte-txt: #ff9b9b;
  --info-tint:    color-mix(in srgb, var(--info) 20%, var(--carte));    --info-txt: #9ec8ff;
  --attente-tint: color-mix(in srgb, var(--attente) 22%, var(--carte)); --attente-txt: #f5c274;

  --vitrine-fond: var(--ard-900);      --vitrine-surface: var(--ard-800);
  --vitrine-surface-2: var(--ard-750); --vitrine-bordure: var(--ard-700);
  --vitrine-txt: var(--ard-txt);       --vitrine-txt-doux: var(--ard-txt-doux);
  --vitrine-txt-faible: var(--ard-txt-faible);
  --vitrine-ombre: var(--ombre-ard);
  --halo-opacite: 1;

  --ombre-1: 0 1px 2px rgba(0,0,0,.45), 0 2px 8px rgba(0,0,0,.3);
  --ombre-2: 0 8px 24px rgba(0,0,0,.5), 0 2px 6px rgba(0,0,0,.35);
}
```

**Pièges à ne pas reproduire au portage** (tous rencontrés et corrigés dans la maquette) :

- `--marque` (`#ef9f27`) sur fond clair est **illisible en texte** (contraste ~2:1).
  Tout texte de marque posé sur le plan de travail doit passer par
  `--marque-sur-plan`, jamais par `--marque` ni `--marque-clair` en dur.
- Les fonds pastel (`--*-tint`) n'existent pas sur ardoise : ils sont recomposés
  en `color-mix` sur `--carte`.
- Les ombres grises ne se voient pas sur du sombre : `--ombre-1/2` sont redéfinies.
- Une règle de transition groupée placée en fin de feuille **écrase** les
  `transition` déclarées plus haut. Ne lister dans ce bloc que des éléments qui
  n'ont pas de transition propre.
- `:root[data-mode="sombre"] .mode` (0,2,1) bat `.mode.choisi` (0,2,0) : il faut
  écrire `:not(.choisi)` sinon l'état sélectionné perd son aplat.

---

## 4. Sémantique de la couleur

### 4.1 Catégories du menu

Hors famille orange, que la marque possède déjà.

| Catégorie | Couleur |
|---|---|
| Chawarmas | `#e2445c` |
| Pizzas | `#8b5cf6` |
| Grillades | `#14b8a6` |
| Boissons | `#3b82f6` |

Portée : pastille dans la colonne, liseré gauche de la carte article, fond du
visuel du plat (à ~11 %), point de couleur sur la ligne d'addition.

**Dans l'application** (porté le 2026-08-16) : le catalogue réel compte
**14 catégories**, pas 4, et la table `categories` ne porte aucune couleur. La
teinte se déduit donc du NOM, comme le routage d'impression, dans
`couleurCategorie()` (`packages/shared/src/constantes.ts`) — les quatre
ci-dessus telles quelles, les dix autres écartées en teinte (Crêpes, Desserts,
Apéritifs, Tacos, Sandwiches, Assiettes, Manaiches, Salades, Jus naturels,
Poulet & Poisson, Accompagnements). Une catégorie créée à la main dans Réglages
tombe sur une palette de repli tirée de son nom : la couleur est **stable** d'un
poste et d'un écran à l'autre, alors qu'un index de liste changerait au moindre
réordonnancement. Un combo n'appartenant à aucune catégorie prend la marque.

### 4.2 Modes de paiement — la vraie couleur de l'opérateur

Le caissier reconnaît le bouton à la couleur avant de lire le mot.

| Mode | Aplat | Fond tinté (clair) | Texte sur aplat |
|---|---|---|---|
| Espèces | `#16a34a` | `#e7f6ec` | `#ffffff` |
| Wave | `#1dc8ff` | `#e2f8ff` | `#06323f` |
| Orange Money | `#ff7900` | `#fff0e3` | `#ffffff` |
| MTN MoMo | `#ffcc00` | `#fff8db` | `#3d3100` |
| Moov Money | `#0057b8` | `#e3eefa` | `#ffffff` |
| Carte | `#64748b` | `#eef1f5` | `#ffffff` |

Le bouton « Ajouter ce paiement » prend la couleur du mode sélectionné.

### 4.3 États de table

Repris **à l'identique** de `packages/shared-ui/src/PlanSalle.tsx` — ne pas
inventer d'autres valeurs.

| État | Couleur | Libellé |
|---|---|---|
| `LIBRE` | carte blanche, bordure pointillée | Libre |
| `OCCUPEE` | `#64748b` | Occupée |
| `COMMANDE_CLIENT_A_VALIDER` | `#7c3aed` | Commande client |
| `EN_PREPARATION` | `--marque` | En préparation |
| `PRETE` | `#16a34a` + pulsation | Prête en cuisine |
| `SERVIE` | `#3b82f6` | En cours de repas |
| `ADDITION_DEMANDEE` | `#1e40af` | Addition demandée |

Badges : `APPEL` 🔔, `FACTURE` 🧾, `PRETE` ✅.

---

## 5. Mouvement

Le seul point retenu sur « plus fluide » : le mouvement.

| Élément | Comportement |
|---|---|
| Changement d'écran | Glissement horizontal 220 ms, sens selon la position dans le parcours |
| Ajout d'un article | Pastille de la couleur de la catégorie qui vole de la carte vers l'addition (540 ms), puis la ligne se déplie et se surligne 700 ms |
| Totaux | Les chiffres roulent jusqu'à la nouvelle valeur (400 ms, `easeOutCubic`), jamais de saut |
| Boutons | Enfoncement 1 px + ondulation au point de contact (540 ms) |
| Reste à payer | Descente en douceur ; pulsation verte à l'arrivée à zéro |
| Table prête | Pulsation verte permanente, 2 s — **seule animation infinie de l'interface** |
| Clôture | Barre de progression qui se remplit d'une étape à l'autre |
| Bascule clair/sombre | Fondu 260 ms sur les grandes surfaces |
| Chargement | Squelettes, jamais d'écran « Chargement… » vide |

`prefers-reduced-motion: reduce` coupe tout.

---

## 6. Les écrans

### 6.1 Connexion

Deux colonnes + pied de page.

- **Gauche** : nom du restaurant, puis **grille de profils** — pastille d'initiales
  (emplacement de la photo `photo_url`), nom complet, badge de rôle. Le profil
  choisi passe en bordure `--marque`. L'état « PIN à définir » est représenté.
- **Droite** : pavé PIN. Tant qu'aucun profil n'est choisi, il affiche
  « Sélectionnez votre nom à gauche pour saisir votre code » et **refuse la validation**.
  Une fois le profil choisi, il porte son avatar et son nom.
- **Pied** : statuts réseau / imprimante / cloud à gauche ; réglage **Affichage
  (Clair / Sombre)** à droite, avec une miniature de l'écran de commande peinte
  avec les jetons réels.

### 6.2 Accueil

**6 cartes** : Nouvelle commande, Tables, Mes ventes, Dépenses, Inventaire,
J'ai fini — entorse au §15 du cahier des charges (qui en impose 4), assumée et
tranchée par le boss le 2026-08-15 (voir § 8). Entête : nom + rôle + initiales de
l'utilisateur connecté, bouton de bascule clair/sombre, Appareils, Réglages,
Déconnexion. Le badge rouge sur « Tables » compte les **additions réellement en
attente** ; la pastille de l'inventaire alerte tant qu'il n'est pas validé.

### 6.3 Tables (plan de salle)

Trois colonnes.

- **Gauche (ardoise)** : zones, avec `occupées/total` et un point orange quand la
  zone demande une intervention (addition ou plat prêt).
- **Centre (clair)** : cartes de table colorées par état, badges en haut à droite,
  serveur + couverts, **montant en cours en gras** et ancienneté. Légende sous la grille.
- **Droite (ardoise)** : « Coup d'œil salle » — compteurs par état et total en
  salle ; puis « Transférer une table ».

Les tables virtuelles partenaires (Yango, Glovo, Samer Delly) ouvrent la **liste
de leurs commandes en cours** au lieu d'entrer directement : deux livreurs
peuvent être servis en même temps.

### 6.4 Commande

Ossature ardoise (barre, colonne catégories, panneau addition) + grille d'articles
claire. Chaque article porte son **visuel** (voir § 7). Les articles à options
ouvrent une fiche : bandeau visuel, options et suppléments en chips, quantité.

### 6.5 Paiement

Plan clair à gauche (modes colorés, montant, raccourcis, pavé, bouton d'ajout
coloré), récapitulatif ardoise à droite avec le **Reste à payer en très grand**.
Bouton de validation désactivé tant que le reste n'est pas nul.

### 6.6 Clôture

Assistant 4 étapes avec jauge : Compter → Réconcilier → Confirmer → Ticket Z.
Le théorique n'apparaît **qu'au ticket final**. Le ticket porte
« Clôturé par <nom> » et l'écart passe du vert au rouge au-delà du seuil.

### 6.7 Pointage — bandeau en haut de l'accueil

L'équipe est fixée à l'ouverture du service, mais les retards existent. Un
bandeau en haut de l'accueil liste les personnes présentes et permet d'en
pointer d'autres en cours de service.

- **L'heure du clic fait foi** comme heure d'arrivée. C'est elle qui sert à la
  paie, donc on l'enregistre, on ne la saisit pas à la main.
- Un service dure **8 h** → heure de fin prévue = arrivée + 8 h.
- **Code couleur sur la durée travaillée** : vert dès que la personne a fait ses
  8 h, rouge tant qu'elle ne les a pas faites. Une jauge montre l'avancement.
- Chaque fiche porte : avatar, nom, poste, heure d'arrivée, fin prévue, jauge,
  durée faite, et une étiquette « Salaire payé » le cas échéant.

**Le bandeau est replié par défaut.** Avec 15 personnes, la grille dépliée
occuperait quatre rangées et repousserait les six tuiles hors de l'écran. Replié,
il tient sur une ligne et reste informatif :

- les avatars des 5 premiers empilés, puis « +10 » ;
- « 15 présents · 8 ont fait leurs 8 h · 7 pas encore · 3 attendus » ;
- le bouton « Pointer une arrivée », accessible **sans déplier**.

Toute la barre est la zone de pli — une petite flèche seule serait une cible trop
fine sur écran tactile.

**Déplié, les noms tiennent sur une seule ligne de quatre**, qu'on fait défiler
horizontalement (flèches ou glissement, par page de quatre). Jamais de seconde
rangée : la hauteur du bandeau ne bouge pas, que l'équipe compte 4 personnes ou
40, et les tuiles de l'accueil ne se déplacent jamais.

Les tuiles, elles, restent **statiques** : les six visibles d'un coup, en grille.

Pointer quelqu'un déplie automatiquement, pour qu'on voie le résultat de son geste.

L'état replié/déplié appartient au **poste** (`parametres_locaux`), comme le mode
d'affichage.

> Par construction, une personne est rouge pendant la majeure partie de son
> service. La couleur devient informative en fin de service et dans le rapport
> du manager — c'est voulu.

### 6.8 Dépenses

Tuile sur l'accueil. Deux onglets.

- **Registre** : la liste chronologique des sorties de caisse. Chaque ligne
  porte sa catégorie en pastille de couleur, son motif, l'heure et qui l'a
  saisie. Catégories reprises de SamerTrackly : Marché, Légumes, Fruits,
  Dépenses annexes — plus **Salaires**, alimentée automatiquement.
- **Salaires du jour** : les personnes payées à la journée, avec leur taux et un
  bouton « Payer ». Le taux de la fiche est pré-rempli et **modifiable, à
  condition de donner un motif**. Le paiement crée une ligne de dépense
  catégorie Salaires, **non supprimable** (marquée « auto »).
- Panneau droit : total du service et répartition par catégorie.

L'onglet **Paie & départs** liste **tout le monde**, pas seulement les payés à la
journée — un employé au mois peut recevoir un encouragement, et surtout son
départ doit être marqué. Chaque ligne porte :

- le taux et le bouton **Payer** (seulement si payé à la journée) ;
- un bouton **+ Encouragement** pour tous : prime exceptionnelle, montant et
  motif obligatoires, qui part en dépense catégorie « Encouragements » ;
- un sélecteur **Parti / Reste**.

**Règle du départ** : à la clôture, toute personne non marquée « Reste » est
enregistrée comme **partie**. Le caissier ne marque donc que les exceptions —
le cas courant ne lui demande aucun geste. L'étape Confirmer annonce le décompte
avant validation, et le ticket Z porte présents / restent / partis.

Le total remonte **automatiquement** dans la ligne « Dépenses » de la clôture,
qui n'est plus saisissable : la caissière ne retape rien.

### 6.9 Inventaire

Tuile sur l'accueil. **Sans inventaire validé, pas de clôture.**

La maquette utilise le **catalogue réel de SamerTrackly**
(`lib/constants.js` → `CATEGORIES_INVENTAIRE`) : 8 catégories, 52 produits, noms,
prix, grammages et ratios repris tels quels. Une colonne de catégories à gauche,
comme l'écran de commande, avec le nombre de produits restant à compter.

**Trois natures de ligne**, et c'est le point que le portage ne doit pas rater :

| Nature | Exemple | Comportement |
|---|---|---|
| Comptée | Pain chawarma, Eau P | carte complète, le caissier saisit le compté |
| Consommation | Manaïche (100g), Pané, Glace 2 boules | se lit seulement : quantité vendue + conversion. **Jamais comptée.** |
| Total dérivé | Total Fromage, Total poulet, Pot de glace, Sachet de frites | c'est *elle* qu'on compte ; ses sorties viennent des consommations |

**Formules dérivées, reprises à l'identique de `app/inventaire.js`** :

```
Total Fromage (g)   sorties = Σ (vendus × grammage) sur f2…f9
Total poulet        entrées = entrées(Poulet frais) ; sorties = Σ sorties(po2…po6)
Pâte de poulet      entrées = entrées(Poulet frais) ÷ 10   (automatique)
Pot de glace        sorties = Σ (vendus × boules) ÷ 38
Sachet de frites    sorties = portions ÷ 8 + tacos ÷ 15
Darina              sorties = Pot Fresco vendus
générique           théorique = initial + entrées − sorties
```

Chaque total dérivé affiche son calcul en clair sous les champs — sinon le
caissier voit un chiffre tomber du ciel et ne peut pas le contester.

Une carte par produit, sur le modèle SamerTrackly :

| Champ | Origine |
|---|---|
| Stock initial | Stock final du service précédent — badge, non modifiable |
| Entrées | Somme des réceptions saisies dans l'onglet « Entrées reçues » |
| Sorties | Produits vendus du service — automatique, jamais modifiable |
| Théorique | initial + entrées − sorties, calculé |
| Compté | **La seule donnée que le caissier saisit** |

L'écart (compté − théorique) s'affiche sous les champs, avec un code couleur
distinct de SamerTrackly : **vert** aucun écart, **rouge** manquant, **bleu**
surplus. Un manquant ouvre un bloc de justification — quantité expliquée +
explication libre — et le reste non expliqué est chiffré en FCFA
(quantité × prix de vente).

Panneau droit : manquant non expliqué en gros, compteurs justes / manquants /
surplus, et le bouton de validation, actif seulement quand **tous** les produits
sont comptés. Après validation, tout passe en lecture seule.

**Le montant est une information, pas une retenue.** Contrairement à
SamerTrackly qui déduit, le POS présente le chiffre au manager, qui tranche.

### 6.10 Clôture — ce qui change

1. **Étape 1 bloquée** si l'inventaire n'est pas validé : encart rouge, bouton de
   comptage remplacé par « Aller à l'inventaire » et « Débloquer (manager) ».
2. **Dépenses en lecture seule**, reportées du registre, avec le nombre de lignes.
   L'étape Réconcilier couvre désormais **tout ce qui compte dans la vente** :
   tiroir, paiements électroniques, **livraisons partenaires** (Yango, Glovo —
   réglées chez le partenaire) et **Kdo offerts** (ils comptent dans la vente,
   jamais dans le tiroir). Ils apparaissaient au ticket Z sans jamais avoir été
   réconciliés.

   ⚠️ **Les livraisons partenaires ne sont PAS saisissables** — tranché par le
   boss le 2026-08-15, contre la première version de ce paragraphe. Le caissier
   n'a rien à retaper : le serveur recalcule le total depuis les commandes
   payées et **ignore** le champ `livraisons` du corps de la requête. Même
   traitement pour le total des dépenses, qui est la somme du registre. Ce n'est
   pas une règle d'affichage : elle est appliquée côté serveur.
3. **Ticket Z** : un bloc « Inventaire » — conforme, ou nombre de produits
   manquants et montant — explicitement marqué « information manager »,
   **sans effet sur la vente**.
4. **Bloc « Retours »** (ajouté le 2026-08-16) : les plats **déjà lancés en
   cuisine** qui ne seront pas vendus, parce que le manager ou l'administrateur
   a supprimé la ligne **ou la commande entière**. Le plat a été produit, il
   n'est pas vendu. Même statut que l'inventaire — **information, hors vente,
   hors tiroir, hors inventaire** — avec le nombre d'articles, le montant, le
   détail par produit, le motif et le nom de qui a autorisé. Un article corrigé
   AVANT l'envoi en cuisine n'en est pas un.

   **Les deux cas comptent, et c'est un contrôle, pas un comptage** : ne prendre
   que la ligne annulée ouvrirait la fraude la plus simple — encaisser, puis
   supprimer la table entière. Visible aussi dans « Mes ventes » et en bandeau
   de la Supervision : c'est le chiffre qui dit si un restaurant refait souvent
   ses plats, et qui les refait.

---

## 7. Visuels des plats

Le menu se regarde autant qu'il se lit : chaque article porte son image.

- Dans la maquette, ce sont des **illustrations vectorielles** (17 visuels
  distincts pour 17 articles) — le fichier doit tenir sans requête réseau.
- Dans l'application, la même zone reçoit la **photo du plat** :
  `<img src="…" style="object-fit: cover">`, mêmes dimensions (98 px sur la carte,
  156 px sur la fiche), aucune retouche de mise en page.
- Le fond du visuel reprend la teinte de la catégorie, à ~11 % : le code couleur
  du menu tient même quand toutes les photos se ressemblent.

⚠️ Ne pas livrer une seule illustration générique par catégorie : au premier essai,
les quatre boissons montraient toutes un jus d'orange et les quatre pizzas étaient
identiques. C'est ce qui fait « négligé ».

---

## 8. Décisions prises, et pourquoi

| Décision | Raison |
|---|---|
| Le mode clair/sombre appartient au **poste**, pas au compte | Deux caissiers qui se succèdent retrouvent le même affichage ; la caisse en terrasse peut rester en clair pendant que celle du bar est en sombre. Dans l'app : `parametres_locaux`, pas `localStorage`. |
| Les écrans **connexion et accueil suivent le mode** | Sinon « mode clair » ne veut rien dire pour quelqu'un qui n'ouvre que ces deux écrans. Effet secondaire utile : le réglage se voit immédiatement. |
| L'ossature des écrans de travail **reste sombre dans les deux modes** | C'est l'identité du design ; la faire basculer ferait perdre le duo contrasté. |
| Une table en **addition demandée mène droit au paiement** | C'est ce que le caissier va faire ; repasser par la commande est un clic pour rien. |
| **Encaisser ne déconnecte pas** | Seul « Terminer » en fin de clôture ramène à l'écran de connexion. |
| Le nom du caissier figure **sur le ticket Z** | Un rapport Z sans nom n'engage personne, alors que c'est le document qui rattache un écart de caisse à quelqu'un. |
| **L'heure de pointage est l'heure du clic** | Une heure saisie à la main est une heure négociable. Le clic est daté par le système, comme un badge. |
| **Le manager peut débloquer une clôture** (PIN + trace au journal) | Sans issue de secours, un caissier bloqué à 2 h du matin ne peut plus fermer sa caisse. |
| **Une ligne de salaire n'est pas supprimable** | Elle vient d'un paiement réel ; l'effacer ferait disparaître de l'argent sorti du tiroir. |
| **Un montant différent du taux exige un motif** | C'est le seul moyen pour le manager de comprendre un écart de paie. |
| **Le manquant d'inventaire est chiffré mais pas retenu** | Le POS informe, le manager décide. Une retenue automatique dans la caisse mélangerait deux responsabilités. |
| **L'accueil passe de 4 à 6 tuiles** | Le cahier des charges (§15) impose « exactement 4 boutons ». Dépenses et Inventaire sont deux entrées quotidiennes du caissier, elles ne pouvaient pas vivre dans un sous-menu. **Tranché par le boss le 2026-08-15** : entorse acceptée. |
| **Pas de vignette dans le panneau addition** | La colonne fait 356 px ; une image y serrerait la lecture. Les photos servent à choisir, pas à relire. |
| Le PIN **refuse la validation sans profil choisi** | Conforme à l'app : on se nomme avant de taper. |

---

## 9. Portage vers le POS (à faire seulement après validation)

| Ce qui change | Où |
|---|---|
| Jetons de couleur, formes, ombres, mouvement | `packages/theme/theme.css` |
| Alias Tailwind (`fond`, `surface`, `marque`…) | `apps/*/tailwind.config.js` — ajouter les jetons neufs : `plan`, `carte`, `filet`, `marque-sur-plan`, `vitrine-*` |
| Attribut `data-mode` sur `<html>` | Là où `data-marque` est déjà posé |
| Persistance du mode | `parametres_locaux` (réglage du poste) |
| Écran de connexion | `apps/caisse/src/screens/Login.tsx` |
| Accueil | `apps/caisse/src/screens/Accueil.tsx` |
| Plan de salle | `packages/shared-ui/src/PlanSalle.tsx` + `apps/caisse/src/screens/Tables.tsx` |
| Commande / fiche article | `apps/caisse/src/screens/Commande.tsx` |
| Paiement | `apps/caisse/src/screens/Paiement.tsx` |
| Clôture | `apps/caisse/src/screens/Cloture.tsx` |
| Document de référence | remplacer `docs/DESIGN.md` par ce fichier |

### Tables à créer (aucune n'existe aujourd'hui)

| Table | Contenu |
|---|---|
| `depenses` | service_id, categorie, libelle, montant, agent_id (si salaire), saisi_par, created_at |
| `inventaires_service` | service_id, valide, valide_le, debloque_par (manager), montant_manquant |
| `inventaire_lignes` | inventaire_id, produit_id, stock_initial, entrees, sorties, stock_compte, ecart, quantite_expliquee, explication |
| `entrees_stock` | inventaire_id, produit_id, quantite, fournisseur, created_at |
| `inventaire_consommations` | produit_id, article_id, quantite — **la recette** : ce qu'un article vendu consomme (migration 0022) |

Le pont vers les ventes est cette dernière table, et non une colonne
`article_id` sur le produit : un produit de comptage est consommé par toute une
famille d'articles, et un article consomme plusieurs produits. `quantite` (unités
par article vendu) se **compose** avec `ratio` (conversion SamerTrackly), elle ne
le remplace pas. Réglable dans Réglages › Recettes d'inventaire.

### Colonnes à ajouter

| Table | Colonne | Pourquoi |
|---|---|---|
| `equipe_service` | `pointe_le TIMESTAMPTZ` | heure d'arrivée, base des 8 h et de la paie |
| `utilisateurs` | `taux_journalier INTEGER` | salaire proposé au paiement |
| `services_caisse` | `inventaire_valide BOOLEAN` | verrou de clôture appliqué **côté serveur** |

### Ce qui existe déjà et qu'il ne faut pas refaire

- `services_caisse.depenses` — le total ; il devient la **somme** du registre.
- Les **sorties** de l'inventaire sont déjà calculées :
  [`rapports/routes.ts:126`](../apps/server/src/modules/rapports/routes.ts#L126)
  renvoie les produits vendus du service en quantités, sans montants.
- `equipe_service` — la composition de l'équipe ; seule l'heure manque.

**Ne pas porter depuis la maquette** : l'équipe de démonstration (6 personnes —
le seed ne contient volontairement que les deux comptes propriétaire), les
illustrations de plats (remplacées par les vraies photos), les données de
démonstration du plan de salle et du service, et la barre de démo en bas d'écran.

Le reste des apps (KDS, serveur, client) consomme le même
`packages/theme/theme.css` : le changement de jetons s'y propage seul, mais leurs
écrans porteront encore des styles de l'ancien système tant qu'ils n'auront pas
été repris.

---

## 10. Journal

Une ligne par modification de la maquette. **À tenir à jour à chaque changement.**

| Date | Ajout / changement |
|---|---|
| 2026-08-14 | Direction « Duo contrasté » retenue. Maquette initiale : 5 écrans (connexion, accueil, commande, paiement, clôture), palette, mouvement, bascule de marque Samer / Al Kayan. |
| 2026-08-14 | Mode clair / sombre : réglage sur l'écran de connexion + bascule dans l'entête de l'accueil. |
| 2026-08-14 | Visuels des plats sur les cartes articles et la fiche — 17 visuels distincts. |
| 2026-08-14 | Les écrans connexion et accueil suivent le mode d'affichage (le clair n'était pas assez clair). |
| 2026-08-15 | Grille de profils sur la connexion ; nom de l'utilisateur repris sur l'accueil, la clôture et le ticket Z. |
| 2026-08-15 | Écran **Tables** (plan de salle) : zones, états colorés, badges, transfert de table, tables virtuelles partenaires, panneau « Coup d'œil salle ». |
| 2026-08-15 | Création de ce document. |
| 2026-08-15 | **Pointage** : bandeau d'équipe en haut de l'accueil, pointage des arrivées tardives, 8 h par service, code couleur sur la durée travaillée. |
| 2026-08-15 | **Dépenses** : tuile + écran, registre par catégorie, salaires journaliers (taux proposé et modifiable avec motif), report automatique à la clôture. |
| 2026-08-15 | **Inventaire** : tuile + écran, cartes par produit, entrées reçues, écarts colorés et justifiés, validation **bloquant la clôture**, déblocage manager. |
| 2026-08-15 | Clôture : dépenses en lecture seule, bloc « Inventaire » au ticket Z. |
| 2026-08-15 | Inventaire rebâti sur le **catalogue réel SamerTrackly** : 8 catégories, 52 produits, colonne de catégories, lignes de consommation et totaux dérivés (fromage en grammes, poulet, boules ÷ 38, sachets ÷ 8 et ÷ 15, Darina). |
| 2026-08-15 | Stock initial : le badge passe au bleu des valeurs système (comme Entrées et Sorties), pour se distinguer du blanc de ce que le caissier saisit. |
| 2026-08-15 | Bandeau d'équipe **repliable**, replié par défaut, avec résumé (avatars empilés + compteurs). Équipe de démonstration portée à 15 présents et 3 attendus pour éprouver le cas réel. |
| 2026-08-15 | Réconciliation : ajout des **livraisons partenaires** et des **Kdo offerts**, qui figuraient au ticket Z sans être réconciliés. |
| 2026-08-15 | Bandeau d'équipe déplié : **une seule ligne de 4 noms** qui défile horizontalement. Les tuiles de l'accueil restent statiques (un premier essai les avait mises en carrousel — c'était l'équipe qui devait défiler). |
| 2026-08-15 | Paie : onglet **Paie & départs** ouvert à toute l'équipe, bouton **+ Encouragement** (prime), sélecteur **Parti / Reste**, et règle « sans Reste = parti » appliquée à la clôture. |
