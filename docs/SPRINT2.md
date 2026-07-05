# SPRINT 2 — KDS (écran cuisine) + App Serveur (tablette)

## Prérequis

- Le sprint 1 (cœur caisse) est fonctionnel et committé. **Ne rien casser du sprint 1** : tout le parcours caisse (commande → paiement mixte → clôture aveugle → rapport Z) doit continuer à passer, tests inclus.
- Relire `CLAUDE.md` : le stack, les conventions et les règles métier restent identiques. Interface 100 % en FRANÇAIS, montants en FCFA (INTEGER).
- Le schéma `sql/schema.sql` contient déjà tout le nécessaire (`commande_items.statut_cuisine`, `tables_salle`, `zones`). Si une migration est nécessaire, la générer avec drizzle-kit, jamais de modification manuelle de la base.

## Périmètre du sprint 2

Deux nouvelles PWA dans le monorepo + les routes serveur associées :

```
apps/
├── caisse/     (existant — ne pas toucher sauf points listés en fin)
├── kds/        (NOUVEAU — écran cuisine)
└── serveur/    (NOUVEAU — tablette des serveurs de salle)
```

EXCLUS (backlog) : synchro cloud, notation QR, pointage, fidélité, impression réelle. Toujours passer par l'interface `PrinterService` existante.

---

## A. KDS — Écran cuisine

Cible : un écran/tablette fixé en cuisine, tactile, consulté à 2 mètres de distance.

### A1. Affichage
- Grille de **cartes de commande**, ordonnées de la plus ancienne à la plus récente (gauche → droite).
- Chaque carte : numéro de ticket en TRÈS grand, type (SUR PLACE / EMPORTER / LIVRAISON + partenaire), table, heure d'envoi, **chronomètre écoulé** (mm:ss), liste des articles avec quantités, options et suppléments bien lisibles.
- Code couleur du chronomètre : vert < 10 min, orange 10–20 min, rouge > 20 min (seuils dans `parametres_locaux`).
- Un article annulé après envoi apparaît BARRÉ en rouge avec la mention « ANNULÉ » (jamais supprimé de la carte).
- Police et boutons très grands : lisible à distance, utilisable avec des doigts mouillés/gras.

### A2. Interactions (ultra simples — 2 boutons par carte)
- **« Commencer »** : passe tous les articles de la carte à EN_COURS.
- **« Prêt »** : passe la carte à PRET → la carte quitte la grille et va dans une colonne latérale « Prêtes » (les 10 dernières), d'où on peut la rappeler en cas d'erreur (« Reprendre »).
- Pas de gestion par article individuel en v1 : la carte entière change d'état.

