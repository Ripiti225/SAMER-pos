# SPRINT 4 — Pointage, Fidélité, Rapports

Prérequis : sprints 1-3 fonctionnels et committés. Rappels permanents : interface en FRANÇAIS, montants FCFA (INTEGER), règles côté serveur, aucun test existant cassé, un commit par module. Toute idée hors périmètre → docs/BACKLOG_V2.md.

---

## A. POINTAGE COMPLET (§7 du cahier des charges)

Les tables `pointages` et `codes_pointage` existent déjà. Implémenter les 3 méthodes :

### A1. PIN au POS (méthode universelle, toujours disponible)
- Sur la caisse, bouton « Pointage » accessible depuis l'écran de verrouillage (sans ouvrir de session caisse) : l'employé tape son PIN → « Bonjour Awa, arrivée enregistrée à 08h02 » ; s'il a déjà pointé → propose le départ.
- Fonctionne 100 % hors ligne (c'est la méthode de secours du prémortem, risque 9).

### A2. Géolocalisation (téléphone de l'employé)
- Page `/pointage` servie sur le même port restreint que l'app client : l'employé s'identifie par téléphone + PIN, le navigateur demande la position, le SERVEUR vérifie la distance avec les coordonnées du restaurant (`parametres_locaux` : lat, lng, rayon_metres défaut 150).
- Hors rayon → refus clair : « Vous êtes trop loin du restaurant pour pointer (à 830 m) ». La vérification est côté serveur, jamais dans le navigateur.

### A3. Code SMS
- L'employé envoie « POINTAGE » par SMS au numéro du service → reçoit un code à 6 chiffres (usage unique, expire en 10 min, table codes_pointage) → le saisit sur la page /pointage ou donne le code au caissier qui le saisit au POS.
- Abstraction `SmsService` avec implémentation `ConsoleSms` (affiche le code en console) : le choix de l'opérateur SMS (Orange CI, Termii, etc.) se fera à la préparation du pilote. Plafond mensuel et alerte 80 % (§14.5) implémentés dans l'abstraction.

### A4. Règles communes
- Départ oublié : à la clôture du dernier service caisse du jour, tout pointage encore ouvert est marqué `depart_oublie = TRUE` et fermé à cette heure ; alerte manager sur la page santé + correction possible (PIN manager + motif, ligne d'audit CORRECTION_POINTAGE).
- **Activer l'attribution cuisine réelle** : remplacer le comportement provisoire « tous les cuisiniers actifs sont en poste » par la vraie liste des pointages ouverts (CORRECTIONS.md point 4). Les plats sont désormais attribués aux employés effectivement pointés.
- Écran manager « Présences du jour » : qui est là, depuis quand, retards vs horaires prévus (les horaires prévus restent simples : champ texte par employé, pas de planning complet — backlog v2).
- Tout pointage part dans sync_outbox (SamerTrackly consommera les présences côté cloud).

## B. FIDÉLITÉ (§9 — programme partagé avec SAMER DELIV)

Tables `clients_fidelite` et `points_fidelite` déjà en place. Règle d'or : **l'id client est LE MÊME que dans SAMER DELIV** (base Supabase SAMER DELIV = référence des clients).

- Au paiement, champ optionnel « Client fidélité » : saisie du numéro de téléphone (pavé large, rapide). Si le client existe en local → points crédités ; sinon création locale (id généré, téléphone) qui remontera au cloud.
- **Rapprochement cloud** : côté cloud (Edge Function à la montée), si un client POS a le même téléphone qu'un client SAMER DELIV, fusionner sur l'id SAMER DELIV (table de correspondance `fusions_clients(ancien_id, id_retenu)` redescendue en local). Le POS applique la fusion à la descente.
- Barème configuré au siège et descendu par la synchro (`parametres_fidelite` : points par tranche de FCFA, valeur du point en remise, seuil minimum d'utilisation).
- Utilisation des points = une remise de type FIDELITE au paiement : le caissier saisit le téléphone, le solde s'affiche, « Utiliser X points = Y FCFA ». Pas de PIN manager nécessaire (c'est un droit du client), mais ligne d'audit UTILISATION_POINTS et écriture négative dans points_fidelite — le tout dans la même transaction que le paiement.
- Hors ligne : le crédit de points fonctionne (local puis synchro). L'UTILISATION de points est refusée si la dernière descente date de plus de 24 h (« Solde non vérifiable, réessayez plus tard ») pour éviter la double dépense entre canaux.

## C. RAPPORTS (caisse, manager, propriétaire)

### C1. Rapport X (manager uniquement — §14.3)
Lecture intermédiaire du service en cours SANS le clôturer : ventes par mode de paiement, nombre de tickets, annulations et remises (avec qui/motif), top 5 plats. Route protégée MANAGER/PROPRIETAIRE (déjà exigé, vérifier).

### C2. Rapport Z enrichi
Compléter le Z existant : ventes par mode de paiement, par type (sur place/emporter/livraison), **récap par partenaire** (Yango, Glovo, SAMER DELIV — nombre et montant, pour les réclamations de paiement), annulations et remises détaillées, écart de caisse. Impression via PrinterService + snapshot JSONB conservé (existant).

### C3. Tableau de bord propriétaire (dans la caisse, role PROPRIETAIRE)
- Jour et période glissante 7/30 jours : CA, tickets, panier moyen, ventes par heure (graphique simple), top 10 plats, répartition par mode de paiement, écarts de caisse par caissier.
- Lecture LOCALE uniquement (les vues multi-restaurants restent dans SamerTrackly, via le cloud — ne pas dupliquer ici).

### C4. Récap notation
Petite section manager : moyennes cuisine/service/ambiance sur 7/30 jours, dernières mauvaises notes avec commentaires (l'alerte temps réel mauvaise note existe côté manager — vérifier, sinon l'ajouter : toast + son discret).

## Définition de « terminé »

1. Les 3 méthodes de pointage fonctionnent (SMS en mode console) ; un pointage hors rayon est refusé avec la distance affichée ; le pointage PIN marche WiFi coupé.
2. Un plat préparé est attribué aux seuls employés POINTÉS du bon poste (test : pizzaiolo non pointé → pizza non attribuée à lui).
3. Parcours fidélité complet : paiement avec téléphone → points crédités → visibles au paiement suivant → utilisation en remise → solde décrémenté → tout remonte au cloud. Test de la règle des 24 h hors ligne.
4. Rapport X inaccessible à un CAISSIER (403). Z enrichi imprimé avec récap partenaires.
5. Tableau de bord propriétaire affiche des chiffres exacts (vérifiés contre 3 ventes de test calculées à la main).
6. Tous les tests des sprints 1-3 passent toujours.
