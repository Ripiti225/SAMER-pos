# Visites QR et géolocalisation — conception

## Objectif

Empêcher un client qui scanne le QR d'une table de voir la commande ou le reçu
du client précédent, tout en permettant au client courant de commander de
nouveau après son paiement depuis la page déjà ouverte. Une nouvelle ouverture
du QR dans un nouvel onglet représente une nouvelle visite et démarre vide.

Les actions QR peuvent être limitées à un rayon configurable autour du
restaurant, fixé à 50 mètres par défaut. La décision est toujours prise côté
serveur à partir d'une position fournie par le navigateur.

## Modèle de données

Créer `visites_qr` avec un UUID aléatoire exposé comme jeton opaque, la table,
les dates de création/expiration/dernière activité et les informations de la
dernière vérification de position. Une visite expire six heures après sa
création.

Ajouter `commandes.visite_qr_id`, nullable :

- une commande `CLIENT_QR` porte la visite qui l'a créée ;
- une commande saisie à la caisse ou sur la tablette conserve `NULL` ;
- suivi et reçus publics exigent la même table et la même visite.

`sql/schema.sql` reste la source de vérité et le schéma Drizzle doit en rester
le miroir exact. Une migration delta `0033_visites_qr.sql` applique le modèle.

## Cycle d'une visite

1. L'app lit le QR permanent `/t/:qr_token` et charge la table.
2. Si `sessionStorage` contient une visite de cette table, l'app demande au
   serveur de la reprendre. Sinon elle crée une nouvelle visite.
3. Une nouvelle ouverture dans un nouvel onglet n'a pas le `sessionStorage` de
   l'onglet précédent et reçoit donc une visite vide.
4. Chaque appel, commande, lecture du suivi et téléchargement de reçu porte
   `X-Visite-QR`.
5. Après paiement, la table physique reste libérée par le mécanisme existant.
   Le client courant voit son reçu et peut choisir « Commander autre chose » ;
   les nouveaux produits créent une nouvelle commande dans la même visite.

Le reçu est téléchargé par `fetch` avec l'en-tête de visite, puis ouvert via
une URL Blob. Le jeton de visite n'est donc jamais placé dans l'URL du reçu.

## Géolocalisation

Ajouter quatre paramètres locaux éditables :

- `client_qr_geolocalisation_activee`, défaut `false` ;
- `client_qr_latitude`, défaut `0` ;
- `client_qr_longitude`, défaut `0` ;
- `client_qr_rayon_metres`, défaut `50`.

Quand le contrôle est activé, le serveur refuse de créer/reprendre une visite,
d'envoyer un appel ou de créer une commande sans position. Il calcule la
distance de Haversine et refuse toute distance strictement supérieure au rayon.
Les coordonnées doivent être configurées avant activation. Le navigateur doit
être dans un contexte HTTPS pour fournir la position ; l'app affiche une erreur
française claire en cas de refus, d'indisponibilité ou de contexte non sécurisé.

La position est redemandée avant chaque action qui produit un effet (appel ou
commande). Le suivi et le reçu restent accessibles au client courant après son
départ, dans la limite de validité de la visite et de la fenêtre existante du
reçu.

## Sécurité et confidentialité

- Le QR permanent n'autorise plus à lire les commandes d'une table.
- Un jeton de visite inconnu, expiré ou rattaché à une autre table reçoit une
  erreur générique et ne révèle aucune commande.
- Une commande caisse n'est jamais visible par une visite QR.
- La géolocalisation est un contrôle de proximité et non une preuve
  infalsifiable ; les règles d'accès aux données restent garanties par le
  jeton aléatoire de visite.

## Validation

Les tests d'intégration couvrent deux visites successives, le reçu de l'ancien
client, les commandes caisse, la possibilité de recommander et les décisions
de distance à 50 m. La livraison exige ensuite la suite serveur complète, les
builds TypeScript du monorepo et `git diff --check`.
