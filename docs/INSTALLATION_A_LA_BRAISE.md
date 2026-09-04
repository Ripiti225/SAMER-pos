# Installation du site À la Braise

Le site utilise le même POS que le groupe, avec une base locale et un identifiant
de restaurant propres. Le seed commun reste neutre : le profil réel n'est chargé
que sur le mini-PC destiné à À la Braise.

## Première installation

Sur une base neuve, depuis la racine du projet :

```bash
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm profil:importer -- --code=ALA_BRAISE
pnpm build
```

L'import crée un nouvel UUID de restaurant et installe :

- l'identité, les coordonnées et les couleurs noir/or ;
- les 34 tables physiques et les tables GLOVO, YANGO et LIVRAISON DIRECTE ;
- le menu, les options à 500 FCFA, les horaires et les photos optimisées ;
- les cinq produits de stock initiaux et les recettes poulet/boissons ;
- uniquement les deux comptes propriétaires provenant du seed commun.

L'import peut être rejoué tant qu'aucune vente n'existe. Il est refusé si le
poste appartient déjà à un autre restaurant ou si des lignes de commande sont
présentes.

## Contrôles avant ouverture

1. Vérifier le nom `À la Braise` et l'accent or à l'écran de connexion.
2. Vérifier RC 1–4, Salle 1–15 et Terrasse 1–15.
3. Imprimer un ticket test : le logo À la Braise doit apparaître en haut.
4. Vérifier les créneaux Placali 04h–10h, Sauces 10h–16h et Barbecues 16h–00h.
5. Dans Réglages → Plats du jour, tester une réactivation exceptionnelle avec motif.
6. Saisir les premières entrées de stock avant les ventes.

Les tarifs GLOVO/YANGO utilisent provisoirement le prix sur place. Les tarifs
majorés seront saisis dans les réglages dès qu'ils seront communiqués.
