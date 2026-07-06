# SPRINT 4B+4C — ADMINISTRATION (Réglages) + SUPERVISEUR & RÔLES PERSONNALISÉS

Ce brief fusionne deux chantiers volontairement livrés ENSEMBLE : le système de permissions se construit D'ABORD, puis le module Réglages se bâtit directement dessus. Ne pas implémenter l'un sans l'autre.

Objectifs :
1. Les comptes d'encadrement gèrent TOUTE la partie technique depuis l'app (équipe, tables, catalogue, paramètres) — plus jamais de terminal ni de base de données.
2. Un rôle SUPERVISEUR a tous les accès du PROPRIETAIRE et pilote QUI VOIT QUOI : il active/désactive des sections pour n'importe quel rôle et crée autant de rôles personnalisés qu'il veut. Le compte PROPRIETAIRE lui est INTOUCHABLE.

Rappels : interface en FRANÇAIS, montants FCFA, chaque règle appliquée CÔTÉ SERVEUR, thème clair existant, aucun test cassé, un commit par étape, hors périmètre → docs/BACKLOG_V2.md.

═══════════════════════════════════════════════════════════════════
PARTIE 1 — FONDATION : PERMISSIONS ET RÔLES (à faire en premier)
═══════════════════════════════════════════════════════════════════

## 1.1 Catalogue de permissions (fixe, défini dans le code)
Un fichier unique `packages/shared/permissions.ts` exporte la liste exhaustive des permissions, groupées par section, avec libellés français. On COMPOSE des rôles à partir de ce catalogue ; on n'invente pas de capacités. Groupes attendus (compléter selon les fonctionnalités réelles) :
- **Caisse** : ouvrir un service, encaisser, remise, annuler article envoyé, rouvrir commande payée, clôturer, imprimer note
- **Salle** : prendre commande, envoyer en cuisine, transférer table, voir toutes les tables (vs seulement les siennes)
- **Cuisine** : avancer les commandes KDS
- **Rapports** : rapport X, rapport Z, tableau de bord, récap notation
- **Réglages** : équipe, salle & QR, disponibilité plats, catalogue, fidélité, paramètres, corrections pointage, journal d'audit, santé système
- **Rôles & accès** : gérer les rôles (permission PROTÉGÉE, voir 1.4)

## 1.2 Migration du modèle de rôles
- Nouvelles tables : `roles(id UUID, nom TEXT UNIQUE, systeme BOOLEAN, actif BOOLEAN)` et `role_permissions(role_id, permission_cle, PRIMARY KEY(role_id, permission_cle))`.
- `utilisateurs.role` (enum) → `utilisateurs.role_id`. Migration automatique : créer les rôles système PROPRIETAIRE, SUPERVISEUR, MANAGER, CAISSIER, SERVEUR, CUISINE avec leurs permissions actuelles, raccorder les utilisateurs existants (ils gardent EXACTEMENT leurs accès). `poste_cuisine` inchangé.
- Tous les guards serveur passent de « vérifier le rôle » à « vérifier la permission » (`exigePermission('caisse.remise')`). Aucune vérification ne reste basée sur le nom du rôle, SAUF les invariants du 1.5.
- Rôles et permissions partent dans la synchro (outbox) comme les utilisateurs.

## 1.3 Le rôle SUPERVISEUR
- Toutes les permissions du catalogue, en permanence (comme PROPRIETAIRE).
- Seul un PROPRIETAIRE peut créer ou désactiver un compte SUPERVISEUR.
- Le SUPERVISEUR ne peut PAS : créer/modifier/désactiver/réinitialiser un compte PROPRIETAIRE, ni promouvoir quiconque PROPRIETAIRE ou SUPERVISEUR, ni modifier les rôles PROPRIETAIRE et SUPERVISEUR eux-mêmes. Toute tentative → 403 « Le compte propriétaire est protégé » + audit.

## 1.4 Permission protégée
La permission « Rôles & accès » ne peut JAMAIS être cochée sur un rôle personnalisé ni sur MANAGER/CAISSIER/SERVEUR/CUISINE. Elle appartient exclusivement à SUPERVISEUR et PROPRIETAIRE (verrou côté serveur, pas seulement UI).

