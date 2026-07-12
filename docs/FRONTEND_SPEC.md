# Spécification du frontend — POS Chez Samer / Al Kayan

Document de référence pour **reconstruire le frontend** sans rien casser du
comportement métier. Le **backend (Fastify + endpoints) ne change pas** : un
nouveau frontend doit consommer le **même contrat API** et respecter les mêmes
**règles côté serveur**. Tout est en **français**, montants en **FCFA**.

> Règle d'or : aucune règle métier ne vit « côté UI seulement ». L'UI reflète et
> guide, le serveur décide et refuse. Un nouveau frontend peut tout redessiner
> mais doit garder les mêmes appels et gérer les mêmes réponses (401/403/409…).

---

## 1. Les 4 applications

| App | Dossier | Port dev | Pour qui | Rôle |
|-----|---------|----------|----------|------|
| **Caisse** | `apps/caisse` | 5173 | Caissier, Manager, Propriétaire, Superviseur | Vente, encaissement, clôture, réglages, rapports |
| **KDS cuisine** | `apps/kds` | 5174 | Cuisiniers (jeton d'appareil, pas de PIN) | Affichage/avancement des commandes |
| **Tablette serveur** | `apps/serveur` | 5175 | Serveurs | Prise de commande en salle, envoi cuisine |
| **Menu client** | `apps/client` | 5176 | Clients (téléphone, via QR de table) | Menu, appel serveur, suivi commande |

Chaque app est une **PWA React 18 + Vite + TypeScript**, style **Tailwind**
adossé aux tokens partagés. API + WebSocket sur le serveur local (port 3001),
atteints par proxy Vite (`/api`, `/ws`).

---

## 2. Design system (à conserver ou faire évoluer en connaissance de cause)

Source unique : **`packages/theme/theme.css`** (variables CSS) + `tailwind.config`
qui mappe ces variables en classes (`bg-fond`, `text-fort`, `bg-marque`…).

### Direction actuelle
**Thème clair, chaud, vivant** — jamais de blanc pur ni de sombre. Coins
généreux (rayon 16 px), élévation douce, accent de marque affirmé.

### Jetons de couleur
```
--fond-page:    #f5f2ea   (fond)
--surface-carte:#ffffff   (cartes)
--surface-douce:#faf8f3
--bordure:      #ece8df
--texte-fort:   #23211d
--texte-doux:   #6c6a62
--ok:#2f8a4c  --alerte:#d8542a  --info:#2f86dc   (+ variantes -tint)
--rayon:16px  --rayon-btn:13px
```

### Marque (rebranding en 1 variable)
Le thème bascule via `document.documentElement.dataset.marque` + `--marque` :
- **Chez Samer** (défaut) : `--marque:#ef9f27`, foncé `#b06f12`, tint `#fbeed6`
- **Al Kayan** : `--marque:#2d7d46`, foncé `#175230`, tint `#e2f0e7`

À la connexion, la caisse applique la marque du restaurant :
`dataset.marque = session.restaurant.marque` et `--marque = restaurant.couleur_hex`.

### Règles UX imposées (cahier des charges §15) — à respecter
- **Règle des 3 écrans** : commande simple = Accueil → Commande → Paiement. Pas d'étape en plus.
- **Accueil caissier = exactement 4 boutons** : Nouvelle commande, Tables, Mes ventes, J'ai fini.
- **Boutons tactiles ≥ 48 px**, thème clair, accent = couleur de marque.
- **Écran Commande** : catégories à **gauche**, articles au **centre** (nom + petite image), addition à **droite**.
- **Messages d'erreur en français courant**, jamais de code technique
  (« Ce PIN est bloqué 30 secondes », pas « 429 »). Les messages viennent du serveur.
- **Clôture = assistant pas à pas** : Compter → Saisir → Confirmer → Rapport Z. Aucune étape sautable.
- **localStorage** : rien de sensible côté PWA (session = cookie httpOnly).

---

## 3. Architecture technique commune

- **État** : Zustand (store de session) + **TanStack Query** (données serveur, cache, invalidations).
- **Client API** : petit wrapper `api(chemin, {method, corps})` → renvoie du JSON,
  jette `ErreurApi(message, statusCode)`. Le `message` d'erreur est **toujours**
  celui renvoyé par le serveur (français). Voir `apps/*/src/api.ts` et
  `packages/shared-ui/src/api.ts`.
- **Auth** : session **cookie httpOnly** (pas de token en JS). Reprise au démarrage
  via `GET /api/auth/moi`. Sur **401** hors écrans d'auth → revenir au Login
  (callback `surNonAutorise`). Le serveur peut renvoyer 401 « session expirée »
  (compte supprimé/désactivé) → même traitement.
- **Permissions** : `session.permissions: string[]` pilotent l'affichage (guards UI),
  mais le serveur re-vérifie tout (403 sinon). Ne jamais afficher une action que
  l'utilisateur n'a pas le droit d'exécuter, mais toujours gérer le 403.
- **Temps réel** : WebSocket `/ws` (`apps/caisse/src/temps-reel.ts`,
  `apps/serveur/src/file-attente.ts`). Le serveur pousse des événements
  (`table:changee`, `commande:prete`, `appel:nouveau`,
  `commande:client_a_valider`…) → l'UI invalide les requêtes concernées. Le
  **client (téléphone) n'utilise PAS le WebSocket** : polling léger (10 s).
- **Types partagés** : `@pos/shared` (interfaces + Zod). Réutiliser
  `SessionInfo`, `CarteKds`, `TableClientVue`, etc.

---

## 4. App CAISSE — écrans & navigation

Machine à états dans `stores/session.ts` (`type Ecran`) ; routage dans `App.tsx`
(pas de react-router : un switch sur `ecran`).

```
Ecran = supervision | accueil | commande | paiement | tables | mes-ventes | cloture | reglages
```

### Logique de routage (App.tsx)
1. Pas de session → **Login**.
2. Écran d'atterrissage selon rôle (`ecranInitial`) :
   - Propriétaire / Superviseur → **Supervision** (tableau de bord, pas caissier).
   - Autres → **Accueil** caissier.
3. **Garde vente** : si l'utilisateur a `caisse.encaisser`, **pas de service
   ouvert**, ET l'écran demandé est un écran de vente (`accueil|commande|paiement|tables`)
   → forcer **OuvertureService**. Supervision, rapports, clôture, réglages ne
   passent jamais par là.

### Écrans
| Écran | Fichier | Rôle & points clés |
|-------|---------|--------------------|
| **Login** | `screens/Login.tsx` | Choix utilisateur → PIN (Numpad). **Flux 1ʳᵉ connexion** : code temporaire → définir PIN → confirmer PIN → connexion auto (`doit_definir_pin`). Erreurs de verrouillage affichées telles quelles. |
| **Supervision** | `screens/Supervision.tsx` | Tableau de bord Proprio/Superviseur : Rapports, Réglages, « Basculer en mode caisse ». |
| **OuvertureService** | `screens/OuvertureService.tsx` | Saisie du **fond de caisse** (obligatoire avant toute vente). |
| **Accueil** | `screens/Accueil.tsx` | **4 boutons** filtrés par permissions (commander / tables / mes ventes / clôturer). Bouton retour « Supervision » si superviseur. |
| **Commande** | `screens/Commande.tsx` | **3 zones** : catégories (gauche) · articles nom+photo (centre) · addition (droite). Options/suppléments/combos, quantités, annulation d'article (tracée), remise (PIN manager+motif), envoi cuisine, facture. |
| **Paiement** | `screens/Paiement.tsx` | **Paiement mixte** (plusieurs modes) + **split de note**. « Reste à payer » en très grand ; Valider désactivé tant que reste > 0. Passe la commande à PAYÉE. |
| **Tables** | `screens/Tables.tsx` | Liste des tables (pas de plan graphique en sprint 1), transfert de table. |
| **MesVentes** | `screens/MesVentes.tsx` | Pour les employés : **produits vendus (inventaire), SANS montants** ; montants visibles seulement avec `rapports.x`. |
| **Cloture** | `screens/Cloture.tsx` | Assistant **comptage à l'aveugle** : le théorique n'est jamais renvoyé avant la saisie de l'espèces compté → écart → **rapport Z** figé. |
| **Reglages** | `screens/Reglages.tsx` | Onglets selon permissions : Équipe, Salle & QR, Disponibilité (plats du jour), Catalogue, Fidélité, Paramètres, Journal d'audit, Santé, Rôles & accès. |

### Composants
`components/` : `BandeauAdditions` (bandeau des demandes de facture des serveurs),
`NotificationsCaisse` (**alarme sonore persistante** tant qu'une demande n'est
pas ouverte), `VerrouInactivite` (verrouillage optionnel, désactivé si délai ≤ 0),
`Modale`, `ModalePinManager` (PIN manager + motif pour actions protégées),
`Numpad`, `Fidelite`, `SanteSync`, `TableauBord`.

### Endpoints appelés (caisse)
Auth : `/api/auth/{moi,login,logout,deverrouiller,poser-pin,utilisateurs}` ·
Catalogue : `/api/catalogue` · Commandes : `/api/commandes`,
`/api/commandes/:id[/items[/:id[/annuler]] | /remise | /paiements | /split |
/envoyer | /valider | /refuser | /servir | /facture | /fidelite]`,
`/api/commandes/a-valider` · Services :
`/api/services/{ouvrir,cloturer,transferer,equipe-proposee}` · Tables :
`/api/tables`, `/api/caisse/tables/:id/transferer` · Appels :
`/api/appels/en-attente`, `/api/appels/:id/traiter` · Rapports :
`/api/rapports/{jour,par-heure,top-plats,mes-ventes,tableau-bord}` · Fidélité :
`/api/fidelite/:id` · Santé : `/api/sante/synchro[/forcer]` · **Admin (Réglages)** :
`/api/admin/{parametres, equipe, equipe/:id/(desactiver|reinit-pin), roles,
roles/:id(/desactiver|/dupliquer), salle, zones, tables, tables/:id,
tables/:id/qr, tables/:id/regenerer-qr, tables/regenerer-qr, disponibilite,
disponibilite/:id, catalogue, fidelite/bareme, audit, reseau}`.

---

## 5. App KDS (cuisine)

`App.tsx` très simple : si pas de **jeton d'appareil** → `EcranJeton`
(appairage, pas de PIN caisse) ; sinon → `Grille`.

- **Grille** (`screens/Grille.tsx`) : **2 colonnes** *En attente* / *En cours*.
  Quand c'est prêt, la commande disparaît. Panneau **Historique** (consultation).
  **Heure de commande** + chrono (seuils vert/orange configurables).
  **Annonce vocale** des nouvelles commandes (`sons.ts`, SpeechSynthesis fr-FR :
  « Commande 042 : deux chawarmas poulet… »). Pas de bouton « reprendre ».
- Endpoints : `GET /api/kds/commandes`, `POST /api/kds/commandes/:id/commencer`,
  `POST /api/kds/commandes/:id/pret`. Type de données : `CarteKds` (`@pos/shared`).

---

## 6. App SERVEUR (tablette)

`App.tsx` (état local `useState`) : Login → **Salle** → **PriseCommande**.

- **LoginServeur** (`screens/LoginServeur.tsx`) : PIN.
- **Salle** (`screens/Salle.tsx`) : plan/liste des tables (composant partagé
  `PlanSalle`), sélection d'une table, badge des commandes à valider, appels.
- **PriseCommande** (`screens/PriseCommande.tsx`) : articles **avec photos**,
  ajout au panier, envoi. Le serveur **demande** la facture (il ne l'imprime pas)
  → notification à la caisse.
- `VerrouInactivite` (désactivable), `NotificationsServeur`, `file-attente.ts` (WS).
- Endpoints : `/api/auth/*`, `/api/catalogue`, `/api/tables`,
  `/api/commandes/a-valider`, `/api/commandes/:id[/valider|/refuser|/servir]`,
  `/api/appels/en-attente`, `/api/appels/:id/traiter`.

---

## 7. App CLIENT (téléphone, QR)

`App.tsx` : lit le `qr_token` dans l'URL `/t/:token`, charge la table
(`GET /api/client/:token`). Applique la marque du restaurant. Écran principal :
**PageTable**.

- **PageTable** (`screens/PageTable.tsx`) : entête table + **2 boutons**
  (Appeler le serveur / Demander la facture), **suivi de commande**, **menu**
  (catégories + articles photo, « Épuisé » si indisponible), **panier** fixe en
  bas avec « Reste à payer/total », envoi au serveur.
- **SuiviCommandes** (`screens/SuiviCommandes.tsx`) : jauge d'étapes
  EN_VALIDATION → EN_PREPARATION → PRETE → SERVIE, ou état REFUSÉE + motif.
  Polling 10 s (pas de WS).
- **ErrorBoundary** (`ErrorBoundary.tsx`) : filet anti-page-blanche (obligatoire —
  l'app tourne en http sur téléphone, contexte non sécurisé).
- ⚠️ **Contexte non sécurisé** : `crypto.randomUUID()` est absent en http/LAN →
  utiliser un repli (`nouvelleCle()`). Généralement éviter les API « secure
  context only ».
- Endpoints (tous bornés au jeton) : `/api/client/:token`,
  `/api/client/:token/{catalogue,commandes,commande(POST),appel(POST)}`.

---

## 8. Composants partagés (`packages/shared-ui`)
`Modale`, `Numpad` (pavé PIN/nombres tactile), `PlanSalle` (rendu des tables),
`api` (wrapper fetch commun). À réutiliser tel quel ou réimplémenter à l'identique
(même props, même comportement).

---

## 9. Règles UI à ne pas perdre (rappel)
1. **3 écrans** pour une vente simple ; **4 boutons** sur l'accueil caissier.
2. **Comptage à l'aveugle** : ne jamais afficher le théorique avant saisie (le
   serveur le refuse de toute façon).
3. **Paiement** : « Reste à payer » géant, Valider bloqué si reste > 0.
4. **Actions protégées** (remise, annulation d'article envoyé, réouverture note)
   → passer par `ModalePinManager` (PIN manager + motif).
5. **Employés ≠ montants** dans Mes ventes (inventaire seulement).
6. **Rôles** : Proprio/Superviseur → Supervision (pas le circuit caissier) ;
   Manager ne gère pas les comptes/rôles ; Cuisinier n'a pas d'accès caisse.
7. Tout écran **gère 401** (retour Login) et **403** (message « pas le droit »).
8. **Marque** appliquée depuis la session (orange Samer / vert Al Kayan).

---

## 10. Démarrage
`pnpm install && pnpm db:migrate && pnpm db:seed && pnpm dev` lance serveur + les
4 fronts. Un nouveau frontend doit garder les mêmes ports (ou adapter les proxies
Vite `/api` → `http://localhost:3001` et `/ws`).
