# CLAUDE.md — POS Offline-First Chez Samer / Al Kayan

## Contexte

POS offline-first pour un groupe de 7 restaurants à Abidjan (marques **Chez Samer** orange `#EF9F27` et **Al Kayan** vert `#2D7D46`). Un serveur local par restaurant (mini-PC fanless), terminaux en PWA sur le réseau local, synchronisation vers un cloud dédié quand internet est disponible. Le POS est la **source officielle des ventes** et alimente SamerTrackly (back-office existant, hors périmètre ici).

Référence fonctionnelle : `docs/Cahier_des_charges_POS_Samer_AlKayan_v1.1.docx`. En cas de doute, le cahier des charges fait foi.

**Langue : toute l'interface, les messages d'erreur et les libellés sont en FRANÇAIS. Les montants sont en FCFA.**

## Périmètre du SPRINT 1 — Cœur caisse uniquement

Objectif : une caisse utilisable de bout en bout sur le réseau local, SANS internet.

Inclus :
1. **Auth PIN** caissier/manager/propriétaire (verrouillage anti-force brute).
2. **Ouverture de service** : saisie du fond de caisse.
3. **Prise de commande** : sur place / à emporter / livraison (partenaire = simple tag), articles + options + suppléments + combos, quantités, modification, annulation d'article tracée.
4. **Paiement** : mixte (plusieurs modes sur une addition) + split de note. Modes : espèces, Wave, Orange Money, MTN MoMo, Moov, carte — enregistrement manuel, aucune API.
5. **Remises** : PIN manager + motif obligatoires.
6. **Promotions automatiques** : happy hour / promo du jour (application auto selon heure/jour).
7. **Clôture « J'ai fini »** : comptage à l'aveugle → rapport Z figé → récap partenaires.
8. **Journal d'audit** append-only alimenté sur toutes les actions sensibles.
9. **Rapports du jour** : ventes du jour, top plats, ventes par heure.

EXCLUS du sprint 1 (les tables existent déjà dans le schéma, ne pas les implémenter) :
synchro cloud, KDS, app serveur tablette, notation QR, pointage, fidélité, impression ESC/POS (prévoir seulement une interface `PrinterService` avec une implémentation `ConsolePrinter`), plan de salle graphique (une simple liste de tables suffit en sprint 1).

Toute idée hors périmètre → l'ajouter dans `docs/BACKLOG_V2.md`, ne pas l'implémenter.

## Stack (décidé — ne pas changer)

| Couche | Choix |
|---|---|
| Monorepo | pnpm workspaces |
| Serveur local | Node.js 22 + **Fastify** + TypeScript strict |
| ORM / migrations | **Drizzle ORM** + drizzle-kit (PostgreSQL 16) |
| Validation | Zod (schémas partagés dans `packages/shared`) |
| PWA Caisse | React 18 + Vite + TypeScript, vite-plugin-pwa |
| État client | Zustand + TanStack Query |
| Styles | Tailwind CSS (thème sombre, accent = couleur de marque) |
| Auth | Sessions serveur (cookie httpOnly) ; PIN hashés **argon2id** |
| Tests | Vitest (unitaires + intégration API avec base de test) |
| Temps réel LAN | WebSocket Fastify (`@fastify/websocket`) pour pousser les mises à jour aux caisses |

## Structure du monorepo

```
pos-samer/
├── CLAUDE.md
├── docs/
│   ├── Cahier_des_charges_POS_Samer_AlKayan_v1.1.docx
│   └── BACKLOG_V2.md
├── packages/
│   └── shared/            # types TS + schémas Zod + constantes (modes paiement, rôles)
├── apps/
│   ├── server/            # Fastify + Drizzle
│   │   ├── src/
│   │   │   ├── db/schema/     # schéma Drizzle (miroir exact de sql/schema.sql)
│   │   │   ├── db/seed.ts     # données de démo (voir plus bas)
│   │   │   ├── modules/
│   │   │   │   ├── auth/          # PIN, sessions, verrouillage
│   │   │   │   ├── catalogue/     # lecture catalogue + promos
│   │   │   │   ├── commandes/     # création, items, annulation, totaux
│   │   │   │   ├── paiements/     # mixte + split, transition PAYEE
│   │   │   │   ├── services/      # ouverture, clôture blind count, rapport Z
│   │   │   │   ├── audit/         # écriture journal
│   │   │   │   └── rapports/      # ventes du jour, top plats, par heure
│   │   │   ├── plugins/           # auth guard par rôle, gestion erreurs FR
│   │   │   └── printer/           # interface PrinterService + ConsolePrinter
│   │   └── drizzle/               # migrations générées
│   └── caisse/            # PWA React
│       └── src/
│           ├── screens/   # Login, Accueil, Commande, Paiement, Cloture, MesVentes
│           ├── components/
│           └── stores/
└── sql/schema.sql         # SOURCE DE VÉRITÉ du schéma (fourni)
```

## Schéma de base de données

Le fichier `sql/schema.sql` est fourni et fait autorité. Le schéma Drizzle doit en être le **miroir exact** (mêmes noms de tables/colonnes en français, mêmes contraintes CHECK, mêmes types). Générer les migrations avec drizzle-kit. Ne pas renommer, ne pas « angliciser ».

Points non négociables du schéma :
- Montants en `INTEGER` (FCFA sans centimes). Jamais de float.
- Ids en UUID générés côté serveur (préparation synchro).
- `numero_ticket` : séquence continue, jamais réutilisée, jamais de trou (une commande annulée garde son numéro avec statut ANNULEE).
- `audit_log` : trigger append-only déjà dans le SQL — le conserver.
- `sync_outbox` : à chaque INSERT/UPDATE sur commandes, commande_items, paiements, services_caisse, audit_log → écrire une ligne outbox **dans la même transaction**. Le moteur de synchro (sprint 3) ne fera que lire cette table.