### A3. Sons différenciés (§15.2 du cahier des charges)
- Nouvelle commande → son distinct selon le type : sur place / emporter / livraison (3 fichiers audio dans `apps/kds/public/sons/`, générés ou libres de droits).
- Une commande passée en rouge (> 20 min) → bip d'alerte discret, une seule fois.
- Bouton mute visible (le son se réactive seul après 30 min pour éviter l'oubli).

### A4. Temps réel
- Le KDS s'abonne au WebSocket existant du serveur : événements `commande:envoyee`, `commande_item:annule`, `commande:modifiee`.
- Si le WebSocket se déconnecte (coupure WiFi) : bandeau discret « Reconnexion... » + re-synchronisation complète de la grille à la reconnexion (requête GET des commandes non prêtes). Aucune commande ne doit être perdue à l'écran.

### A5. Auth KDS
- Écran de connexion simplifié : sélection du poste (CUISINIER / PIZZAIOLO / COMPTOIRISTE) + PIN d'un utilisateur role CUISINE.
- Session longue durée (toute la journée), verrouillage inactivité désactivé pour le KDS.

---

## B. App Serveur — tablette de salle

Cible : serveurs en mouvement, tablette Android d'entrée de gamme, WiFi parfois instable.

### B1. Plan de salle
- Vue par zones (onglets : RC, Terrasse, VIP...), tables en grille de gros boutons.
- Couleur des tables : gris = LIBRE, orange = OCCUPEE, bleu = ADDITION_DEMANDEE.
- Taper une table LIBRE → nouvelle commande sur cette table. Taper une table OCCUPEE → voir/compléter la commande en cours.

### B2. Prise de commande
- Même moteur que la caisse (réutiliser les composants : les extraire dans `packages/shared-ui` si nécessaire) : catégories → articles → options/suppléments → quantités.
- Bouton unique **« Envoyer en cuisine »** : les articles partent au KDS, la commande passe à ENVOYEE_CUISINE, la table à OCCUPEE.
- Ajout en plusieurs fois autorisé (le client recommande) : seuls les NOUVEAUX articles partent en cuisine à chaque envoi.
- Le serveur NE PEUT PAS encaisser, faire une remise, ni annuler un article déjà envoyé (ces actions restent à la caisse) — appliqué côté serveur par le guard de rôle.

### B3. Demande d'addition
- Bouton « Demander l'addition » sur une table → statut ADDITION_DEMANDEE → la caisse voit la table passer en bleu dans sa liste de tables et peut ouvrir la commande pour encaisser.

### B4. File d'attente locale ANTI-COUPURE WIFI (critique — §16 risque 7)
- Chaque action (envoi cuisine, demande d'addition) est d'abord écrite dans une **file locale persistante** (IndexedDB via `idb`), puis envoyée au serveur.
- Si le serveur ne répond pas : l'action reste en file, l'UI affiche une pastille orange « En attente de connexion » et le serveur de salle peut CONTINUER à prendre des commandes.
- À la reconnexion : rejeu automatique de la file dans l'ordre. Idempotence : chaque action porte un UUID généré sur la tablette ; le serveur ignore un UUID déjà traité (table `actions_recues(uuid PRIMARY KEY, traite_le)` à ajouter par migration).
- Test obligatoire : simuler une coupure (couper le serveur 30 s pendant une prise de commande) → aucune perte, aucun doublon.

### B5. Auth serveur
- Connexion PIN (role SERVEUR). Verrouillage après 120 s d'inactivité (plus long que la caisse : ils bougent).
- L'app affiche en permanence le nom du serveur connecté (les commandes prises lui sont attribuées via `serveur_id` — nécessaire pour la notation du sprint 4).

---

## C. Modifications côté caisse (minimales)

- L'écran « Tables » (liste simple du sprint 1) devient le plan de salle par zones, partagé avec l'app serveur (composant commun).
- La caisse voit les statuts de table en temps réel (WebSocket) et un badge sur les tables ADDITION_DEMANDEE.
- À l'encaissement d'une commande de table : la table repasse à LIBRE.

---

## Définition de « terminé » (sprint 2)

1. `pnpm dev` démarre serveur + caisse + kds + serveur (4 processus, ou un script racine).
2. Parcours croisé complet sur 2 navigateurs côte à côte :
   - Tablette serveur : table T3 → 2 articles → Envoyer en cuisine
   - KDS : la carte apparaît avec son « sur place » → Commencer → Prêt
   - Tablette : Demander l'addition → la caisse voit T3 en bleu → encaissement → T3 repasse LIBRE
3. Test de coupure : arrêter le serveur 30 s pendant une prise de commande tablette → reprendre → la commande arrive en cuisine sans doublon.
4. Un article annulé depuis la caisse (PIN manager + motif) apparaît barré sur le KDS.
5. Tests Vitest verts, y compris : idempotence des UUID d'actions, guard de rôle (un SERVEUR qui tente d'encaisser reçoit 403), transitions de statut de table.
6. Les tests du sprint 1 passent toujours tous.

## Rappels de travail

- Commits conventionnels en français, un commit par fonctionnalité qui marche.
- Toute idée hors périmètre → `docs/BACKLOG_V2.md`.
- Chaque règle métier est appliquée côté serveur, jamais uniquement dans l'UI.
