# CORRECTIONS POST-TEST (retours terrain Ange)

Ces corrections viennent d'un test réel. Elles priment sur les specs précédentes en cas de contradiction. Toujours : interface en FRANÇAIS, montants en FCFA, chaque règle appliquée côté serveur, ne rien casser des tests existants, un commit par correction.

---

## Correction 1 — Le verrouillage caisse est trop agressif

Problème : le caissier est déconnecté/verrouillé dès qu'il s'éloigne un instant, ce qui bloque le travail.

À faire :
- Porter le délai de verrouillage par inactivité de la caisse à **10 minutes** (600 s), valeur lue dans `parametres_locaux` clé `verrou_inactivite_caisse_secondes` (défaut 600) — modifiable par le manager.
- Bien distinguer les deux notions (déjà prévu, à vérifier) : un verrouillage NE déconnecte PAS et NE ferme PAS le service ; il masque l'écran et se rouvre par PIN en 1 geste. Le service reste OUVERT, les ventes et compteurs sont conservés.
- Retirer tout verrouillage déclenché par autre chose que l'inactivité réelle (pas de verrouillage au changement d'écran, au retour d'onglet, à la perte de focus).
- Le déverrouillage par PIN ré-affiche exactement l'écran quitté (même commande en cours).

---

## Correction 2 — La demande d'addition doit alerter la caisse (son + notification)

Problème : quand un serveur demande l'addition, rien n'attire l'attention du caissier.

À faire :
- À la réception d'un événement `table:addition_demandee` (WebSocket), la caisse joue un **son** distinct (fichier dans `apps/caisse/public/sons/addition.mp3`) ET affiche une **notification visible** : un bandeau/toast « Table X demande l'addition » qui reste jusqu'à ce que le caissier ouvre la table.
- La table concernée passe visuellement en évidence dans la liste/plan de salle (badge + couleur bleue).
- Un compteur du nombre d'additions en attente est visible en permanence sur l'accueil caisse.
- Bouton mute optionnel, mais le son se réactive seul après 15 min (ne jamais rester muet en silence).
- Le son ne doit se jouer qu'une fois par demande (pas de répétition en boucle).

---

## Correction 3 — Le KDS (cuisine) ne doit PAS demander de PIN

Problème : en cuisine, saisir un code avant de voir les commandes ralentit et n'a aucun sens (écran partagé, mains occupées).

À faire :
- Supprimer complètement l'écran de connexion PIN du KDS. Le KDS s'ouvre **directement** sur la grille des commandes au démarrage.
- Le KDS est un écran d'affichage/production : il montre les commandes et permet Commencer / Prêt / Annuler l'affichage. Il ne donne accès à AUCUNE donnée sensible (pas de chiffre d'affaires, pas de rapport, pas de caisse, pas de liste de personnel). Vérifier qu'aucune route sensible n'est atteignable depuis le KDS.
- L'appareil KDS s'identifie par un **jeton d'appareil** (device token) configuré une seule fois à l'installation (dans `parametres_locaux`), pas par un humain à chaque fois.

---

## Correction 4 — Supprimer le choix de poste sur le KDS ; attribution automatique par le pointage

Problème : demander CUISINIER / PIZZAIOLO / COMPTOIRISTE sur le KDS est redondant et ralentit. Le rôle est déjà défini par le caissier, et connu au moment où la personne pointe son arrivée.

Modèle correct :
- Le poste de cuisine d'un employé est une propriété de son compte (`utilisateurs.poste_cuisine`), définie en amont (par le manager/caissier), PAS choisie sur le KDS.
- Quand un employé de cuisine **pointe son arrivée** (module pointage), il devient « en poste ». La liste des cuisiniers en poste est déduite des pointages ouverts du jour — aucune sélection manuelle sur le KDS.
- **Attribution automatique des plats** : un plat préparé est attribué aux employés dont le `poste_cuisine` correspond au type de l'article ET qui sont en poste (pointés) au moment de la préparation. Règle de correspondance à stocker dans une table simple `mapping_poste_categorie(poste_cuisine, categorie_id)` — ex. Pizzas → PIZZAIOLO, Boissons/comptoir → COMPTOIRISTE, le reste → CUISINIER. Si plusieurs personnes du même poste sont en poste, l'attribution est collective (comme pour la notation, §6 du cahier des charges).
- Conséquence : le KDS n'a plus aucune notion d'identité de cuisinier. Il affiche et fait avancer les commandes, point. L'attribution est calculée côté serveur à partir des pointages, de façon invisible pour la cuisine.
- Si aucun employé du poste requis n'est pointé au moment de la préparation, l'attribution reste vide (à rattacher plus tard) et n'empêche jamais le service.

Note : le module pointage complet arrive à un sprint ultérieur. Pour l'instant, préparer la structure (`mapping_poste_categorie`, calcul d'attribution côté serveur) et, tant que le pointage n'est pas là, considérer tous les employés cuisine actifs comme « en poste » par défaut, pour ne pas bloquer.

