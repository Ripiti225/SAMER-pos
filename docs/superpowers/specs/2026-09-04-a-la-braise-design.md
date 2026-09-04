# Profil d’installation « À la Braise » — conception

## Objectif

Ajouter `A_LA_BRAISE` comme troisième marque du POS commun et livrer un profil
d’installation autonome pour le restaurant « À la Braise chez Mapau ». Le code
reste unique pour Chez Samer, Al Kayan et À la Braise ; chaque site conserve sa
base locale, son identité, son catalogue, sa salle, ses stocks et son identifiant
cloud propres.

Le seed générique reste neutre (`A_CONFIGURER`) et ne reçoit aucune donnée du
restaurant. Le profil est appliqué explicitement à une installation neuve par
un import idempotent et transactionnel qui ne supprime jamais les ventes.

## Sources et priorité

- Menu : `/Users/macbookpro/Downloads/Fichier A LA BRAISE chez Mapau/MENU ALA BRAISE_ok_113241.pdf`
- Logo et 47 autres visuels : `/Users/macbookpro/Downloads/Fichier A LA BRAISE chez Mapau/`
- Les corrections données dans cette spécification priment sur le PDF.
- `sql/schema.sql` demeure la source de vérité du schéma local ; le schéma
  Drizzle doit rester son miroir.

## Identité

| Champ | Valeur |
|---|---|
| Code | `ALA_BRAISE` |
| Nom affiché | À la Braise |
| Nom complet | À la Braise chez Mapau |
| Marque | `A_LA_BRAISE` |
| Téléphone | 07 01 11 11 18 |
| Adresse | Yopougon Maroc, à 100 m de l’antenne Maroc |
| Latitude | 5.3430833333 |
| Longitude | -4.1004444444 |
| Google Maps | https://maps.app.goo.gl/fdjXuftprfN4RWQ27 |
| Ouverture | 24 h/24, 7 j/7 |
| Instagram | `ala.braise` |
| Facebook | À la Braise chez Mapau |
| TikTok | A la Braise chez Mapau |

Le thème emploie le noir comme fond, le jaune/or du logo comme accent et le
rouge du logo comme couleur secondaire. Les teintes exactes sont extraites du
logo source et le texte sur l’or doit conserver un contraste accessible.

Un nouvel UUID cloud/SamerTrackly est créé à l’enrôlement du site. Aucun UUID
d’un restaurant existant n’est copié ou codé en dur.

## Compatibilité de marque

La valeur `A_LA_BRAISE` est ajoutée aux contraintes SQL, au schéma Drizzle, aux
types partagés, aux réponses d’authentification et client, aux vues du siège et
à l’impression. Le logo thermique À la Braise est explicite : il ne doit jamais
retomber silencieusement sur le logo Samer.

## Salle et canaux

Créer 34 tables physiques :

- zone `RC` : `RC 1` à `RC 4` ;
- zone `Salle` : `Salle 1` à `Salle 15` ;
- zone `Terrasse` : `Terrasse 1` à `Terrasse 15`.

Créer la zone `Livraison` et trois tables virtuelles :

- `GLOVO`, partenaire `GLOVO` ;
- `YANGO`, partenaire `YANGO` ;
- `LIVRAISON DIRECTE`, partenaire `LIVRAISON_DIRECTE`.

Le POS permet sur place, à emporter et livraison. Les prix Glovo et Yango sont
initialement identiques aux prix sur place grâce au repli existant sur
`prix_base`. Aucun `prix_canaux` n’est créé tant que les vrais tarifs ne sont
pas connus ; ils resteront éditables article par article.

## Comptes

Le profil ne crée aucun employé. Une installation neuve conserve uniquement les
deux propriétaires du seed commun : SAMER Zreik et Admin Willy.

## Catalogue

Tous les prix sont des entiers FCFA. Les articles à plusieurs prix utilisent
des variantes/options explicites lorsque le modèle le permet ; sinon ils sont
des articles distincts avec un nom non ambigu et un stock correctement lié.

### Sauces — 10 h à 16 h

Les catégories quotidiennes restent visibles tous les jours, mais celle du jour
courant est triée en premier.