## Règles métier critiques (à respecter au caractère près)

### Comptage à l'aveugle (clôture)
1. Le caissier clique « J'ai fini ».
2. L'écran demande le montant d'espèces compté. **L'API ne renvoie JAMAIS le théorique tant que `especes_comptees` n'est pas enregistré** — c'est appliqué côté serveur, pas seulement caché côté UI.
3. Après saisie : le serveur calcule `especes_theorique` (fond de caisse + paiements ESPECES du service), l'écart, fige le `rapport_z` en JSONB, passe le service à CLOTURE.
4. Si |écart| > `parametres_locaux.seuil_alerte_ecart_caisse` (défaut 2000) → entrée audit `ECART_CAISSE` + notification manager (sprint 1 : simple écriture audit).

### Deux sorties distinctes
- **« Se déconnecter »** : ferme la session, le service reste OUVERT, les compteurs persistent.
- **« J'ai fini »** : clôture complète (flux ci-dessus). Un caissier ne peut pas ouvrir deux services (index unique déjà dans le SQL).

### Actions protégées (PIN manager + motif obligatoires, tout passe par audit_log)
- Remise sur une commande.
- Annulation d'un article déjà envoyé en cuisine (statut_cuisine ≠ A_PREPARER).
- Réouverture d'une commande PAYEE.

### Paiement
- Une commande passe à PAYEE uniquement si `SUM(paiements.montant) == commandes.total` — vérifié en transaction côté serveur.
- Paiement mixte : l'UI affiche le « Reste à payer » en très grand, mis à jour à chaque ajout ; bouton Valider désactivé tant que reste > 0.
- Split : création de `notes_split` dont la somme == total ; chaque note est ensuite payée (mixte autorisé par note).

### Prix
- Prix figés dans `commande_items` (snapshot `nom_snapshot` + `prix_unitaire`) au moment de l'ajout. Un changement de catalogue ne modifie JAMAIS une commande existante.
- Canal : sur place = `prix_base` ; livraison partenaire = `prix_canaux` si présent sinon `prix_base`.
- Promotions : appliquées automatiquement si heure/jour correspondent, montant tracé dans `promo_montant`.

### Auth et sécurité (§14 du cahier des charges)
- PIN 4–6 chiffres, hash argon2id. PIN interdits : 1234, 0000, 1111…9999, 123456.
- 5 échecs → verrou 30 s, puis 60 s, puis 300 s (colonne `verrou_jusqua`). Chaque échec → audit `ECHEC_PIN`.
- Verrouillage automatique de session après 60 s d'inactivité (config), déverrouillage par PIN.
- Rapport X (ventes en cours de service) : route accessible MANAGER/PROPRIETAIRE uniquement.
- Aucune donnée sensible dans le localStorage de la PWA autre que l'id de session.

## UX (§15 du cahier des charges)

- **Règle des 3 écrans** : commande simple = Accueil → Commande → Paiement. Pas d'étape de plus.
- Accueil caissier : exactement 4 boutons — Nouvelle commande, Tables, Mes ventes, J'ai fini.
- Boutons tactiles ≥ 48 px, thème sombre, accent orange (le rebranding vert Al Kayan lit `restaurant.couleur_hex`).
- Layout écran commande : catégories à gauche, articles au centre (nom + petite image), addition à droite.
- Messages d'erreur en français courant, jamais de code technique. Exemple : « Ce PIN est bloqué 30 secondes » et non « 429 Too Many Requests ».
- Clôture = assistant pas à pas : Compter → Saisir → Confirmer → Rapport Z. Aucune étape sautable.

## Seed de démonstration (`db/seed.ts`)

- Restaurant : `SAMER_ANGRE7E`, « Chez Samer Angré 7E », marque SAMER.
- Utilisateurs : 1 propriétaire (PIN 852741), 1 manager (PIN 963852), 2 caissiers, 2 serveurs.
- Catalogue : 4 catégories (Chawarmas, Pizzas, Grillades, Boissons), ~15 articles avec prix FCFA réalistes (chawarma 3000, pizza 6500, jus 1500…), 1 groupe d'options (Sauce), 2 suppléments (Fromage +500, Frites +1000), 1 combo (Chawarma + Boisson 4000), surcharges `prix_canaux` Yango/Glovo, 1 promotion happy hour −20 % 17h–19h.
- Zones : RC (6 tables), Terrasse (4), VIP (2), Livraison (3 tables virtuelles YANGO/GLOVO/SAMER_DELIV).

## Définition de « terminé » (sprint 1)

- `pnpm install && pnpm db:migrate && pnpm db:seed && pnpm dev` démarre serveur + PWA.
- Parcours complet manuel : login PIN → ouverture service (fond 25 000) → commande 2 articles + 1 supplément → paiement mixte 5 000 espèces + reste Wave → « J'ai fini » → comptage aveugle → rapport Z affiché avec écart.
- Tests Vitest verts, couvrant au minimum : verrouillage PIN, refus du théorique avant comptage, `SUM(paiements) == total`, remise sans motif rejetée, trigger audit append-only, écriture outbox transactionnelle.
- `pnpm build` sans erreur TypeScript (strict).

## Conventions de travail

- Commits conventionnels en français : `feat(caisse): écran paiement mixte`.
- Tout ajout hors périmètre → `docs/BACKLOG_V2.md`.
- Ne jamais contourner une règle métier « côté UI seulement » : chaque règle est appliquée côté serveur.