## 1.5 Invariants de sécurité (INCONTOURNABLES, quel que soit le rôle)
Codés en dur, aucune permission ne peut les contourner :
- Comptage à l'aveugle : personne ne voit le théorique avant la saisie des espèces comptées.
- Remise, annulation d'article envoyé, réouverture, correction de pointage : motif obligatoire + audit, toujours.
- Le journal d'audit reste en ajout seul pour tout le monde.
- Le PROPRIETAIRE a toujours toutes les permissions (même si une ligne role_permissions manquait, le guard le laisse passer) — garantie anti-verrouillage : impossible d'aboutir à un système où plus personne n'a accès aux réglages.
- Une commande client (QR) ne va jamais en cuisine sans validation humaine.

═══════════════════════════════════════════════════════════════════
PARTIE 2 — MODULE ADMINISTRATION (Réglages), bâti sur la Partie 1
═══════════════════════════════════════════════════════════════════

L'espace Administration est une zone de la PWA caisse : onglet « Réglages » visible uniquement si l'utilisateur possède au moins une permission du groupe Réglages. Chaque section n'apparaît que si la permission correspondante est accordée ; côté serveur, chaque route exige sa permission (403 sinon). Toute action d'administration écrit une ligne d'audit (qui, quoi, avant/après dans meta).

Permissions par défaut des rôles système : MANAGER = toutes les sections Réglages SAUF catalogue (lecture seule), fidélité et Rôles & accès ; PROPRIETAIRE et SUPERVISEUR = tout.

## 2.1 Équipe (utilisateurs)
- Liste des employés : nom, rôle (liste déroulante de TOUS les rôles actifs, système et personnalisés), poste cuisine, téléphone, actif/inactif, dernier pointage.
- **Ajouter un employé** : nom complet, rôle, poste cuisine si besoin, téléphone. Le PIN est saisi par l'employé lui-même en deux fois sur un écran dédié (l'encadrant ne connaît jamais le PIN). Règles PIN existantes appliquées. Restrictions : attribuer PROPRIETAIRE ou SUPERVISEUR obéit au 1.3.
- **Réinitialiser un PIN** : code temporaire à usage unique affiché une fois ; l'employé choisit son nouveau PIN à sa première connexion. Audit REINIT_PIN.
- **Désactiver** (départ) : immédiat, sessions coupées, ne peut plus pointer ni se connecter. Jamais de suppression (l'historique référence l'employé).
- Les utilisateurs créés localement remontent au cloud (outbox) ; ceux du siège descendent (conflit : le cloud gagne).