**Tous les jours**

- Graine + Foutou — pondeuse fumée : 4 000
- Graine + Foutou — escargot, queue de bœuf et poisson fumé : 5 000

**Lundi**

- Gombo grillé + Riz — viande de bœuf : 3 000
- Aubergine + Foutou — patte de bœuf et poisson fumé : 5 000

**Mardi**

- Gouagouassou + Foutou — patte de bœuf, poisson fumé et crabes : 3 000
- Sauce légumes + Riz — poisson grillé et viande de bœuf fumée : 3 500

**Mercredi**

- Tomate + Riz — poisson grillé et viande de bœuf : 3 000
- Tchep au poisson : 2 000
- Tchep à la viande : 2 500

**Jeudi**

- Arachide + Riz — viande de bœuf : 3 000
- Arachide + Riz — poulet pondeuse : 4 000
- Sauce claire + Foufou — poisson frais : 3 000

**Vendredi**

- Biekosseu + Foutou — poisson carpe : 3 000
- Biekosseu + Foutou — poulet pondeuse : 4 000
- Feuilles + Riz — poisson fumé et viande de bœuf : 3 000

**Samedi**

- Lokossoukouê — poisson sec et viande fumée : 2 500
- Lokossoukouê — pondeuse fumée et poisson fumé : 3 000
- Pistache — viande de bœuf : 3 000
- Pistache — pondeuse : 4 000

**Dimanche**

- Soumara Lafri + poisson : 2 500
- Soumara Lafri + viande de bœuf : 3 000
- Soumara Lafri + pondeuse : 3 500
- Soumara Lafri + pintade : 4 000
- Soupe de carpe + attiéké rouge : 2 500
- Soupe de mouton + attiéké rouge : 3 000
- Soupe de cabri + attiéké rouge : 3 000

Chaque sauce peut recevoir zéro ou plusieurs accompagnements supplémentaires :
Riz +500, Attiéké +500, Foutou +500.

### Barbecues — 16 h à minuit

La ligne ambiguë du PDF est remplacée par deux produits :

- Poulet braisé de chair — entier : 8 000
- Poulet braisé hybride — entier : 10 000
- Lapin braisé : 4 000
- Cabri braisé : 5 000
- Mouton braisé : 5 000
- Carpe braisée — petite : 5 000
- Carpe braisée — grande : 6 000
- Machoiron piqué : 6 000
- Sol braisé : 4 500
- Brochette de caille braisée : 7 000
- Brochette de gésier : 4 000
- Brochette d’escargot : 5 000
- Brochette de poulet de chair : 5 500
- Choukouya de bœuf : 7 500

La carpe varie par taille, jamais par demi/entier.

### Kedjenou

- Lapin : demi 5 000, entier 8 000
- Poulet hybride : demi 5 000, entier 9 500
- Pintade : demi 6 000, entier 10 000
- Escargot : 7 000

### Assiettes

- Soupe de machoiron : 7 000
- Soupe du pêcheur : demi 6 000, entier 12 000

### Desserts

- 2 boules de glace : 1 000
- Dêguê au couscous : 1 500
- Dêguê au mil : 1 500
- Cake à l’orange : 2 000
- Salade de fruits : 2 000
- Cake au chocolat : 2 500
- Crêpe au Nutella : 3 000

### Accompagnements

- Attiéké : 500
- Riz nature : 1 000
- Alloco : 1 500
- Igname grillée : 1 500
- Pomme de terre sautée : 1 500
- Poêlée de légumes : 2 000
- Riz cantonais : 2 500
- Poutine — frites, fromage et viande hachée : 2 500

### Placali et Cabato — 4 h à 10 h

Créer trois articles distincts :

1. Formule 3 000 : deux boules de placali ou cabato ; kplo, crabe, poisson et
   tripe ; sauces gombo et kpala incluses.
2. Formule 5 000 : deux boules de placali ou cabato ; kplo, crabe, poisson,
   tripe et escargot ; sauces gombo et kpala incluses.
3. Formule 3 500 : deux boules de placali ou cabato ; sauce graine et escargot ;
   choix obligatoire entre sauce gombo et sauce kpala.