---

## Correction 5 — Refonte du design : clair, vivant, coloré, orienté rapidité en plein rush

Problème : l'app est trop sombre, sans réel travail de design.

Nouvelle direction visuelle (thème clair, à appliquer aux 3 apps : caisse, KDS, serveur). Créer un fichier de thème partagé `packages/theme/theme.css` (variables CSS) et l'utiliser partout, pour que le rebranding Samer↔Al Kayan se fasse en changeant une seule variable.

### Système de couleurs
```
--fond-page      : #F7F5F0   (fond chaud clair, PAS blanc pur, PAS sombre)
--surface-carte  : #FFFFFF   (cartes articles, addition)
--bordure        : #E5E2DA   (hairline discrète)
--texte-fort     : #2C2C2A   (quasi noir chaud)
--texte-doux     : #5F5E5A   (gris chaud secondaire)

/* Accent = couleur de marque, lu depuis restaurant.couleur_hex */
--marque         : #EF9F27   (Samer)  ou  #2D7D46 (Al Kayan)
--marque-foncee  : #BA7517   (Samer)  ou  #1B5E33 (Al Kayan)  /* pour le texte des prix */
--marque-tint    : #FAEEDA   (Samer)  ou  #E3F0E7 (Al Kayan)  /* fonds légers */

/* Couleurs FONCTIONNELLES (identiques pour les 2 marques) — reconnaissables sans lire */
--ok             : #2D7D46   (validé, encaisser, prêt)
--ok-tint        : #EAF3DE
--alerte         : #D85A30   (urgent, écart, retard)
--alerte-tint    : #FAECE7
--info           : #378ADD   (sur place, addition demandée)
--info-tint      : #E6F1FB
```

### Règles visuelles
- Fond de page toujours `--fond-page` (clair). Jamais de grand aplat sombre.
- Cartes blanches, coins arrondis 11–12px, bordure hairline `--bordure`, pas d'ombre lourde (ombre très légère au survol seulement).
- Boutons tactiles : hauteur mini **48px**, texte 15px, coins 10px. Le bouton d'action principal de chaque écran est plein couleur (`--ok` pour encaisser, `--marque` pour nouvelle commande) ; les secondaires sont blancs bordés.
- Prix affichés en `--marque-foncee`, poids 500, jamais en gris pâle.
- Total d'addition en très grand (22–24px), toujours visible, jamais à faire défiler.
- Catégorie active = pastille pleine `--marque` ; catégories inactives = blanches bordées.
- Article indisponible = carte grisée (opacité 45%) + mention « Épuisé », non cliquable.
- Icônes simples et grandes (jeu d'icônes outline cohérent). Pas d'emoji.
- Casse : phrases en minuscules (sentence case), jamais de TOUT EN MAJUSCULES.
- Messages en français courant, orientés action. Erreurs : dire quoi s'est passé + quoi faire, sans code technique.

### KDS (cuisine) — spécifique
- Même base claire mais contraste renforcé pour lecture à 2 m : cartes plus grandes, numéro de ticket géant.
- Le CHRONOMÈTRE porte la couleur fonctionnelle : `--ok` < 10 min, `--alerte-tint`/orange 10–20 min, `--alerte` (rouge) > 20 min. C'est le seul élément vraiment coloré, pour attirer l'œil sur ce qui traîne.

### Objectif
Un caissier doit, d'un seul coup d'œil en plein rush, repérer : le total à encaisser, les tables qui demandent l'addition, et les articles épuisés — sans lire, juste par la couleur et la taille.

---

## Définition de « terminé » (corrections)

1. Caisse : après 3 minutes sans toucher l'écran, PAS de verrouillage ; après 10 min, verrouillage → PIN → on retrouve la commande en cours intacte.
2. Une demande d'addition depuis la tablette serveur déclenche son + toast sur la caisse, table en bleu, compteur incrémenté.
3. Le KDS s'ouvre directement sur les commandes, sans aucun écran de code, et aucune donnée de caisse/CA n'y est accessible.
4. Le KDS n'affiche plus jamais de sélection de poste ; un test montre qu'un plat préparé est attribué automatiquement au bon poste (via le mapping) côté serveur.
5. Les 3 apps utilisent le thème clair partagé ; basculer `restaurant.couleur_hex`/marque fait passer tout l'accent au vert Al Kayan sans autre changement.
6. Tous les tests précédents passent toujours ; nouveaux tests : délai de verrou configurable, événement addition→son, absence de route sensible depuis le KDS, calcul d'attribution par poste.