## 2.2 Salle (zones & tables)
- Créer/renommer/ordonner les zones ; créer/renommer/désactiver les tables ; effet immédiat sur caisse + tablettes (WebSocket).
- Une table avec une commande en cours ne peut pas être désactivée (message clair).
- **QR de table** : chaque table a son qr_token. Boutons : « Voir le QR », « Régénérer » (invalide l'ancien), et **« Imprimer les QR »** : PDF prêt à imprimer (un carré par table : logo/couleur marque, « Scannez pour commander et noter », nom de la table, QR). Librairie : `qrcode` + PDF côté serveur.
- Tables virtuelles partenaires (Yango/Glovo/SAMER DELIV) gérées ici aussi.

## 2.3 Plats du jour (disponibilité — accès rapide)
- Grille de tous les articles avec interrupteur Disponible/Épuisé, effet immédiat sur caisse, tablettes et page client.
- IMPORTANT : la disponibilité est LOCALE. Migration : flag déplacé vers `disponibilite_locale(article_id PK, disponible, updated_at)` afin qu'une descente de catalogue n'écrase jamais un « épuisé » posé sur place. La descente crée les lignes manquantes à TRUE. La disponibilité remonte au cloud à titre d'information.

## 2.4 Catalogue
- CRUD complet : catégories, articles (nom, description, prix de base, image), prix par canal, groupes d'options, suppléments, combos, promotions (happy hour : type, valeur, plage horaire, jours).
- **Architecture** : l'édition écrit dans le CLOUD via une Edge Function `admin-catalogue` (authentifiée par la session + la clé du site), qui incrémente les versions ; les modifications redescendent par la synchro normale (< 5 min). Bandeau UI : « Les modifications du catalogue s'appliquent dans les 5 minutes. »
- Hors ligne : édition du catalogue indisponible (« Modification du menu impossible sans internet. La vente, elle, continue normalement. »). La disponibilité (2.3) reste toujours modifiable.
- Les commandes existantes ne changent JAMAIS (snapshots — règle existante).

## 2.5 Fidélité — barème : points par tranche de FCFA, valeur du point, seuil d'utilisation. Même circuit cloud→descente que le catalogue.

## 2.6 Paramètres du restaurant
Écran unique listant les `parametres_locaux` éditables avec libellés français et valeurs par défaut visibles : verrouillage caisse (minutes), seuil d'alerte écart de caisse (FCFA), seuils chrono KDS (min), rayon de pointage (m) + bouton « Utiliser ma position actuelle » pour lat/lng, délai d'expiration des commandes client (min), plafond SMS mensuel, sons (activer/tester chaque son avec ▶), coordonnées du ticket (en-tête/pied du reçu). Chaque changement : effet immédiat + audit MODIF_PARAMETRE (avant/après).

## 2.7 Outils d'encadrement
- **Corrections de pointage** (motif obligatoire — flux existant, avec une vraie UI ici).
- **Transferts de table** (existant, rangé ici).
- **Journal d'audit** : lecture seule, filtres (période, employé, action).
- **Santé du système** : la page existante (voyants) vit ici, plus le bouton de redémarrage.

## 2.8 Écran « Rôles & accès » (SUPERVISEUR et PROPRIETAIRE uniquement)
- Liste des rôles (système et personnalisés) avec nombre d'employés par rôle.
- **Modifier un rôle** : cases à cocher groupées par section (libellés du catalogue 1.1). MANAGER, CAISSIER, SERVEUR, CUISINE sont modifiables (activer/désactiver des sections). PROPRIETAIRE et SUPERVISEUR verrouillés, grisés avec un cadenas.
- **Créer un rôle** : nom libre + coches. Nombre illimité. Bouton « Dupliquer » pour partir d'un rôle existant.
- Un rôle utilisé par au moins un employé ne peut pas être supprimé, seulement désactivé (réaffecter d'abord).
- Effet en TEMPS RÉEL : modifier un rôle met à jour immédiatement l'interface des employés connectés (WebSocket) — les sections retirées disparaissent sans reconnexion, et le serveur refuse (403) même si l'UI n'a pas rafraîchi.
- Chaque modification → audit MODIF_ROLE avec avant/après (liste des permissions).

═══════════════════════════════════════════════════════════════════
DÉFINITION DE « TERMINÉ » (fusionnée)
═══════════════════════════════════════════════════════════════════

1. Migration : les employés existants conservent exactement leurs accès d'avant ; tous les tests existants passent.
2. Un CAISSIER ne voit pas l'onglet Réglages et reçoit 403 sur toute route admin (test).
3. Parcours complet sans terminal ni base : créer une zone « Étage », 3 tables, un serveur « Fatou » (PIN choisi par elle), imprimer le PDF des QR, marquer un plat Épuisé (disparaît partout en < 2 s), corriger un pointage.
4. PROPRIETAIRE modifie un prix → cloud immédiatement → redescendu en < 5 min → une commande passée avant garde l'ancien prix. Une descente de catalogue n'écrase pas un « Épuisé » local (test).
5. Un PROPRIETAIRE crée un SUPERVISEUR ; le SUPERVISEUR accède à tout, y compris Rôles & accès.
6. Le SUPERVISEUR décoche « Rapport X » du rôle MANAGER → un manager connecté perd la section instantanément et reçoit 403 sur la route (test API).
7. Le SUPERVISEUR crée un rôle « Caissier senior » (= caissier + remise), l'attribue → l'employé peut faire une remise (motif exigé), un caissier normal non.
8. Le SUPERVISEUR tente de réinitialiser le PIN d'un PROPRIETAIRE et de modifier le rôle PROPRIETAIRE → 403 + audit dans les deux cas.
9. Personne ne peut cocher « Rôles & accès » sur un rôle personnalisé (test serveur).
10. Test anti-verrouillage : même avec des rôles mal configurés, le PROPRIETAIRE accède toujours aux réglages.
