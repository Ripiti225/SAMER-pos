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
- les 34 tables physiques, la table KDO en RC et les tables GLOVO, YANGO et LIVRAISON DIRECTE ;
- le menu, les options à 500 FCFA, la sauce du jour par jour de semaine et les
  photos optimisées — sans aucune plage horaire : une catégorie hors plage
  refusait la vente sans que le comptoir puisse la rouvrir (2026-09-25) ;
- les cinq produits de stock initiaux et les recettes poulet/boissons ;
- uniquement les deux comptes propriétaires provenant du seed commun.

L'import peut être rejoué tant qu'aucune vente n'existe. Il est refusé si le
poste appartient déjà à un autre restaurant ou si des lignes de commande sont
présentes.

## Contrôles avant ouverture

### Poste déjà configuré mais affichant les produits Samer (sans commandes)

Le choix du restaurant dans Réglages ne charge pas son menu. Les anciennes
versions attribuaient aussi la marque SAMER à À la Braise. Le correctif reconnaît
son nom SamerTrackly et conserve l'UUID du site lors de l'import du profil.

Sur le **mini-PC À la Braise**, appliquer les fichiers du correctif au dossier
POS-Samer existant, puis lancer `corriger-a-la-braise.bat` à sa racine,
avec PosSamer.exe ouvert pour que PostgreSQL soit démarré. Ne saisir aucune
commande pendant l'opération. Fermer puis relancer PosSamer.exe après le message
de réussite et reconnecter les autres terminaux.

Le script applique les migrations et importe le profil existant : menu,
options, salle, paramètres du profil et inventaire initial. Il retire les
promotions du catalogue précédent. Il refuse un autre restaurant ou une base
contenant une commande, même vide. L'import est transactionnel : un échec annule
ses changements. Les comptes, l'identifiant d'un site À la Braise déjà configuré
et les paramètres de liaison SamerTrackly/cloud sont conservés.

**Ne pas relancer `db:seed` ou `preparer-app.bat` pour cette réparation** : ils
réinitialisent les données. Ne pas recopier le dossier `data` du PC de préparation.

### Vérification du menu

1. Vérifier le nom `À la Braise` et l'accent or à l'écran de connexion.
2. Vérifier RC 1–4, Salle 1–15 et Terrasse 1–15.
3. Imprimer un ticket test : le logo À la Braise doit apparaître en haut.
4. Vérifier les créneaux Placali 00h–16h, Sauces 10h–00h et Barbecues 16h–00h.
5. Dans Réglages → Plats du jour, tester une réactivation exceptionnelle avec motif.
6. Saisir les premières entrées de stock avant les ventes.

Les tarifs GLOVO/YANGO utilisent provisoirement le prix sur place. Les tarifs
majorés seront saisis dans les réglages dès qu'ils seront communiqués.
