# État du projet — POS Chez Samer / Al Kayan

> Fichier de reprise, **actualisé à chaque compaction** de la conversation.
> Il résume l'état courant pour repartir sans relire tout l'historique.
> Dernière mise à jour : 2026-07-09.

## Où on en est

Le **cœur caisse** (sprints 1→4) est en place. Les derniers chantiers livrés :

- **Sprint 4B/4C — Administration & rôles** : système de permissions composable
  + module Réglages complet (voir `docs/SPRINT4BC_ADMIN_ROLES.md`).
- **Allègement en cours** : le pointage chronométré a été retiré, remplacé par
  l'**équipe du jour**.

État technique : **151 tests verts**, tous les apps compilent (`pnpm -r build`).
Développement directement sur `main` (convention du dépôt), un commit par étape.

## Modules livrés récemment

### Permissions & rôles (Partie 1)
- Catalogue figé `packages/shared/src/permissions.ts` (sections + libellés FR).
- Tables `roles` / `role_permissions`, `utilisateurs.role_id` (migration 0006).
  6 rôles système ; accès existants préservés exactement.
- Guards serveur par **permission** (`app.exigePermission('caisse.remise')`),
  cache invalidé en temps réel (WebSocket `permissions`).
- Invariants 1.5 : PROPRIETAIRE toujours toutes permissions (anti-verrouillage) ;
  PIN manager = rôle avec permission de supervision (`rapports.z`) ;
  rôles PROPRIETAIRE/SUPERVISEUR verrouillés ; `roles.gerer` protégée.

### Module Réglages (Partie 2) — routes `/api/admin/*`, onglet PWA `Reglages.tsx`
- **Rôles & accès**, **Équipe** (PIN posé par l'employé via code temporaire,
  migration 0007), **Salle & QR** (migration 0008, PDF via `qrcode`+`pdfkit`),
  **Plats du jour** (`disponibilite_locale`, migration 0009, non écrasée par la
  descente), **Paramètres**, **Journal d'audit**, **Catalogue & Fidélité** via
  Edge Function cloud `admin-catalogue` (hors ligne → message clair).

### Allègement — équipe du jour (remplace le pointage)
- Table `equipe_service` (migration 0010) : à l'ouverture de service, on coche
  les présents + poste du jour (`POSTES_JOUR`), modifiable (ex. Willy barman →
  comptoiriste). Info + remontée outbox, **pas de chronométrage**.
- **Pointage retiré** (migration 0011) : module, tables `pointages`/
  `codes_pointage`, permission `reglages.pointage`, params géoloc + SMS, page
  pointage client, mode pointage de la connexion.
- **KDS** : présence « en poste » = équipe du jour d'un service ouvert ; à défaut,
  tous les cuisiniers actifs (ne bloque jamais). Regroupement sur `poste_cuisine`
  (le poste du jour est une info, il ne pilote pas le KDS — décision utilisateur).

## Décisions clés (récentes)
- Poste du jour = **info + remontée**, KDS inchangé.
- Sélection de l'équipe **à l'ouverture de service** (2 étapes : fond → équipe).
- Allègement retenu pour cette passe : **SMS retirés** (avec le pointage).

## Migrations Drizzle
`0006` rôles/permissions · `0007` PIN temporaire · `0008` `tables_salle.actif` ·
`0009` `disponibilite_locale` · `0010` `equipe_service` · `0011` retrait pointage.

## Commandes utiles
```bash
pnpm -r build                              # build strict TS + tous les apps
pnpm --filter @pos/server test             # tests serveur (DB pos_samer_test)
pnpm --filter @pos/server exec vitest run test/<fichier>.test.ts
pnpm install && pnpm db:migrate && pnpm db:seed && pnpm dev   # démarrage complet
```

## Pistes d'allègement en attente (non décidées)
1. Supprimer l'app **serveur tablette** (`apps/serveur`) si les serveurs passent
   par la caisse.
2. Réduire l'**app client QR** (`apps/client`) à un menu consultatif.
3. **Fidélité** masquée tant qu'aucun barème n'est configuré.
4. Garder seulement les 6 rôles système (éditeur de rôles perso plus tard).

## À vérifier au déploiement (non testable ici)
- Round-trip cloud de l'édition catalogue/barème (`admin-catalogue` → descente
  `< 5 min`) : pas de Supabase joignable dans l'environnement de dev.