Chaque formule demande un choix obligatoire `Placali` ou `Cabato`. Les
suppléments Placali, Cabato et Riz valent chacun +500. Cette correction remplace
les +300 imprimés dans le PDF.

### Boissons

- Eau petite bouteille : 500
- Eau grande bouteille : 1 000
- Boisson 1 000 : 1 000
- Boisson 1 500 : 1 500
- Bissap menthe et ananas : 1 500
- Jus de gingembre : 1 500
- Jus de passion : 2 000
- Jus de tamarin : 2 000
- Limonade : 1 500
- Citron menthe : 2 500

Les sodas ne sont pas détaillés par marque pour l’instant.

## Disponibilité horaire et dérogations

Le serveur calcule la disponibilité effective ; l’UI seule ne fait jamais foi.

| Famille | Créneau |
|---|---|
| Placali et Cabato | 04:00–10:00 |
| Sauces | 10:00–16:00 |
| Barbecues | 16:00–00:00 |
| Autres familles | toute la journée |

Les articles hors créneau restent visibles avec « Indisponible actuellement »
et l’API refuse leur ajout. Une personne disposant de la permission manager
peut forcer leur disponibilité. La dérogation est persistante, survit aux
reconnexions et redémarrages, et dure jusqu’à sa désactivation manuelle. Les
deux gestes sont inscrits dans `audit_log` avec auteur et date. Le créneau se
terminant à `00:00` doit fonctionner correctement.

Ce mécanisme est distinct des promotions. La disponibilité locale existante
continue à permettre une rupture manuelle ; le calcul effectif combine état de
l’article, disponibilité locale, horaire et dérogation persistante.

## Images

Associer les images par nom normalisé sans inventer de correspondance. Une
image ambiguë reste non affectée. Conserver les originaux et produire des WebP
optimisés dans un cadre carré cohérent (cible 800 × 800, qualité 82–88) :

- aucune découpe du plat ;
- ratio d’origine conservé ;
- orientation EXIF corrigée ;
- aucune déformation ;
- marges noires discrètes si nécessaire ;
- rendu avec `object-fit: contain`, y compris dans Commande et Réglages.

Ne pas générer de photo manquante. Le logo suit un traitement séparé adapté à
l’interface et à l’impression monochrome ESC/POS.

## Inventaire initial

Les stocks commencent à zéro. Créer :

- Poulet de chair (`u`)
- Poulet hybride (`u`)
- Pintade (`u`)
- Boisson 1 000 (`u`)
- Boisson 1 500 (`u`)

Une vente entière consomme 1,000 unité ; une demi-portion consomme 0,500 ; une
boisson consomme 1,000. Les lignes de commande restent en quantités entières :
la fraction se trouve dans la recette d’inventaire. Deux demis doivent retirer
exactement 1,000 unité sans erreur d’arrondi. Les autres recettes ne sont pas
créées avant d’avoir leurs données réelles.

## Ticket et paramètres

Initialiser l’entête configurable avec :

```text
À LA BRAISE
Yopougon Maroc
À 100 m de l’antenne Maroc
Tél. : 07 01 11 11 18
```

Le pied reste vide jusqu’à sa saisie pendant l’installation. Conserver dans les
paramètres locaux l’adresse, les coordonnées, le lien Google Maps et les réseaux
sociaux si le schéma restaurant ne les porte pas déjà.

## Tests et acceptation

Les tests automatisés doivent prouver : compatibilité de la troisième marque,
logo correct, import idempotent, 34 tables physiques et 3 virtuelles, catalogue
et prix attendus, repli des prix livraison, trois créneaux horaires dont minuit,
refus serveur hors créneau, autorisation manager persistante et auditée, ordre
de la catégorie du jour, stocks à zéro, consommation exacte des demi-portions,
et affichage des images sans rognage.

Le parcours manuel vérifie l’identité et le thème, chaque plage horaire, la
dérogation après redémarrage, une commande Glovo sans prix canal, deux ventes de
demi-poulet, la salle complète et le ticket de test.

Les commandes finales sont `pnpm test` puis `pnpm build`. Aucun seed destructif
ne doit être exécuté sur une base contenant des ventes.
