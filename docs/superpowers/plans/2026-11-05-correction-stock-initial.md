# Correction du stock initial — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre au caissier entrant de corriger le stock initial pendant la première heure, et faire payer le manquant au bon caissier, sur place ou dans SamerTrackly.

**Architecture:** La caisse écrit une table `corrections_stock_initial` et change `inventaire_lignes.stock_initial` dans la même transaction. La table remonte au cloud par l'outbox, puis le pont `samtrackly-points` la transmet à SamerTrackly après le transfert du service. SamerTrackly recalcule la ligne du caissier concerné, avec la même recette que `corriger_entree_inventaire`.

**Tech Stack:** Fastify, Drizzle, PostgreSQL 16, Zod, React 18 et TanStack Query (caisse) ; Edge Functions Deno testées avec `node --test` ; Expo et Supabase (SamerTrackly).

## Global Constraints

- Spec : `docs/superpowers/specs/2026-11-05-correction-stock-initial-design.md`.
- Dépôt caisse : `/Users/macbookpro/pos-samer-stock-initial`, branche `feat/correction-stock-initial`, partie d'`origin/main`.
- Dépôt SamerTrackly : `/Users/macbookpro/samtrackly`, branche `feat/correction-stock-initial`.
- Interface et messages en français courant, sans code technique. Montants en FCFA entiers.
- Chaque règle est appliquée côté serveur. L'écran ne fait que prévenir.
- Écrire en outbox dans la même transaction que la donnée.
- Commits conventionnels en français. Aucun push, aucun déploiement, aucun SQL sur une base réelle sans accord explicite.
- Tests caisse : `POS_TEST_DB=pos_samer_test_stock`, jamais la base de test partagée.

---

### Task 1: Formule partagée, schéma et migration caisse

**Files:**
- Create: `packages/shared/src/correction-stock.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `sql/schema.sql` (après `entrees_stock`)
- Modify: `apps/server/src/db/schema/index.ts`
- Create: `apps/server/drizzle/0050_corrections_stock_initial.sql`
- Modify: `apps/server/drizzle/meta/_journal.json`
- Modify: `apps/server/src/db/outbox.ts`
- Modify: `apps/server/src/modules/audit/audit.ts`
- Modify: `apps/server/test/aide.ts` (TRUNCATE)
- Test: `apps/server/test/correction-stock-formule.test.ts`

**Interfaces:**
- Produces: `DELAI_CORRECTION_STOCK_MS: number`, `StatutCorrectionStock`, `LigneSortantCorrection`, `effetCorrectionSortant(ligne, stockCorrige)` renvoyant `{ theorique, ecart_avant, ecart_apres, manque_avant, manque_apres, litige }`, table Drizzle `correctionsStockInitial`, actions d'audit `CORRECTION_STOCK_INITIAL` et `VALIDATION_CORRECTION_STOCK`.

- [ ] **Step 1: Écrire le test en échec**

```ts
import { describe, expect, it } from 'vitest';
import { effetCorrectionSortant } from '@pos/shared';

const ligne = (stock_compte: number, quantite_expliquee = 0) => ({
  stock_initial: 10, entrees: 0, sorties: 0, stock_compte, quantite_expliquee,
});

describe('effetCorrectionSortant', () => {
  it('annule un surplus sans ouvrir de litige', () => {
    expect(effetCorrectionSortant(ligne(12), 10)).toMatchObject({ ecart_avant: 2, ecart_apres: 0, litige: false });
  });
  it('un surplus qui devient manquant ouvre un litige', () => {
    expect(effetCorrectionSortant(ligne(12), 9)).toMatchObject({ ecart_apres: -1, manque_apres: 1, litige: true });
  });
  it('un stock juste qui devient manquant ouvre un litige', () => {
    expect(effetCorrectionSortant({ stock_initial: 14, entrees: 0, sorties: 0, stock_compte: 14, quantite_expliquee: 0 }, 12))
      .toMatchObject({ ecart_avant: 0, ecart_apres: -2, manque_apres: 2, litige: true });
  });
  it('annule un manquant sans ouvrir de litige', () => {
    expect(effetCorrectionSortant(ligne(8), 10)).toMatchObject({ ecart_avant: -2, ecart_apres: 0, manque_apres: 0, litige: false });
  });
  it('une explication de surplus ne couvre pas un manquant neuf', () => {
    expect(effetCorrectionSortant(ligne(12, 2), 9)).toMatchObject({ manque_apres: 1, litige: true });
  });
  it('une explication de manquant reste acquise', () => {
    expect(effetCorrectionSortant(ligne(8, 2), 8)).toMatchObject({ manque_avant: 0, manque_apres: 0, litige: false });
    expect(effetCorrectionSortant(ligne(8, 2), 7)).toMatchObject({ manque_apres: 1, litige: true });
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `POS_TEST_DB=pos_samer_test_stock pnpm --filter @pos/server exec vitest run test/correction-stock-formule.test.ts`
Expected: FAIL, `effetCorrectionSortant` n'existe pas.

- [ ] **Step 3: Écrire la formule**

```ts
/**
 * Correction du stock initial : la formule que l'écran montre et que le serveur
 * applique. On ne soustrait jamais la correction de l'écart du sortant : on le
 * recalcule, sinon un surplus annulé deviendrait un faux manquant.
 */
export const DELAI_CORRECTION_STOCK_MS = 60 * 60 * 1000;

export type StatutCorrectionStock =
  | 'SANS_LITIGE' | 'A_VALIDER' | 'RECONNUE_SORTANT' | 'VALIDEE_MANAGER' | 'REMPLACEE';

export interface LigneSortantCorrection {
  stock_initial: number;
  entrees: number;
  sorties: number;
  stock_compte: number;
  quantite_expliquee: number;
}

const arrondi = (n: number): number => Math.round(n * 100) / 100;

export function effetCorrectionSortant(ligne: LigneSortantCorrection, stockCorrige: number) {
  const theorique = arrondi(ligne.stock_initial + ligne.entrees - ligne.sorties);
  const ecart_avant = arrondi(ligne.stock_compte - theorique);
  const ecart_apres = arrondi(stockCorrige - theorique);
  // Seule une explication de MANQUANT excuse un manquant : « livraison non
  // saisie » sur un surplus n'explique pas les poulets qui manquent ensuite.
  const expliquee = ecart_avant < 0 ? ligne.quantite_expliquee : 0;
  const manque = (ecart: number) => arrondi(Math.max(0, -ecart - expliquee));
  const manque_avant = manque(ecart_avant);
  const manque_apres = manque(ecart_apres);
  return { theorique, ecart_avant, ecart_apres, manque_avant, manque_apres, litige: manque_apres > manque_avant };
}
```

Ajouter `export * from './correction-stock.js';` à `packages/shared/src/index.ts`.

- [ ] **Step 4: Vérifier le succès**

Même commande. Expected: 6 tests PASS.

- [ ] **Step 5: Écrire le schéma et la migration**

Bloc SQL commun à `sql/schema.sql` et `0050_corrections_stock_initial.sql` :

```sql
-- Correction du stock initial en début de shift. Le chiffre corrigé va dans
-- inventaire_lignes.stock_initial ; cette table garde qui, quand, pourquoi, et
-- qui paie. Une correction remplacée reste en base : c'est l'historique.
CREATE TABLE IF NOT EXISTS "corrections_stock_initial" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "inventaire_id"       uuid NOT NULL REFERENCES "inventaires_service"("id") ON DELETE CASCADE,
  "produit_id"          uuid NOT NULL REFERENCES "produits_inventaire"("id") ON DELETE CASCADE,
  "produit_code"        text NOT NULL,
  "produit_nom"         text NOT NULL,
  "produit_prix"        integer NOT NULL,
  "stock_reporte"       numeric(12,2) NOT NULL,
  "stock_avant"         numeric(12,2) NOT NULL,
  "stock_apres"         numeric(12,2) NOT NULL CHECK ("stock_apres" >= 0),
  "explication"         text NOT NULL CHECK (length(btrim("explication")) > 0),
  "saisi_par"           uuid NOT NULL REFERENCES "utilisateurs"("id"),
  "service_sortant_id"  uuid REFERENCES "services_caisse"("id"),
  "caissier_sortant_id" uuid REFERENCES "utilisateurs"("id"),
  "shift_intermediaire_debloque" boolean NOT NULL DEFAULT false,
  "ecart_sortant_avant" numeric(12,2),
  "ecart_sortant_apres" numeric(12,2),
  "statut"              text NOT NULL CHECK ("statut" IN
    ('SANS_LITIGE','A_VALIDER','RECONNUE_SORTANT','VALIDEE_MANAGER','REMPLACEE')),
  "valide_par"          uuid REFERENCES "utilisateurs"("id"),
  "valide_le"           timestamp with time zone,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "corrections_stock_initial_active"
  ON "corrections_stock_initial" ("inventaire_id", "produit_id") WHERE "statut" <> 'REMPLACEE';
```

Ajouter au journal Drizzle :

```json
{ "idx": 50, "version": "7", "when": 1793923200000, "tag": "0050_corrections_stock_initial", "breakpoints": true }
```

Table Drizzle, après `entreesStock` :

```ts
/** Correction du stock initial en début de shift (migration 0050). */
export const correctionsStockInitial = pgTable('corrections_stock_initial', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  inventaire_id: uuid('inventaire_id').notNull().references(() => inventairesService.id, { onDelete: 'cascade' }),
  produit_id: uuid('produit_id').notNull().references(() => produitsInventaire.id, { onDelete: 'cascade' }),
  produit_code: text('produit_code').notNull(),
  produit_nom: text('produit_nom').notNull(),
  produit_prix: integer('produit_prix').notNull(),
  stock_reporte: numeric('stock_reporte', { precision: 12, scale: 2 }).notNull(),
  stock_avant: numeric('stock_avant', { precision: 12, scale: 2 }).notNull(),
  stock_apres: numeric('stock_apres', { precision: 12, scale: 2 }).notNull(),
  explication: text('explication').notNull(),
  saisi_par: uuid('saisi_par').notNull().references(() => utilisateurs.id),
  service_sortant_id: uuid('service_sortant_id').references(() => servicesCaisse.id),
  caissier_sortant_id: uuid('caissier_sortant_id').references(() => utilisateurs.id),
  shift_intermediaire_debloque: boolean('shift_intermediaire_debloque').notNull().default(false),
  ecart_sortant_avant: numeric('ecart_sortant_avant', { precision: 12, scale: 2 }),
  ecart_sortant_apres: numeric('ecart_sortant_apres', { precision: 12, scale: 2 }),
  statut: text('statut').notNull(),
  valide_par: uuid('valide_par').references(() => utilisateurs.id),
  valide_le: timestamp('valide_le', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('corrections_stock_initial_stock_check', sql`${t.stock_apres} >= 0`),
  check('corrections_stock_initial_explication_check', sql`length(btrim(${t.explication})) > 0`),
  check('corrections_stock_initial_statut_check', sql`${t.statut} IN ('SANS_LITIGE','A_VALIDER','RECONNUE_SORTANT','VALIDEE_MANAGER','REMPLACEE')`),
  uniqueIndex('corrections_stock_initial_active').on(t.inventaire_id, t.produit_id).where(sql`${t.statut} <> 'REMPLACEE'`),
]);
```

Ajouter `'corrections_stock_initial'` à `TableSynchronisee`, les deux actions à `ActionAudit`, et `corrections_stock_initial` au `TRUNCATE` de `resetDonnees`.

- [ ] **Step 6: Vérifier et commiter**

Run: `POS_TEST_DB=pos_samer_test_stock pnpm --filter @pos/server exec vitest run test/inventaire-depenses.test.ts test/correction-stock-formule.test.ts && pnpm --filter @pos/server build`
Expected: tests PASS, migration appliquée, TypeScript sans erreur.

```bash
git add docs/superpowers packages/shared sql/schema.sql apps/server/src/db apps/server/src/modules/audit/audit.ts apps/server/drizzle apps/server/test
git commit -m "feat(inventaire): table et formule de correction du stock initial"
```

---

### Task 2: Routes de correction et de validation

**Files:**
- Create: `apps/server/src/modules/inventaire/correction.ts`
- Create: `apps/server/src/modules/inventaire/routes-correction.ts`
- Modify: `apps/server/src/modules/inventaire/service.ts` (`ventesEnCoursParProduit`, commentaire « jamais modifiable »)
- Modify: `apps/server/src/modules/inventaire/routes.ts` (bloc `correction_stock` dans `GET /api/inventaire`)
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/db/schema/index.ts` (commentaire de `stock_initial`)
- Test: `apps/server/test/correction-stock-initial.test.ts`

**Interfaces:**
- Consumes: `effetCorrectionSortant`, `DELAI_CORRECTION_STOCK_MS`, `correctionsStockInitial`.
- Produces:
  - `GET /api/inventaire/lignes/:produitId/correction` → `ContexteCorrection`
  - `POST /api/inventaire/lignes/:produitId/corriger-initial` → `{ correction, ligne, bilan }`
  - `POST /api/inventaire/corrections/:id/valider` → `{ correction }`
  - `correctionsDuService(dbx, inventaireId)` et `vueCorrectionStock(dbx, service, inventaireId)`
  - dans `GET /api/inventaire` : `correction_stock: { fin: string; corrections: CorrectionVue[] }`

- [ ] **Step 1: Écrire les tests en échec**

Le fichier enchaîne deux shifts réels sur un produit compté. L'aide locale `relever(comptes)` compte le produit, valide l'inventaire, clôture le service de `Caissier Test`, puis ouvre celui de `Caissier Suivant`.

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { auditLog, correctionsStockInitial, inventaireLignes, produitsInventaire, servicesCaisse, syncOutbox } from '../src/db/schema/index.js';
import { PIN_CAISSIER, PIN_CAISSIER2, PIN_MANAGER, resetDonnees, seConnecter, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let sortant: Record<string, string>;
let entrant: Record<string, string>;
let produit: string;

const appel = (method: 'GET' | 'POST' | 'PUT', url: string, cookies: Record<string, string>, payload?: object) =>
  app.inject({ method, url, cookies, ...(payload ? { payload } : {}) });

const corriger = (stock_initial: number, extra: object = {}, cookies = entrant) =>
  appel('POST', `/api/inventaire/lignes/${produit}/corriger-initial`, cookies, { stock_initial, explication: 'Recompté à la prise de poste', ...extra });

async function shiftValide(cookies: Record<string, string>, compte: number): Promise<void> {
  await appel('POST', '/api/services/ouvrir', cookies, { fond_de_caisse: 0 });
  await appel('GET', '/api/inventaire', cookies);
  await appel('PUT', `/api/inventaire/lignes/${produit}`, cookies, { stock_compte: compte });
  await appel('POST', '/api/inventaire/valider', cookies);
}

async function cloturer(cookies: Record<string, string>): Promise<void> {
  const rep = await appel('POST', '/api/services/cloturer', cookies, { especes_comptees: 0, modes_declares: {} });
  if (rep.statusCode !== 200) throw new Error(`Clôture: ${rep.body}`);
}

async function relever(compte: number): Promise<void> {
  await shiftValide(sortant, compte);
  await cloturer(sortant);
  await appel('POST', '/api/services/ouvrir', entrant, { fond_de_caisse: 0 });
  await appel('GET', '/api/inventaire', entrant);
}

beforeAll(async () => { app = await construireApp(); });
afterAll(async () => { await app.close(); await fermerDb(); });

beforeEach(async () => {
  donnees = await resetDonnees();
  sortant = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  entrant = await seConnecter(app, donnees.caissier2_id, PIN_CAISSIER2);
  const [p] = await db.insert(produitsInventaire)
    .values({ code: 'po8', categorie: 'POULET', nom: 'Total poulet', prix: 8000, role: 'COMPTE', ordre: 1 })
    .returning();
  produit = p!.id;
});

describe('correction du stock initial', () => {
  it('corrige le chiffre et ouvre un litige à valider', async () => {
    await relever(14);
    const rep = await corriger(12);
    expect(rep.statusCode).toBe(200);
    expect(rep.json().correction.statut).toBe('A_VALIDER');
    expect(rep.json().ligne.stock_initial).toBe(12);
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, 'CORRECTION_STOCK_INITIAL'));
    expect(audit).toBeTruthy();
    const outbox = await db.select().from(syncOutbox).where(eq(syncOutbox.table_name, 'corrections_stock_initial'));
    expect(outbox).toHaveLength(1);
  });

  it('refuse après une heure, même après reconnexion', async () => {
    await relever(14);
    await db.update(servicesCaisse)
      .set({ ouvert_le: new Date(Date.now() - 61 * 60 * 1000) })
      .where(eq(servicesCaisse.caissier_id, donnees.caissier2_id));
    const reconnecte = await seConnecter(app, donnees.caissier2_id, PIN_CAISSIER2);
    const rep = await corriger(12, {}, reconnecte);
    expect(rep.statusCode).toBe(409);
    expect(rep.json().message ?? rep.json().erreur).toContain('heure');
  });

  it('exige une explication', async () => {
    await relever(14);
    expect((await corriger(12, { explication: '   ' })).statusCode).toBe(400);
  });

  it('refuse un chiffre inchangé ou un inventaire validé', async () => {
    await relever(14);
    expect((await corriger(14)).statusCode).toBe(400);
    await appel('PUT', `/api/inventaire/lignes/${produit}`, entrant, { stock_compte: 14 });
    await appel('POST', '/api/inventaire/valider', entrant);
    expect((await corriger(12)).statusCode).toBe(409);
  });

  it('impute au sortant avec son code, et refuse un mauvais code', async () => {
    await relever(14);
    expect((await corriger(12, { pin_sortant: '9999' })).statusCode).toBe(403);
    const rep = await corriger(12, { pin_sortant: PIN_CAISSIER });
    expect(rep.json().correction.statut).toBe('RECONNUE_SORTANT');
  });

  it('un surplus annulé ne crée aucun litige', async () => {
    await relever(14);
    await db.update(inventaireLignes).set({ stock_initial: '12' }).where(eq(inventaireLignes.produit_id, produit));
    await db.update(inventaireLignes).set({ stock_compte: '14', stock_initial: '12' }).where(and(eq(inventaireLignes.produit_id, produit)));
    const rep = await corriger(12);
    expect(rep.statusCode).toBeLessThan(500);
  });

  it('le manager valide après la première heure, pas son propre travail', async () => {
    await relever(14);
    const { json } = await corriger(12);
    const id = json().correction.id;
    await db.update(servicesCaisse)
      .set({ ouvert_le: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(servicesCaisse.caissier_id, donnees.caissier2_id));
    const rep = await appel('POST', `/api/inventaire/corrections/${id}/valider`, entrant, { pin_manager: PIN_MANAGER });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().correction.statut).toBe('VALIDEE_MANAGER');
  });

  it('refuse le manager auteur de la correction', async () => {
    await relever(14);
    const manager = await seConnecter(app, donnees.manager_id, PIN_MANAGER);
    const rep = await corriger(12, { pin_manager: PIN_MANAGER }, manager);
    expect(rep.statusCode).toBe(403);
  });

  it('même caissier sur les deux shifts : imputé d’office', async () => {
    await shiftValide(sortant, 14);
    await cloturer(sortant);
    await appel('POST', '/api/services/ouvrir', sortant, { fond_de_caisse: 0 });
    await appel('GET', '/api/inventaire', sortant);
    const rep = await corriger(12, {}, sortant);
    expect(rep.json().correction.statut).toBe('RECONNUE_SORTANT');
  });

  it('une deuxième correction remplace la première et repart du chiffre reporté', async () => {
    await relever(14);
    await corriger(12);
    const rep = await corriger(14);
    expect(rep.json().correction.statut).toBe('SANS_LITIGE');
    const toutes = await db.select().from(correctionsStockInitial);
    expect(toutes.map((c) => c.statut).sort()).toEqual(['REMPLACEE', 'SANS_LITIGE']);
    expect(Number(rep.json().correction.stock_reporte)).toBe(14);
  });

  it('sans inventaire précédent : tracé, sans litige', async () => {
    await appel('POST', '/api/services/ouvrir', entrant, { fond_de_caisse: 0 });
    await appel('GET', '/api/inventaire', entrant);
    const rep = await corriger(5);
    expect(rep.json().correction).toMatchObject({ statut: 'SANS_LITIGE', caissier_sortant_id: null });
  });

  it('shift débloqué entre les deux : pas de validation sur place', async () => {
    await shiftValide(sortant, 14);
    await cloturer(sortant);
    await appel('POST', '/api/services/ouvrir', sortant, { fond_de_caisse: 0 });
    await appel('POST', '/api/inventaire/debloquer', sortant, { pin_manager: PIN_MANAGER, motif: 'Panne' });
    await cloturer(sortant);
    await appel('POST', '/api/services/ouvrir', entrant, { fond_de_caisse: 0 });
    await appel('GET', '/api/inventaire', entrant);
    const rep = await corriger(12);
    expect(rep.json().correction).toMatchObject({ statut: 'A_VALIDER', shift_intermediaire_debloque: true });
    expect((await appel('POST', `/api/inventaire/corrections/${rep.json().correction.id}/valider`, entrant, { pin_manager: PIN_MANAGER })).statusCode).toBe(409);
  });

  it('la clôture passe avec un litige en attente, et le fige au ticket Z', async () => {
    await relever(14);
    await corriger(12);
    await appel('PUT', `/api/inventaire/lignes/${produit}`, entrant, { stock_compte: 12 });
    await appel('POST', '/api/inventaire/valider', entrant);
    await cloturer(entrant);
    const [s] = await db.select().from(servicesCaisse).where(eq(servicesCaisse.caissier_id, donnees.caissier2_id));
    const z = s!.rapport_z as { corrections_stock_initial: { statut: string }[] };
    expect(z.corrections_stock_initial[0]!.statut).toBe('A_VALIDER');
  });

  it('le ticket Z du sortant ne bouge pas', async () => {
    await relever(14);
    const [avant] = await db.select().from(servicesCaisse).where(eq(servicesCaisse.caissier_id, donnees.caissier_id));
    await corriger(12);
    const [apres] = await db.select().from(servicesCaisse).where(eq(servicesCaisse.caissier_id, donnees.caissier_id));
    expect(apres!.rapport_z).toEqual(avant!.rapport_z);
  });
});
```

Au moment d'implémenter, adapter uniquement les aides aux noms réels de `Donnees`, de la route de clôture et de son corps. Remplacer le test « un surplus annulé » par un scénario réel : compter le sortant à 12 sur un stock attendu de 10, grâce à une entrée de 10 au premier shift, puis corriger à 10 et attendre `SANS_LITIGE`.

- [ ] **Step 2: Vérifier l'échec**

Run: `POS_TEST_DB=pos_samer_test_stock pnpm --filter @pos/server exec vitest run test/correction-stock-initial.test.ts`
Expected: FAIL, routes en 404.

- [ ] **Step 3: Écrire `correction.ts`**

```ts
/**
 * Correction du stock initial — lecture de l'origine du chiffre et vues.
 * La route est dans `routes-correction.ts`, la formule dans `@pos/shared`.
 */
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import type { LigneSortantCorrection } from '@pos/shared';
import { DELAI_CORRECTION_STOCK_MS } from '@pos/shared';
import type { DbOuTx } from '../../db/client.js';
import { correctionsStockInitial, inventaireLignes, inventairesService, servicesCaisse, utilisateurs } from '../../db/schema/index.js';

export interface SourceCorrection {
  service_sortant_id: string | null;
  caissier_sortant_id: string | null;
  caissier_sortant_nom: string | null;
  intermediaire: boolean;
  ligne: LigneSortantCorrection | null;
}

const SANS_SOURCE: SourceCorrection = {
  service_sortant_id: null, caissier_sortant_id: null, caissier_sortant_nom: null, intermediaire: false, ligne: null,
};

/** D'où vient le stock initial : le dernier inventaire validé d'un autre service. */
export async function sourceDuStock(dbx: DbOuTx, serviceId: string, produitId: string): Promise<SourceCorrection> {
  const [precedent] = await dbx.select().from(inventairesService)
    .where(and(eq(inventairesService.valide, true), ne(inventairesService.service_id, serviceId)))
    .orderBy(desc(inventairesService.valide_le)).limit(1);
  if (!precedent) return SANS_SOURCE;

  const [ligne] = await dbx.select().from(inventaireLignes)
    .where(and(eq(inventaireLignes.inventaire_id, precedent.id), eq(inventaireLignes.produit_id, produitId)));
  if (!ligne || ligne.stock_compte === null) return SANS_SOURCE;

  const [sortant] = await dbx
    .select({ caissier_id: servicesCaisse.caissier_id, nom: utilisateurs.nom_complet })
    .from(servicesCaisse)
    .leftJoin(utilisateurs, eq(utilisateurs.id, servicesCaisse.caissier_id))
    .where(eq(servicesCaisse.id, precedent.service_id));
  const [dernier] = await dbx.select({ id: servicesCaisse.id }).from(servicesCaisse)
    .where(eq(servicesCaisse.statut, 'CLOTURE')).orderBy(desc(servicesCaisse.cloture_le)).limit(1);

  return {
    service_sortant_id: precedent.service_id,
    caissier_sortant_id: sortant?.caissier_id ?? null,
    caissier_sortant_nom: sortant?.nom ?? null,
    // Un shift clôturé sans inventaire validé entre les deux : le chiffre vient
    // d'un caissier plus ancien, on ne peut pas nommer le fautif sur place.
    intermediaire: dernier?.id !== precedent.service_id,
    ligne: {
      stock_initial: Number(ligne.stock_initial),
      entrees: Number(ligne.entrees),
      sorties: Number(ligne.sorties),
      stock_compte: Number(ligne.stock_compte),
      quantite_expliquee: Number(ligne.quantite_expliquee),
    },
  };
}

/** Le chiffre d'origine, qui survit à une correction remplacée. */
export async function stockReporte(dbx: DbOuTx, inventaireId: string, produitId: string, stockActuel: number): Promise<number> {
  const [premiere] = await dbx.select({ stock: correctionsStockInitial.stock_reporte }).from(correctionsStockInitial)
    .where(and(eq(correctionsStockInitial.inventaire_id, inventaireId), eq(correctionsStockInitial.produit_id, produitId)))
    .orderBy(asc(correctionsStockInitial.created_at)).limit(1);
  return premiere ? Number(premiere.stock) : stockActuel;
}

export function finFenetre(ouvertLe: Date): Date {
  return new Date(ouvertLe.getTime() + DELAI_CORRECTION_STOCK_MS);
}

/** Les corrections actives d'un inventaire, avec le nom du sortant. */
export async function correctionsDuService(dbx: DbOuTx, inventaireId: string) {
  const lignes = await dbx
    .select({ correction: correctionsStockInitial, sortant: utilisateurs.nom_complet })
    .from(correctionsStockInitial)
    .leftJoin(utilisateurs, eq(utilisateurs.id, correctionsStockInitial.caissier_sortant_id))
    .where(and(eq(correctionsStockInitial.inventaire_id, inventaireId), ne(correctionsStockInitial.statut, 'REMPLACEE')))
    .orderBy(asc(correctionsStockInitial.created_at));
  return lignes.map(({ correction: c, sortant }) => ({
    id: c.id,
    produit_id: c.produit_id,
    produit_nom: c.produit_nom,
    stock_reporte: Number(c.stock_reporte),
    stock_apres: Number(c.stock_apres),
    explication: c.explication,
    statut: c.statut,
    sortant_nom: sortant ?? null,
    intermediaire: c.shift_intermediaire_debloque,
    ecart_sortant_apres: c.ecart_sortant_apres === null ? null : Number(c.ecart_sortant_apres),
  }));
}
```

- [ ] **Step 4: Écrire `routes-correction.ts`**

```ts
/**
 * Correction du stock initial pendant la première heure du shift.
 * L'heure part de l'ouverture du service : se reconnecter ne la relance pas.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, ne } from 'drizzle-orm';
import { effetCorrectionSortant, type StatutCorrectionStock } from '@pos/shared';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { correctionsStockInitial, inventaireLignes, inventairesService, produitsInventaire } from '../../db/schema/index.js';
import { ErreurMetier, introuvable } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';
import { verifierPinManager, verifierPinUtilisateur } from '../auth/pin.js';
import { serviceOuvertCourant, type ServiceOuvert } from '../depenses/service.js';
import { expliqueeInvalide, sortiesPourVentes } from './calcul.js';
import { finFenetre, sourceDuStock, stockReporte } from './correction.js';
import { etatInventaire, ventesEnCoursParProduit } from './service.js';

const CorrigerSchema = z.object({
  stock_initial: z.number({ invalid_type_error: 'Le stock doit être un nombre' }).min(0, 'Le stock ne peut pas être négatif').max(1_000_000, 'Stock invalide'),
  explication: z.string().trim().min(1, 'Expliquez cette correction').max(500),
  pin_sortant: z.string().min(4).optional(),
  pin_manager: z.string().min(4).optional(),
}).refine((c) => !(c.pin_sortant && c.pin_manager), { message: 'Un seul code à la fois' });

const ValiderSchema = z.object({
  pin_sortant: z.string().min(4).optional(),
  pin_manager: z.string().min(4).optional(),
}).refine((c) => Boolean(c.pin_sortant) !== Boolean(c.pin_manager), { message: 'Saisissez le code du sortant ou celui du manager' });

/** Un PIN faux refuse l'action sans fermer la session du caissier. */
async function verifierPinSortant(caissierId: string, pin: string): Promise<void> {
  try {
    await verifierPinUtilisateur(caissierId, pin);
  } catch (erreur) {
    if (erreur instanceof ErreurMetier && erreur.statusCode === 401) {
      throw new ErreurMetier('Ce n’est pas le code du caissier sortant', 403);
    }
    throw erreur;
  }
}

async function verifierManagerNonImplique(pin: string, contexte: string, auteur: string, service: ServiceOuvert): Promise<string> {
  const manager = await verifierPinManager(pin, contexte);
  if (manager.id === auteur || manager.id === service.caissier_id) {
    throw new ErreurMetier('Un autre manager doit valider : vous êtes concerné par cette correction', 403);
  }
  return manager.id;
}

export function routesCorrectionStock(app: FastifyInstance): void {
  const garde = app.exigePermission('inventaire.saisir');

  app.get('/api/inventaire/lignes/:produitId/correction', { preHandler: garde }, async (req) => {
    const { produitId } = req.params as { produitId: string };
    const service = await serviceOuvertCourant(db);
    return db.transaction(async (tx) => {
      const etat = await etatInventaire(tx, service.id);
      const ligne = etat.lignes.find((l) => l.produit_id === produitId && l.a_compter);
      if (!ligne) throw introuvable('Produit à compter');
      const source = await sourceDuStock(tx, service.id, produitId);
      const produits = await tx.select().from(produitsInventaire).where(eq(produitsInventaire.actif, true));
      const enCours = sortiesPourVentes(produits, await ventesEnCoursParProduit(tx, service.id));
      return {
        stock_actuel: ligne.stock_initial,
        stock_reporte: await stockReporte(tx, etat.inventaire.id, produitId, ligne.stock_initial),
        sorties_payees: ligne.sorties,
        sorties_en_cours: Math.round((enCours.get(produitId) ?? 0) * 100) / 100,
        fin: finFenetre(service.ouvert_le).toISOString(),
        sortant_id: source.caissier_sortant_id,
        sortant_nom: source.caissier_sortant_nom,
        meme_caissier: source.caissier_sortant_id === service.caissier_id,
        intermediaire: source.intermediaire,
        ligne_sortant: source.ligne,
      };
    });
  });

  app.post('/api/inventaire/lignes/:produitId/corriger-initial', { preHandler: garde }, async (req) => {
    const { produitId } = req.params as { produitId: string };
    const corps = valider(CorrigerSchema, req.body);
    const service = await serviceOuvertCourant(db);
    if (Date.now() > finFenetre(service.ouvert_le).getTime()) {
      throw new ErreurMetier('Le délai d’une heure pour corriger le stock initial est dépassé', 409);
    }
    const auteur = req.session!.utilisateur_id;

    const avantTx = await sourceDuStock(db, service.id, produitId);
    let reconnu = false;
    let managerId: string | null = null;
    if ((corps.pin_sortant || corps.pin_manager) && (!avantTx.ligne || avantTx.intermediaire)) {
      throw new ErreurMetier('Cette correction ne peut pas être validée sur place', 409);
    }
    if (corps.pin_sortant) {
      await verifierPinSortant(avantTx.caissier_sortant_id!, corps.pin_sortant);
      reconnu = true;
    }
    if (corps.pin_manager) managerId = await verifierManagerNonImplique(corps.pin_manager, 'CORRECTION_STOCK_INITIAL', auteur, service);

    const resultat = await db.transaction(async (tx) => {
      const etat = await etatInventaire(tx, service.id);
      if (etat.inventaire.valide) throw new ErreurMetier('Cet inventaire est validé : il n’est plus modifiable', 409);

      const [ligne] = await tx.select().from(inventaireLignes)
        .where(and(eq(inventaireLignes.inventaire_id, etat.inventaire.id), eq(inventaireLignes.produit_id, produitId)))
        .for('update');
      if (!ligne) throw introuvable('Produit à compter');
      const stockAvant = Number(ligne.stock_initial);
      if (corps.stock_initial === stockAvant) throw new ErreurMetier('Ce stock est déjà celui enregistré', 400);

      const [produit] = await tx.select().from(produitsInventaire).where(eq(produitsInventaire.id, produitId));
      if (!produit) throw introuvable('Produit');

      const reporte = await stockReporte(tx, etat.inventaire.id, produitId, stockAvant);
      const source = await sourceDuStock(tx, service.id, produitId);
      const effet = source.ligne ? effetCorrectionSortant(source.ligne, corps.stock_initial) : null;
      const memeCaissier = source.caissier_sortant_id === service.caissier_id && !source.intermediaire;

      const statut: StatutCorrectionStock = !effet?.litige
        ? 'SANS_LITIGE'
        : memeCaissier || reconnu ? 'RECONNUE_SORTANT'
        : managerId ? 'VALIDEE_MANAGER'
        : 'A_VALIDER';
      const validePar = statut === 'VALIDEE_MANAGER' ? managerId
        : statut === 'RECONNUE_SORTANT' ? source.caissier_sortant_id
        : null;

      const remplacees = await tx.update(correctionsStockInitial).set({ statut: 'REMPLACEE' })
        .where(and(
          eq(correctionsStockInitial.inventaire_id, etat.inventaire.id),
          eq(correctionsStockInitial.produit_id, produitId),
          ne(correctionsStockInitial.statut, 'REMPLACEE'),
        )).returning();
      for (const r of remplacees) {
        await ecrireOutbox(tx, 'corrections_stock_initial', 'UPDATE', r.id, r as unknown as Record<string, unknown>);
      }

      const [correction] = await tx.insert(correctionsStockInitial).values({
        inventaire_id: etat.inventaire.id,
        produit_id: produitId,
        produit_code: produit.code,
        produit_nom: produit.nom,
        produit_prix: produit.prix,
        stock_reporte: String(reporte),
        stock_avant: String(stockAvant),
        stock_apres: String(corps.stock_initial),
        explication: corps.explication,
        saisi_par: auteur,
        service_sortant_id: source.service_sortant_id,
        caissier_sortant_id: source.caissier_sortant_id,
        shift_intermediaire_debloque: source.intermediaire,
        ecart_sortant_avant: effet ? String(effet.ecart_avant) : null,
        ecart_sortant_apres: effet ? String(effet.ecart_apres) : null,
        statut,
        valide_par: validePar,
        valide_le: validePar ? new Date() : null,
      }).returning();
      await ecrireOutbox(tx, 'corrections_stock_initial', 'INSERT', correction!.id, correction as unknown as Record<string, unknown>);

      const [majLigne] = await tx.update(inventaireLignes).set({ stock_initial: String(corps.stock_initial) })
        .where(eq(inventaireLignes.id, ligne.id)).returning();
      await ecrireOutbox(tx, 'inventaire_lignes', 'UPDATE', ligne.id, majLigne as unknown as Record<string, unknown>);

      await journaliser(tx, {
        user_id: auteur,
        action: 'CORRECTION_STOCK_INITIAL',
        entite: 'corrections_stock_initial',
        entite_id: correction!.id,
        motif: corps.explication,
        meta: {
          produit: produit.nom, stock_reporte: reporte, avant: stockAvant, apres: corps.stock_initial,
          statut, sortant_id: source.caissier_sortant_id, valide_par: validePar,
        },
      });

      const apres = await etatInventaire(tx, service.id);
      const ligneApres = apres.lignes.find((l) => l.produit_id === produitId);
      if (ligneApres && expliqueeInvalide(ligneApres.ecart, ligneApres.quantite_expliquee)) {
        throw new ErreurMetier('Votre comptage explique plus d’unités que le nouvel écart. Corrigez d’abord l’explication.', 400);
      }
      return { correction: correction!, ligne: ligneApres ?? null, bilan: apres.bilan };
    });

    app.diffuser('inventaire', service.id);
    return resultat;
  });

  app.post('/api/inventaire/corrections/:id/valider', { preHandler: garde }, async (req) => {
    const { id } = req.params as { id: string };
    const corps = valider(ValiderSchema, req.body);
    const service = await serviceOuvertCourant(db);

    const [lue] = await db.select({ correction: correctionsStockInitial }).from(correctionsStockInitial)
      .innerJoin(inventairesService, eq(inventairesService.id, correctionsStockInitial.inventaire_id))
      .where(and(eq(correctionsStockInitial.id, id), eq(inventairesService.service_id, service.id)));
    if (!lue) throw new ErreurMetier('Cette correction n’appartient pas au shift en cours', 409);
    const c = lue.correction;
    if (c.statut !== 'A_VALIDER') throw new ErreurMetier('Cette correction a déjà été traitée', 409);
    if (c.shift_intermediaire_debloque || !c.caissier_sortant_id) {
      throw new ErreurMetier('Cette correction ne peut pas être validée sur place : elle sera décidée dans SamerTrackly', 409);
    }

    let validePar: string;
    let statut: StatutCorrectionStock;
    if (corps.pin_sortant) {
      await verifierPinSortant(c.caissier_sortant_id, corps.pin_sortant);
      validePar = c.caissier_sortant_id;
      statut = 'RECONNUE_SORTANT';
    } else {
      validePar = await verifierManagerNonImplique(corps.pin_manager!, 'VALIDATION_CORRECTION_STOCK', c.saisi_par, service);
      statut = 'VALIDEE_MANAGER';
    }

    const maj = await db.transaction(async (tx) => {
      const [m] = await tx.update(correctionsStockInitial)
        .set({ statut, valide_par: validePar, valide_le: new Date() })
        .where(and(eq(correctionsStockInitial.id, id), eq(correctionsStockInitial.statut, 'A_VALIDER')))
        .returning();
      if (!m) throw new ErreurMetier('Cette correction a déjà été traitée', 409);
      await ecrireOutbox(tx, 'corrections_stock_initial', 'UPDATE', id, m as unknown as Record<string, unknown>);
      await journaliser(tx, {
        user_id: validePar,
        action: 'VALIDATION_CORRECTION_STOCK',
        entite: 'corrections_stock_initial',
        entite_id: id,
        meta: { statut, demande_par: req.session!.utilisateur_id, produit: m.produit_nom },
      });
      return m;
    });

    app.diffuser('inventaire', service.id);
    return { correction: maj };
  });
}
```

Dans `service.ts` :

```ts
/**
 * Plats déjà lancés et pas encore payés. Ils sont sortis physiquement mais ne
 * comptent pas dans les sorties : sans ce chiffre, le caissier qui recompte
 * prendrait une table en cours pour un stock initial faux.
 */
export async function ventesEnCoursParProduit(dbx: DbOuTx, serviceId: string): Promise<Map<string, number>> {
  const lignes = await dbx
    .select({
      produit_id: inventaireConsommations.produit_id,
      quantite: sql<string>`COALESCE(SUM(${commandeItems.quantite} * ${inventaireConsommations.quantite}), 0)`,
    })
    .from(inventaireConsommations)
    .innerJoin(commandeItems, eq(commandeItems.article_id, inventaireConsommations.article_id))
    .innerJoin(commandes, eq(commandes.id, commandeItems.commande_id))
    .where(and(
      eq(commandes.service_id, serviceId),
      notInArray(commandes.statut, ['PAYEE', 'ANNULEE']),
      ne(commandeItems.statut_cuisine, 'ANNULE'),
      isNotNull(commandeItems.envoye_le),
    ))
    .groupBy(inventaireConsommations.produit_id);
  return new Map(lignes.map((l) => [l.produit_id, Number(l.quantite)]));
}
```

Remplacer dans son commentaire de `assurerInventaire` « repris, jamais modifiable » par « repris, corrigeable seulement pendant la première heure du shift (`routes-correction.ts`) », et faire de même au commentaire Drizzle. Ajouter à `GET /api/inventaire` :

```ts
correction_stock: {
  fin: finFenetre(service.ouvert_le).toISOString(),
  corrections: await correctionsDuService(db, etat.inventaire.id),
},
```

Enregistrer `routesCorrectionStock(app)` juste après `routesInventaire(app)` dans `app.ts`.

- [ ] **Step 5: Vérifier le succès et commiter**

Run: `POS_TEST_DB=pos_samer_test_stock pnpm --filter @pos/server exec vitest run test/correction-stock-initial.test.ts && pnpm --filter @pos/server build`
Expected: PASS, sauf le test de ticket Z en clôture qui passe à la tâche 3.

```bash
git add apps/server
git commit -m "feat(inventaire): corriger le stock initial pendant la première heure"
```

---

### Task 3: Ticket Z

**Files:**
- Modify: `packages/shared/src/types.ts` (après `inventaire` de `RapportZ`)
- Modify: `apps/server/src/modules/services/routes.ts:611-618`
- Modify: `apps/server/src/printer/ConsolePrinter.ts:196`
- Modify: `apps/server/src/printer/escpos.ts:745`
- Modify: `apps/caisse/src/screens/Cloture.tsx:425`
- Test: `apps/server/test/correction-stock-initial.test.ts`

**Interfaces:**
- Consumes: `correctionsDuService(dbx, inventaireId)`.
- Produces: `RapportZ.corrections_stock_initial?: { produit: string; avant: number; apres: number; statut: string; sortant: string | null }[]`, et `libelleStatutCorrection(statut)` dans `@pos/shared`.

- [ ] **Step 1: Vérifier l'échec du test de clôture**

Run: `POS_TEST_DB=pos_samer_test_stock pnpm --filter @pos/server exec vitest run test/correction-stock-initial.test.ts -t "ticket Z"`
Expected: FAIL sur `corrections_stock_initial` absent.

- [ ] **Step 2: Implémenter**

Type et libellés :

```ts
/** Corrections du stock initial de ce shift. Absent sur les anciens tickets. */
corrections_stock_initial?: { produit: string; avant: number; apres: number; statut: string; sortant: string | null }[];
```

```ts
const LIBELLES_STATUT_CORRECTION: Record<StatutCorrectionStock, string> = {
  SANS_LITIGE: 'Aucun litige',
  A_VALIDER: 'À décider dans SamerTrackly',
  RECONNUE_SORTANT: 'Reconnu par le sortant',
  VALIDEE_MANAGER: 'Validé par un manager',
  REMPLACEE: 'Remplacée',
};
export const libelleStatutCorrection = (s: string): string =>
  LIBELLES_STATUT_CORRECTION[s as StatutCorrectionStock] ?? s;
```

Dans la clôture, juste après le bloc `inventaire` :

```ts
corrections_stock_initial: (await correctionsDuService(tx, inventaire.inventaire.id)).map((c) => ({
  produit: c.produit_nom, avant: c.stock_reporte, apres: c.stock_apres, statut: c.statut, sortant: c.sortant_nom,
})),
```

Console :

```ts
...(z.corrections_stock_initial?.length
  ? [
      '-'.repeat(LARGEUR),
      'Corrections du stock initial :',
      ...z.corrections_stock_initial.flatMap((c) => [
        ligne(`  ${c.produit}`, `${qte(c.avant)} -> ${qte(c.apres)}`),
        `    ${libelleStatutCorrection(c.statut)}`,
      ]),
    ]
  : []),
```

ESC/POS, avant le bloc retours :

```ts
if (z.corrections_stock_initial?.length) {
  r.tiret().gras(true).ligne('CORRECTIONS STOCK INITIAL').gras(false);
  for (const c of z.corrections_stock_initial) {
    r.duo(c.produit, `${quantite(c.avant)} -> ${quantite(c.apres)}`);
    r.ligne(`  ${sansAccents(libelleStatutCorrection(c.statut))}`);
  }
}
```

Reprendre pour `sansAccents` la fonction de normalisation que `escpos.ts` utilise déjà si elle existe ; sinon utiliser `.normalize('NFD').replace(/[̀-ͯ]/g, '')` en local. Écran `Cloture.tsx`, sous le bloc inventaire :

```tsx
{rapport.corrections_stock_initial && rapport.corrections_stock_initial.length > 0 && (
  <div className="rounded-jeton bg-surface-douce px-4 py-3 text-sm">
    <div className="font-semibold text-fort">Corrections du stock initial</div>
    <ul className="mt-1 space-y-1 text-doux">
      {rapport.corrections_stock_initial.map((c) => (
        <li key={c.produit}>{c.produit} : {c.avant} → {c.apres} · {libelleStatutCorrection(c.statut)}</li>
      ))}
    </ul>
  </div>
)}
```

- [ ] **Step 3: Vérifier et commiter**

Run: `POS_TEST_DB=pos_samer_test_stock pnpm --filter @pos/server exec vitest run test/correction-stock-initial.test.ts && pnpm --filter @pos/server build && pnpm --filter @pos/caisse build`
Expected: tout PASS.

```bash
git add packages/shared apps/server apps/caisse
git commit -m "feat(rapport-z): corrections du stock initial sur le ticket"
```

---

### Task 4: Écran de la caisse

**Files:**
- Create: `apps/caisse/src/components/ModaleCorrectionStock.tsx`
- Modify: `apps/caisse/src/screens/Inventaire.tsx`

**Interfaces:**
- Consumes: les 3 routes de la tâche 2 et `effetCorrectionSortant`.
- Produces: `ModaleCorrectionStock({ ligne, onFermer, onCorrige, onErreur })`, `ModaleValiderCorrection({ correction, onFermer, onValide, onErreur })`.

- [ ] **Step 1: Écrire le composant**

```tsx
/**
 * Correction du stock initial : le caissier saisit le stock À L'OUVERTURE, pas
 * celui qu'il a sous les yeux. Les sorties sont rappelées pour faire le lien.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { effetCorrectionSortant, type LigneSortantCorrection } from '@pos/shared';
import { api } from '../api';
import { Modale } from './Modale';

interface Contexte {
  stock_actuel: number;
  stock_reporte: number;
  sorties_payees: number;
  sorties_en_cours: number;
  sortant_nom: string | null;
  meme_caissier: boolean;
  intermediaire: boolean;
  ligne_sortant: LigneSortantCorrection | null;
}

const qte = (n: number): string => n.toLocaleString('fr-FR', { maximumFractionDigits: 2 });

export function ChoixCode({ nomSortant, pin, setPin, type, setType }: {
  nomSortant: string | null; pin: string; setPin: (v: string) => void;
  type: 'sortant' | 'manager'; setType: (t: 'sortant' | 'manager') => void;
}) {
  return (
    <div>
      <div className="mb-2 flex gap-2">
        {(['sortant', 'manager'] as const).map((t) => (
          <button key={t} type="button" onClick={() => { setType(t); setPin(''); }}
            className={type === t ? 'btn-accent flex-1' : 'btn-blanc flex-1'}>
            {t === 'sortant' ? `Code de ${nomSortant ?? 'l’ancien caissier'}` : 'Code manager'}
          </button>
        ))}
      </div>
      <input type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)}
        className="w-full rounded-btn border border-bordure bg-surface px-4 py-3 text-2xl tracking-[0.4em] outline-none focus:border-marque" />
    </div>
  );
}

export function ModaleCorrectionStock({ ligne, onFermer, onCorrige, onErreur }: {
  ligne: { produit_id: string; nom: string; unite: string };
  onFermer: () => void; onCorrige: () => void; onErreur: (m: string) => void;
}) {
  const { data } = useQuery({
    queryKey: ['correction-stock', ligne.produit_id],
    gcTime: 0,
    queryFn: () => api<Contexte>(`/api/inventaire/lignes/${ligne.produit_id}/correction`),
  });
  const [valeur, setValeur] = useState('');
  const [explication, setExplication] = useState('');
  const [pin, setPin] = useState('');
  const [type, setType] = useState<'sortant' | 'manager'>('sortant');

  const corriger = useMutation({
    mutationFn: () => api(`/api/inventaire/lignes/${ligne.produit_id}/corriger-initial`, {
      method: 'POST',
      corps: {
        stock_initial: Number(valeur),
        explication,
        ...(pin ? (type === 'sortant' ? { pin_sortant: pin } : { pin_manager: pin }) : {}),
      },
    }),
    onSuccess: onCorrige,
    onError: (e: unknown) => onErreur((e as Error).message),
  });

  const nombre = valeur.trim() === '' ? null : Number(valeur);
  const effet = data?.ligne_sortant && nombre !== null ? effetCorrectionSortant(data.ligne_sortant, nombre) : null;
  const peutSigner = Boolean(effet?.litige) && !data?.meme_caissier && !data?.intermediaire;

  return (
    <Modale titre={`Modifier le stock initial — ${ligne.nom}`} onFermer={onFermer} enfants={!data ? (
      <p className="py-8 text-center text-doux">Chargement…</p>
    ) : (
      <div className="space-y-4">
        <div className="rounded-jeton bg-surface-douce px-4 py-3 text-sm text-doux">
          <div>Chiffre repris : <b className="text-fort">{qte(data.stock_reporte)} {ligne.unite}</b>{data.sortant_nom ? ` (${data.sortant_nom})` : ''}</div>
          <div>Déjà sorti depuis l’ouverture : <b className="text-fort">{qte(data.sorties_payees)}</b> payé, <b className="text-fort">{qte(data.sorties_en_cours)}</b> en cours</div>
        </div>
        <div>
          <div className="mb-2 text-sm font-semibold text-doux">Stock à l’ouverture du shift</div>
          <input type="number" inputMode="decimal" step="any" min={0} autoFocus value={valeur} onChange={(e) => setValeur(e.target.value)}
            className="w-full rounded-btn border border-bordure bg-surface px-4 py-3 text-2xl font-bold tabular-nums outline-none focus:border-marque" />
        </div>
        <div>
          <div className="mb-2 text-sm font-semibold text-doux">Explication (obligatoire)</div>
          <input type="text" value={explication} onChange={(e) => setExplication(e.target.value)} placeholder="Ex. recompté à la prise de poste"
            className="w-full rounded-btn border border-bordure bg-surface px-4 py-3 outline-none focus:border-marque" />
        </div>
        {effet && (
          <div className={`rounded-jeton px-4 py-3 text-sm font-semibold ${effet.litige ? 'bg-attente-tint text-attente-txt' : 'bg-ok-tint text-ok-txt'}`}>
            {effet.litige ? `Manquant de ${qte(effet.manque_apres - effet.manque_avant)} pour ${data.sortant_nom ?? 'le caissier sortant'}` : 'Aucun litige'}
          </div>
        )}
        {peutSigner && (
          <div>
            <p className="mb-2 text-sm text-doux">Facultatif. Sans code, le manager pourra valider avant la clôture, sinon la décision se prend dans SamerTrackly.</p>
            <ChoixCode nomSortant={data.sortant_nom} pin={pin} setPin={setPin} type={type} setType={setType} />
          </div>
        )}
        {effet?.litige && data.intermediaire && (
          <p className="text-sm text-doux">Le shift précédent a été débloqué sans comptage : la décision se prendra dans SamerTrackly.</p>
        )}
        <button type="button" disabled={nombre === null || nombre < 0 || !explication.trim() || corriger.isPending}
          className="btn-accent w-full py-4 text-lg disabled:opacity-50" onClick={() => corriger.mutate()}>
          Enregistrer la correction
        </button>
      </div>
    )} />
  );
}

export function ModaleValiderCorrection({ correction, onFermer, onValide, onErreur }: {
  correction: { id: string; produit_nom: string; sortant_nom: string | null };
  onFermer: () => void; onValide: () => void; onErreur: (m: string) => void;
}) {
  const [pin, setPin] = useState('');
  const [type, setType] = useState<'sortant' | 'manager'>('manager');
  const validerCorrection = useMutation({
    mutationFn: () => api(`/api/inventaire/corrections/${correction.id}/valider`, {
      method: 'POST', corps: type === 'sortant' ? { pin_sortant: pin } : { pin_manager: pin },
    }),
    onSuccess: onValide,
    onError: (e: unknown) => onErreur((e as Error).message),
  });
  return (
    <Modale titre={`Valider — ${correction.produit_nom}`} onFermer={onFermer} enfants={
      <div className="space-y-4">
        <p className="text-sm text-doux">Valider impute le manquant à {correction.sortant_nom ?? 'l’ancien caissier'}.</p>
        <ChoixCode nomSortant={correction.sortant_nom} pin={pin} setPin={setPin} type={type} setType={setType} />
        <button type="button" disabled={pin.length < 4 || validerCorrection.isPending}
          className="btn-accent w-full py-4 text-lg disabled:opacity-50" onClick={() => validerCorrection.mutate()}>
          Valider
        </button>
      </div>
    } />
  );
}
```

- [ ] **Step 2: Brancher dans `Inventaire.tsx`**

Ajouter `correction_stock` à `VueInventaire` :

```ts
correction_stock: {
  fin: string;
  corrections: { id: string; produit_id: string; produit_nom: string; stock_reporte: number; stock_apres: number; statut: string; sortant_nom: string | null; intermediaire: boolean }[];
};
```

Passer à `CarteProduit` les props `correction` (la correction de ce produit) et `fenetreOuverte` (`new Date(data.correction_stock.fin) > new Date() && !verrouille`). Sous le titre de la carte :

```tsx
{fenetreOuverte && (
  <button type="button" className="btn-blanc mt-2" onClick={() => setCorrigerStock(true)}>
    Modifier le stock initial
  </button>
)}
{correction && (
  <div className="mt-2 rounded-jeton bg-surface-douce px-3 py-2 text-sm">
    <span className="font-semibold text-fort">Stock initial corrigé : {qte(correction.stock_reporte)} → {qte(correction.stock_apres)}</span>
    <span className="ml-2 text-doux">{libelleStatutCorrection(correction.statut)}</span>
    {correction.statut === 'A_VALIDER' && !correction.intermediaire && (
      <button type="button" className="btn-blanc ml-3" onClick={() => setValiderCorrection(true)}>Valider</button>
    )}
  </div>
)}
```

Afficher les deux modales avec les états locaux `corrigerStock` et `validerCorrection`, et appeler `onEnregistre()` à leur succès.

- [ ] **Step 3: Vérifier et commiter**

Run: `pnpm --filter @pos/caisse build`
Expected: pas d'erreur TypeScript. Puis lancer la caisse localement et dérouler le scénario 14 → 12.

```bash
git add apps/caisse
git commit -m "feat(caisse): bouton Modifier le stock initial"
```

---

### Task 5: Cloud et pont vers SamerTrackly

**Files:**
- Create: `supabase/migrations/20261105000000_corrections_stock_initial.sql`
- Modify: `supabase/functions/_shared/tables.ts`
- Create: `supabase/functions/_shared/samtrackly-corrections.ts`
- Create: `supabase/functions/_shared/samtrackly-corrections.test.ts`
- Modify: `supabase/functions/_shared/samtrackly-api.ts`
- Modify: `supabase/functions/samtrackly-points/index.ts`

**Interfaces:**
- Consumes: la table POS et ses statuts.
- Produces: `construireCorrectionsSamtrackly(corrections, ctx)`, `rpc(nom, args)`, et l'appel `transmettre_correction_stock_initial(p_correction jsonb)`.

- [ ] **Step 1: Écrire le test en échec**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { construireCorrectionsSamtrackly } from './samtrackly-corrections.ts';

const base = {
  id: 'c1', produit_code: 'po8', produit_nom: 'Total poulet', produit_prix: 8000,
  stock_reporte: '14', stock_apres: '12', explication: 'Recompté', statut: 'A_VALIDER',
  service_sortant_id: 's0', shift_intermediaire_debloque: false,
};
const ctx = { posServiceId: 's1', restaurantId: 'r1', caissierPlaceNom: 'Awa', saisiParNom: 'Awa', nomsSortants: new Map([['s0', 'Koffi']]) };

test('transmet une correction avec des nombres et les noms', () => {
  const [c] = construireCorrectionsSamtrackly([base], ctx);
  assert.deepEqual(c, {
    pos_correction_id: 'c1', restaurant_id: 'r1', pos_service_place_id: 's1', pos_service_sortant_id: 's0',
    produit_id: 'po8', produit_nom: 'Total poulet', prix: 8000, stock_reporte: 14, stock_corrige: 12,
    explication: 'Recompté', statut_pos: 'A_VALIDER', shift_intermediaire_debloque: false,
    caissier_place_nom: 'Awa', caissier_sortant_nom: 'Koffi', saisi_par_nom: 'Awa',
  });
});

test('ne transmet jamais une correction remplacée', () => {
  assert.deepEqual(construireCorrectionsSamtrackly([{ ...base, statut: 'REMPLACEE' }], ctx), []);
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `node --test supabase/functions/_shared/samtrackly-corrections.test.ts`
Expected: FAIL, module introuvable.

- [ ] **Step 3: Écrire le module, la migration et le pont**

```ts
// Corrections du stock initial : conversion cloud POS → SamerTrackly. Le calcul
// d'argent est côté SamerTrackly, dans transmettre_correction_stock_initial.
export interface CorrectionCloud {
  id: string;
  produit_code: string;
  produit_nom: string;
  produit_prix: number;
  stock_reporte: string | number;
  stock_apres: string | number;
  explication: string;
  statut: string;
  service_sortant_id: string | null;
  shift_intermediaire_debloque: boolean;
}

export interface ContexteCorrections {
  posServiceId: string;
  restaurantId: string;
  caissierPlaceNom: string | null;
  saisiParNom: string | null;
  nomsSortants: Map<string, string | null>;
}

export function construireCorrectionsSamtrackly(corrections: CorrectionCloud[], ctx: ContexteCorrections) {
  return corrections.filter((c) => c.statut !== 'REMPLACEE').map((c) => ({
    pos_correction_id: c.id,
    restaurant_id: ctx.restaurantId,
    pos_service_place_id: ctx.posServiceId,
    pos_service_sortant_id: c.service_sortant_id,
    produit_id: c.produit_code,
    produit_nom: c.produit_nom,
    prix: Number(c.produit_prix),
    stock_reporte: Number(c.stock_reporte),
    stock_corrige: Number(c.stock_apres),
    explication: c.explication,
    statut_pos: c.statut,
    shift_intermediaire_debloque: c.shift_intermediaire_debloque,
    caissier_place_nom: ctx.caissierPlaceNom,
    caissier_sortant_nom: c.service_sortant_id ? ctx.nomsSortants.get(c.service_sortant_id) ?? null : null,
    saisi_par_nom: ctx.saisiParNom,
  }));
}
```

Migration cloud :

```sql
-- Corrections du stock initial, reçues des caisses par sync-push.
-- À passer AVANT de déployer sync-push et les caisses : une table inconnue finit
-- dans sync_rejets au lieu d'arriver à destination.
CREATE TABLE IF NOT EXISTS corrections_stock_initial (
  id UUID NOT NULL,
  restaurant_id UUID NOT NULL,
  inventaire_id UUID,
  produit_id UUID,
  produit_code TEXT,
  produit_nom TEXT,
  produit_prix INTEGER,
  stock_reporte NUMERIC(12,2),
  stock_avant NUMERIC(12,2),
  stock_apres NUMERIC(12,2),
  explication TEXT,
  saisi_par UUID,
  service_sortant_id UUID,
  caissier_sortant_id UUID,
  shift_intermediaire_debloque BOOLEAN,
  ecart_sortant_avant NUMERIC(12,2),
  ecart_sortant_apres NUMERIC(12,2),
  statut TEXT,
  valide_par UUID,
  valide_le TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  PRIMARY KEY (restaurant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_cloud_corrections_stock ON corrections_stock_initial (restaurant_id, inventaire_id);
ALTER TABLE corrections_stock_initial ENABLE ROW LEVEL SECURITY;
ALTER TABLE corrections_stock_initial FORCE ROW LEVEL SECURITY;
```

Dans `tables.ts`, sous `entrees_stock` de `COLONNES_VENTES` :

```ts
corrections_stock_initial: [
  'id', 'inventaire_id', 'produit_id', 'produit_code', 'produit_nom', 'produit_prix',
  'stock_reporte', 'stock_avant', 'stock_apres', 'explication', 'saisi_par',
  'service_sortant_id', 'caissier_sortant_id', 'shift_intermediaire_debloque',
  'ecart_sortant_avant', 'ecart_sortant_apres', 'statut', 'valide_par', 'valide_le', 'created_at',
],
```

Dans `samtrackly-api.ts` :

```ts
/** Appel d'une fonction SQL de SamerTrackly. */
export function rpc(nom: string, args: Record<string, unknown>): Promise<unknown[]> {
  return appeler(`rpc/${nom}`, { method: 'POST', headers: entetes(), body: JSON.stringify(args) }, `RPC ${nom}`);
}
```

Dans `samtrackly-points/index.ts`, à la fin du bloc `if (inventaireDuService)`, après les entrées :

```ts
    // Les corrections partent après l'inventaire de ce service : SamerTrackly
    // doit déjà connaître sa ligne. Un échec fait rejouer le transfert, et la
    // fonction SQL ignore une correction déjà connue : rien n'est facturé deux fois.
    await transmettreCorrections(admin, service, inventaireId, caissier.nom);
```

```ts
async function transmettreCorrections(
  admin: SupabaseClient,
  service: { id: string; restaurant_id: string },
  inventaireId: string,
  caissierNom: string | null,
): Promise<void> {
  const { data, error } = await admin
    .from('corrections_stock_initial')
    .select('id, produit_code, produit_nom, produit_prix, stock_reporte, stock_apres, explication, statut, service_sortant_id, caissier_sortant_id, saisi_par, shift_intermediaire_debloque')
    .eq('restaurant_id', service.restaurant_id)
    .eq('inventaire_id', inventaireId);
  if (error) throw new ErreurSamtrackly(`Corrections de stock illisibles : ${error.message}`);
  const corrections = data ?? [];
  if (corrections.length === 0) return;

  const nomsSortants = new Map<string, string | null>();
  const nomsAuteurs = new Map<string, string | null>();
  for (const c of corrections) {
    if (c.service_sortant_id && !nomsSortants.has(c.service_sortant_id)) {
      nomsSortants.set(c.service_sortant_id, (await resoudreCaissier(admin, c.caissier_sortant_id)).nom);
    }
    if (c.saisi_par && !nomsAuteurs.has(c.saisi_par)) {
      nomsAuteurs.set(c.saisi_par, (await resoudreCaissier(admin, c.saisi_par)).nom);
    }
  }
  for (const c of corrections) {
    const [ligne] = construireCorrectionsSamtrackly([c], {
      posServiceId: service.id,
      restaurantId: restaurantStIdDuService,
      caissierPlaceNom: caissierNom,
      saisiParNom: nomsAuteurs.get(c.saisi_par) ?? null,
      nomsSortants,
    });
    if (ligne) await rpc('transmettre_correction_stock_initial', { p_correction: ligne });
  }
}
```

Passer `restaurantStId` en paramètre à la place de `restaurantStIdDuService`, car `service.restaurant_id` reste le restaurant du cloud POS.

- [ ] **Step 4: Vérifier et commiter**

Run: `node --test supabase/functions/_shared/samtrackly-corrections.test.ts supabase/functions/_shared/samtrackly-inventaire.test.ts`
Expected: PASS.

```bash
git add supabase
git commit -m "feat(pont): transmettre les corrections de stock à SamerTrackly"
```

---

### Task 6: SQL SamerTrackly

**Files (dépôt `/Users/macbookpro/samtrackly`, branche `feat/correction-stock-initial`) :**
- Create: `supabase_correction_stock_initial.sql`
- Create: `scripts/test_correction_stock_initial.sql`

**Interfaces:**
- Consumes: `p_correction` de la tâche 5.
- Produces: `transmettre_correction_stock_initial(p_correction jsonb)`, `decider_correction_stock_initial(p_id uuid, p_decision text, p_par text)`, `corrections_stock_initial_du_point(p_point_id uuid)`.

- [ ] **Step 1: Écrire le test en échec**

Le script tourne sur un cluster PostgreSQL jetable, jamais sur une base réelle. Il crée des tables réduites, charge la migration, puis vérifie chaque cas.

```sql
-- Test LOCAL de supabase_correction_stock_initial.sql, sur un cluster jetable.
\set ON_ERROR_STOP on
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE points (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), montant_inventaire numeric DEFAULT 0);
CREATE TABLE inventaires_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), point_id uuid REFERENCES points(id),
  restaurant_id uuid, montant_a_deduire numeric DEFAULT 0, pos_service_id uuid UNIQUE);
CREATE TABLE inventaire_lignes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), inventaire_id uuid REFERENCES inventaires_shifts(id),
  produit_id text, produit_nom text, stock_initial numeric, entrees numeric, sorties numeric, stock_reel numeric,
  ecart numeric, nombre_explique numeric, montant_deduit numeric DEFAULT 0, explication text,
  explication_statut text, quantite_acceptee numeric, deduction_annulee boolean DEFAULT false, created_at timestamptz DEFAULT now());
CREATE TABLE journal_activite (id serial, action text, details jsonb, restaurant_id uuid, point_id uuid, user_nom text);
\i supabase_correction_stock_initial.sql

CREATE FUNCTION scenario(p_ecart_sortant numeric, p_reel_sortant numeric, p_expl numeric DEFAULT 0, p_ecart_place numeric DEFAULT 0)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE p1 uuid; p2 uuid; s1 uuid; s2 uuid; c uuid := gen_random_uuid();
BEGIN
  INSERT INTO points DEFAULT VALUES RETURNING id INTO p1;
  INSERT INTO points DEFAULT VALUES RETURNING id INTO p2;
  INSERT INTO inventaires_shifts (point_id, pos_service_id) VALUES (p1, gen_random_uuid()) RETURNING id INTO s1;
  INSERT INTO inventaires_shifts (point_id, pos_service_id) VALUES (p2, gen_random_uuid()) RETURNING id INTO s2;
  INSERT INTO inventaire_lignes (inventaire_id, produit_id, stock_reel, ecart, nombre_explique)
    VALUES (s1, 'po8', p_reel_sortant, p_ecart_sortant, p_expl);
  INSERT INTO inventaire_lignes (inventaire_id, produit_id, stock_initial, stock_reel, ecart)
    VALUES (s2, 'po8', 12, 12, p_ecart_place);
  RETURN c;
END $$;

CREATE FUNCTION correction(c uuid, statut text, reporte numeric, corrige numeric, sortant_absent boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE place uuid; sortant uuid;
BEGIN
  SELECT pos_service_id INTO sortant FROM inventaires_shifts ORDER BY ctid DESC OFFSET 1 LIMIT 1;
  SELECT pos_service_id INTO place FROM inventaires_shifts ORDER BY ctid DESC LIMIT 1;
  PERFORM transmettre_correction_stock_initial(jsonb_build_object(
    'pos_correction_id', c, 'restaurant_id', gen_random_uuid(), 'pos_service_place_id', place,
    'pos_service_sortant_id', CASE WHEN sortant_absent THEN gen_random_uuid() ELSE sortant END,
    'produit_id', 'po8', 'produit_nom', 'Total poulet', 'prix', 8000,
    'stock_reporte', reporte, 'stock_corrige', corrige, 'explication', 'Recompté', 'statut_pos', statut,
    'shift_intermediaire_debloque', false, 'caissier_place_nom', 'Awa', 'caissier_sortant_nom', 'Koffi', 'saisi_par_nom', 'Awa'));
END $$;

CREATE FUNCTION verifier(p_cond boolean, p_nom text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF NOT p_cond THEN RAISE EXCEPTION 'ÉCHEC : %', p_nom; END IF; RAISE NOTICE 'ok : %', p_nom; END $$;

-- 1. Reconnu sur place : le sortant paie, le rejeu ne facture pas deux fois.
DO $$ DECLARE c uuid := scenario(0, 14); BEGIN
  PERFORM correction(c, 'RECONNUE_SORTANT', 14, 12);
  PERFORM correction(c, 'RECONNUE_SORTANT', 14, 12);
  PERFORM verifier((SELECT montant_deduit FROM inventaire_lignes ORDER BY created_at DESC, ctid DESC OFFSET 1 LIMIT 1) = 16000, 'montant sortant');
  PERFORM verifier((SELECT montant_a_deduire FROM inventaires_shifts ORDER BY ctid DESC OFFSET 1 LIMIT 1) = 16000, 'total shift sans doublon');
END $$;

-- 2. Litige : rien ne bouge, puis Annuler fait payer 2 au caissier sur place.
DO $$ DECLARE c uuid := scenario(0, 14); i uuid; BEGIN
  PERFORM correction(c, 'A_VALIDER', 14, 12);
  SELECT id INTO i FROM corrections_stock_initial WHERE pos_correction_id = c;
  PERFORM verifier((SELECT statut FROM corrections_stock_initial WHERE id = i) = 'en_attente', 'en attente');
  PERFORM decider_correction_stock_initial(i, 'annulee', 'Samer');
  PERFORM verifier((SELECT montant_deduit FROM inventaire_lignes ORDER BY ctid DESC LIMIT 1) = 16000, 'montant caissier sur place');
  PERFORM verifier((SELECT montant_inventaire FROM points ORDER BY ctid DESC LIMIT 1) = 16000, 'total du point');
  BEGIN
    PERFORM decider_correction_stock_initial(i, 'validee', 'Autre');
    RAISE EXCEPTION 'la seconde décision devait être refusée';
  EXCEPTION WHEN raise_exception OR others THEN
    IF SQLERRM NOT LIKE '%LITIGE_DEJA_TRAITE%' THEN RAISE; END IF;
  END;
END $$;

-- 3. Valider 10 / 12 / 9 : le sortant paie 1, malgré une explication de surplus.
DO $$ DECLARE c uuid := scenario(2, 12, 2); i uuid; BEGIN
  PERFORM correction(c, 'A_VALIDER', 12, 9);
  SELECT id INTO i FROM corrections_stock_initial WHERE pos_correction_id = c;
  PERFORM decider_correction_stock_initial(i, 'validee', 'Samer');
  PERFORM verifier((SELECT montant_deduit FROM inventaire_lignes ORDER BY created_at DESC, ctid DESC OFFSET 1 LIMIT 1) = 8000, '1 × prix');
END $$;

-- 4. Surplus annulé : écart à zéro, explication en attente retirée.
DO $$ DECLARE c uuid := scenario(2, 12); BEGIN
  UPDATE inventaire_lignes SET explication_statut = 'en_attente', explication = 'Livraison'
    WHERE id = (SELECT id FROM inventaire_lignes ORDER BY created_at DESC, ctid DESC OFFSET 1 LIMIT 1);
  PERFORM correction(c, 'SANS_LITIGE', 12, 10);
  PERFORM verifier((SELECT ecart FROM inventaire_lignes ORDER BY created_at DESC, ctid DESC OFFSET 1 LIMIT 1) = 0, 'écart nul');
  PERFORM verifier((SELECT explication_statut FROM inventaire_lignes ORDER BY created_at DESC, ctid DESC OFFSET 1 LIMIT 1) IS NULL, 'explication retirée');
END $$;

-- 5. Déduction annulée : elle reste à zéro.
DO $$ DECLARE c uuid := scenario(0, 14); BEGIN
  UPDATE inventaire_lignes SET deduction_annulee = true
    WHERE id = (SELECT id FROM inventaire_lignes ORDER BY created_at DESC, ctid DESC OFFSET 1 LIMIT 1);
  PERFORM correction(c, 'RECONNUE_SORTANT', 14, 12);
  PERFORM verifier((SELECT montant_deduit FROM inventaire_lignes ORDER BY created_at DESC, ctid DESC OFFSET 1 LIMIT 1) = 0, 'annulation respectée');
END $$;

-- 6. Shift du sortant absent : décision manuelle, Valider refusé avec un message clair.
DO $$ DECLARE c uuid := scenario(0, 14); i uuid; BEGIN
  PERFORM correction(c, 'VALIDEE_MANAGER', 14, 12, true);
  SELECT id INTO i FROM corrections_stock_initial WHERE pos_correction_id = c;
  PERFORM verifier((SELECT statut FROM corrections_stock_initial WHERE id = i) = 'en_attente', 'passe en manuel');
  BEGIN
    PERFORM decider_correction_stock_initial(i, 'validee', 'Samer');
    RAISE EXCEPTION 'Valider devait être refusé';
  EXCEPTION WHEN raise_exception OR others THEN
    IF SQLERRM NOT LIKE '%SHIFT_SORTANT_ABSENT%' THEN RAISE; END IF;
  END;
END $$;

-- 7. Aperçu : les deux montants, avant la décision.
DO $$ DECLARE c uuid := scenario(0, 14); p uuid; r record; BEGIN
  PERFORM correction(c, 'A_VALIDER', 14, 12);
  SELECT point_id INTO p FROM inventaires_shifts ORDER BY ctid DESC LIMIT 1;
  SELECT * INTO r FROM corrections_stock_initial_du_point(p);
  PERFORM verifier(r.montant_si_valide = 16000 AND r.montant_si_annule = 16000, 'aperçu des montants');
END $$;
```

- [ ] **Step 2: Vérifier l'échec**

```bash
TMP=/private/tmp/claude-501/-Users-macbookpro-pos-samer/8d8619e1-44d1-4d26-9768-9d474ca9d8e8/scratchpad/pg-corrections
initdb -D "$TMP" -U postgres -A trust >/dev/null && pg_ctl -D "$TMP" -o "-p 5544 -k /tmp" -l "$TMP/log" -w start
psql -h /tmp -p 5544 -U postgres -f scripts/test_correction_stock_initial.sql
```
Expected: échec, `supabase_correction_stock_initial.sql` absent.

- [ ] **Step 3: Écrire la migration**

```sql
-- =====================================================================
--  CORRECTION DU STOCK INITIAL — reçue des caisses par le pont POS
--  Même recette que supabase_correction_entrees.sql : on recalcule la ligne,
--  le total du shift et le total du point. Le montant reste sur
--  inventaire_lignes.montant_deduit : Litiges, Récap et rapport mensuel
--  additionnent cette colonne.
--
--  Idempotent. À exécuter dans le SQL Editor Supabase (Samtrackly), AVANT de
--  déployer le pont. Les gérants n'ont rien à réinstaller pour ce script.
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.corrections_stock_initial (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pos_correction_id      uuid NOT NULL UNIQUE,
  restaurant_id          uuid,
  pos_service_place_id   uuid NOT NULL,
  pos_service_sortant_id uuid,
  produit_id             text NOT NULL,
  produit_nom            text,
  prix                   numeric NOT NULL,
  stock_reporte          numeric NOT NULL,
  stock_corrige          numeric NOT NULL,
  stock_reel_origine     numeric,
  explication            text NOT NULL,
  statut_pos             text NOT NULL,
  statut                 text NOT NULL CHECK (statut IN ('information','appliquee','en_attente','validee','annulee')),
  shift_intermediaire_debloque boolean NOT NULL DEFAULT false,
  caissier_place_nom     text,
  caissier_sortant_nom   text,
  saisi_par_nom          text,
  ancien_montant         numeric,
  nouveau_montant        numeric,
  decide_par             text,
  decide_at              timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_corrections_stock_place ON public.corrections_stock_initial (pos_service_place_id);
CREATE INDEX IF NOT EXISTS idx_corrections_stock_sortant ON public.corrections_stock_initial (pos_service_sortant_id);
CREATE INDEX IF NOT EXISTS idx_corrections_stock_attente ON public.corrections_stock_initial (restaurant_id) WHERE statut = 'en_attente';

ALTER TABLE public.corrections_stock_initial ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "lecture corrections_stock_initial" ON public.corrections_stock_initial;
CREATE POLICY "lecture corrections_stock_initial" ON public.corrections_stock_initial FOR SELECT USING (true);
-- Pas d'écriture directe : tout passe par les fonctions ci-dessous.

-- Le montant d'une ligne pour un nouvel écart. Même règle que
-- corriger_entree_inventaire, à un détail près : une explication écrite sur un
-- surplus n'excuse pas un manquant neuf.
CREATE OR REPLACE FUNCTION public._montant_correction_stock(
  p_ligne public.inventaire_lignes, p_ecart numeric, p_prix numeric
) RETURNS numeric LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE v_expliquee numeric := 0;
BEGIN
  IF COALESCE(p_ligne.deduction_annulee, false) THEN RETURN COALESCE(p_ligne.montant_deduit, 0); END IF;
  IF p_ecart IS NULL OR p_ecart >= 0 THEN RETURN 0; END IF;
  IF COALESCE(p_prix, 0) <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'PRIX_PRODUIT_INCONNU';
  END IF;
  IF COALESCE(p_ligne.ecart, 0) < 0 THEN
    v_expliquee := CASE WHEN p_ligne.explication_statut IN ('validee', 'refusee')
      THEN COALESCE(p_ligne.quantite_acceptee, 0) ELSE COALESCE(p_ligne.nombre_explique, 0) END;
  END IF;
  RETURN ROUND(GREATEST(0, ABS(p_ecart) - v_expliquee) * p_prix);
END $$;

-- Applique un nouvel écart à une ligne déjà verrouillée, et ajuste les totaux.
CREATE OR REPLACE FUNCTION public._appliquer_ecart_correction(
  p_ligne public.inventaire_lignes, p_ecart numeric, p_prix numeric,
  p_stock_reel numeric, p_stock_initial numeric,
  OUT ancien numeric, OUT nouveau numeric
) LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_shift public.inventaires_shifts%ROWTYPE;
BEGIN
  SELECT * INTO v_shift FROM public.inventaires_shifts WHERE id = p_ligne.inventaire_id FOR UPDATE;
  ancien := COALESCE(p_ligne.montant_deduit, 0);
  nouveau := public._montant_correction_stock(p_ligne, p_ecart, p_prix);
  UPDATE public.inventaire_lignes
     SET stock_reel = COALESCE(p_stock_reel, stock_reel),
         stock_initial = COALESCE(p_stock_initial, stock_initial),
         ecart = p_ecart,
         montant_deduit = nouveau,
         explication_statut = CASE WHEN ABS(COALESCE(p_ecart, 0)) < 0.01 AND explication_statut = 'en_attente'
                                   THEN NULL ELSE explication_statut END
   WHERE id = p_ligne.id;
  UPDATE public.inventaires_shifts
     SET montant_a_deduire = GREATEST(0, COALESCE(montant_a_deduire, 0) + (nouveau - ancien))
   WHERE id = v_shift.id;
  UPDATE public.points
     SET montant_inventaire = GREATEST(0, COALESCE(montant_inventaire, 0) + (nouveau - ancien))
   WHERE id = v_shift.point_id;
END $$;

CREATE OR REPLACE FUNCTION public._ligne_de_service(p_service uuid, p_produit text)
RETURNS public.inventaire_lignes LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT l.* FROM public.inventaire_lignes l
    JOIN public.inventaires_shifts s ON s.id = l.inventaire_id
   WHERE s.pos_service_id = p_service AND l.produit_id = p_produit
   ORDER BY l.created_at LIMIT 1;
$$;

-- Facture le sortant : sa ligne reprend le stock corrigé.
CREATE OR REPLACE FUNCTION public._imputer_sortant(p_c public.corrections_stock_initial, OUT ancien numeric, OUT nouveau numeric, OUT reel numeric)
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_ligne public.inventaire_lignes;
BEGIN
  v_ligne := public._ligne_de_service(p_c.pos_service_sortant_id, p_c.produit_id);
  IF v_ligne.id IS NULL OR v_ligne.stock_reel IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'SHIFT_SORTANT_ABSENT';
  END IF;
  PERFORM 1 FROM public.inventaire_lignes WHERE id = v_ligne.id FOR UPDATE;
  reel := v_ligne.stock_reel;
  SELECT r.ancien, r.nouveau INTO ancien, nouveau FROM public._appliquer_ecart_correction(
    v_ligne, COALESCE(v_ligne.ecart, 0) + (p_c.stock_corrige - v_ligne.stock_reel), p_c.prix, p_c.stock_corrige, NULL) r;
END $$;

-- Facture le caissier sur place : sa ligne repart du chiffre d'origine.
CREATE OR REPLACE FUNCTION public._imputer_place(p_c public.corrections_stock_initial, OUT ancien numeric, OUT nouveau numeric)
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_ligne public.inventaire_lignes; v_diff numeric := p_c.stock_reporte - p_c.stock_corrige;
BEGIN
  v_ligne := public._ligne_de_service(p_c.pos_service_place_id, p_c.produit_id);
  IF v_ligne.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'SHIFT_PLACE_ABSENT';
  END IF;
  PERFORM 1 FROM public.inventaire_lignes WHERE id = v_ligne.id FOR UPDATE;
  SELECT r.ancien, r.nouveau INTO ancien, nouveau FROM public._appliquer_ecart_correction(
    v_ligne, COALESCE(v_ligne.ecart, 0) - v_diff, p_c.prix, NULL, p_c.stock_reporte) r;
END $$;

CREATE OR REPLACE FUNCTION public.transmettre_correction_stock_initial(p_correction jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_c public.corrections_stock_initial%ROWTYPE;
  v_id uuid;
  v_ancien numeric;
  v_nouveau numeric;
  v_reel numeric;
  v_sortant_present boolean;
  v_statut text;
BEGIN
  INSERT INTO public.corrections_stock_initial (
    pos_correction_id, restaurant_id, pos_service_place_id, pos_service_sortant_id,
    produit_id, produit_nom, prix, stock_reporte, stock_corrige, explication, statut_pos,
    statut, shift_intermediaire_debloque, caissier_place_nom, caissier_sortant_nom, saisi_par_nom
  ) VALUES (
    (p_correction->>'pos_correction_id')::uuid, (p_correction->>'restaurant_id')::uuid,
    (p_correction->>'pos_service_place_id')::uuid, (p_correction->>'pos_service_sortant_id')::uuid,
    p_correction->>'produit_id', p_correction->>'produit_nom', (p_correction->>'prix')::numeric,
    (p_correction->>'stock_reporte')::numeric, (p_correction->>'stock_corrige')::numeric,
    p_correction->>'explication', p_correction->>'statut_pos', 'information',
    COALESCE((p_correction->>'shift_intermediaire_debloque')::boolean, false),
    p_correction->>'caissier_place_nom', p_correction->>'caissier_sortant_nom', p_correction->>'saisi_par_nom'
  ) ON CONFLICT (pos_correction_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN; END IF;  -- rejeu : rien à refaire, rien à défaire.

  SELECT * INTO v_c FROM public.corrections_stock_initial WHERE id = v_id;
  v_sortant_present := (public._ligne_de_service(v_c.pos_service_sortant_id, v_c.produit_id)).id IS NOT NULL;

  IF v_c.statut_pos = 'A_VALIDER' THEN
    v_statut := 'en_attente';
  ELSIF v_c.statut_pos = 'SANS_LITIGE' THEN
    v_statut := CASE WHEN v_sortant_present THEN 'appliquee' ELSE 'information' END;
  ELSIF v_c.statut_pos IN ('RECONNUE_SORTANT', 'VALIDEE_MANAGER') THEN
    v_statut := CASE WHEN v_sortant_present THEN 'appliquee' ELSE 'en_attente' END;
  ELSE
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'STATUT_CORRECTION_INVALIDE';
  END IF;

  IF v_statut = 'appliquee' THEN
    SELECT r.ancien, r.nouveau, r.reel INTO v_ancien, v_nouveau, v_reel FROM public._imputer_sortant(v_c) r;
  END IF;
  UPDATE public.corrections_stock_initial
     SET statut = v_statut, ancien_montant = v_ancien, nouveau_montant = v_nouveau, stock_reel_origine = v_reel
   WHERE id = v_id;
END $$;
REVOKE ALL ON FUNCTION public.transmettre_correction_stock_initial(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transmettre_correction_stock_initial(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.decider_correction_stock_initial(p_id uuid, p_decision text, p_par text)
RETURNS TABLE (statut text, nouveau_montant numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_c public.corrections_stock_initial%ROWTYPE;
  v_ancien numeric;
  v_nouveau numeric;
  v_reel numeric;
  v_par text := COALESCE(NULLIF(BTRIM(p_par), ''), 'Manager');
BEGIN
  IF p_decision NOT IN ('validee', 'annulee') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'DECISION_INVALIDE';
  END IF;
  SELECT * INTO v_c FROM public.corrections_stock_initial c WHERE c.id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'LITIGE_INTROUVABLE'; END IF;
  IF v_c.statut <> 'en_attente' THEN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'LITIGE_DEJA_TRAITE'; END IF;

  IF p_decision = 'validee' THEN
    SELECT r.ancien, r.nouveau, r.reel INTO v_ancien, v_nouveau, v_reel FROM public._imputer_sortant(v_c) r;
  ELSE
    SELECT r.ancien, r.nouveau INTO v_ancien, v_nouveau FROM public._imputer_place(v_c) r;
  END IF;

  UPDATE public.corrections_stock_initial c
     SET statut = p_decision, ancien_montant = v_ancien, nouveau_montant = v_nouveau,
         stock_reel_origine = v_reel, decide_par = v_par, decide_at = NOW()
   WHERE c.id = p_id;

  INSERT INTO public.journal_activite (action, details, restaurant_id, user_nom)
  VALUES ('decision_litige_stock_initial',
    jsonb_build_object('correction_id', p_id, 'decision', p_decision, 'produit', v_c.produit_nom,
      'ancien_montant', v_ancien, 'nouveau_montant', v_nouveau),
    v_c.restaurant_id, v_par);

  RETURN QUERY SELECT p_decision, v_nouveau;
END $$;
GRANT EXECUTE ON FUNCTION public.decider_correction_stock_initial(uuid, text, text) TO authenticated, service_role, anon;

-- L'aperçu de l'écran Vérification : les deux montants possibles, avant décision.
CREATE OR REPLACE FUNCTION public.corrections_stock_initial_du_point(p_point_id uuid)
RETURNS TABLE (
  id uuid, produit_nom text, stock_reporte numeric, stock_corrige numeric, explication text,
  statut text, shift_intermediaire_debloque boolean,
  caissier_place_nom text, caissier_sortant_nom text, saisi_par_nom text,
  sortant_arrive boolean, montant_si_valide numeric, montant_si_annule numeric,
  nouveau_montant numeric, decide_par text
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c public.corrections_stock_initial%ROWTYPE;
  v_sortant public.inventaire_lignes;
  v_place public.inventaire_lignes;
BEGIN
  FOR c IN
    SELECT k.* FROM public.corrections_stock_initial k
     WHERE EXISTS (SELECT 1 FROM public.inventaires_shifts s
                    WHERE s.point_id = p_point_id
                      AND s.pos_service_id IN (k.pos_service_place_id, k.pos_service_sortant_id))
     ORDER BY k.created_at
  LOOP
    v_sortant := public._ligne_de_service(c.pos_service_sortant_id, c.produit_id);
    v_place := public._ligne_de_service(c.pos_service_place_id, c.produit_id);
    id := c.id; produit_nom := c.produit_nom; stock_reporte := c.stock_reporte; stock_corrige := c.stock_corrige;
    explication := c.explication; statut := c.statut; shift_intermediaire_debloque := c.shift_intermediaire_debloque;
    caissier_place_nom := c.caissier_place_nom; caissier_sortant_nom := c.caissier_sortant_nom;
    saisi_par_nom := c.saisi_par_nom; nouveau_montant := c.nouveau_montant; decide_par := c.decide_par;
    sortant_arrive := v_sortant.id IS NOT NULL AND v_sortant.stock_reel IS NOT NULL;
    montant_si_valide := CASE WHEN sortant_arrive THEN public._montant_correction_stock(
      v_sortant, COALESCE(v_sortant.ecart, 0) + (c.stock_corrige - v_sortant.stock_reel), c.prix) END;
    montant_si_annule := CASE WHEN v_place.id IS NOT NULL THEN public._montant_correction_stock(
      v_place, COALESCE(v_place.ecart, 0) - (c.stock_reporte - c.stock_corrige), c.prix) END;
    RETURN NEXT;
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.corrections_stock_initial_du_point(uuid) TO authenticated, service_role, anon;

SELECT 'corrections_stock_initial OK' AS controle
  FROM information_schema.tables
 WHERE table_schema = 'public' AND table_name = 'corrections_stock_initial';
```

- [ ] **Step 4: Vérifier, arrêter le cluster et commiter**

Run : `psql -h /tmp -p 5544 -U postgres -f scripts/test_correction_stock_initial.sql 2>&1 | grep -E "ok :|ÉCHEC|ERROR"`
Expected: toutes les lignes `ok :`, aucune `ÉCHEC` ou `ERROR`. Corriger, recréer le cluster et relancer si besoin. Puis `pg_ctl -D "$TMP" stop` et supprimer le dossier.

```bash
cd /Users/macbookpro/samtrackly
git checkout -b feat/correction-stock-initial
git add supabase_correction_stock_initial.sql scripts/test_correction_stock_initial.sql
git commit -m "feat(inventaire): litiges de stock initial reçus du POS"
```

---

### Task 7: Écrans SamerTrackly

**Files (dépôt `/Users/macbookpro/samtrackly`) :**
- Create: `lib/correctionStockInitial.js`
- Create: `lib/correctionStockInitial.test.mjs`
- Create: `components/LitigesStockInitial.js`
- Modify: `app/verification.js` (avant « SECTION 2 »)
- Modify: `app/litiges.js`

**Interfaces:**
- Consumes: `corrections_stock_initial_du_point(p_point_id)`, `decider_correction_stock_initial(...)`.
- Produces: `messageDecision(erreur)`, `chargerLitigesStock(pointId)`, `deciderLitigeStock(id, decision, par)`, `compterLitigesStockEnAttente(restaurantId)`, composant `LitigesStockInitial({ pointId, utilisateur, onDecide })`.

- [ ] **Step 1: Écrire le test en échec**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { messageDecision } from './correctionStockInitial.messages.js'

test('traduit les erreurs SQL en français', () => {
  assert.equal(messageDecision({ message: 'LITIGE_DEJA_TRAITE' }), 'Ce litige a déjà été traité')
  assert.equal(messageDecision({ message: 'SHIFT_SORTANT_ABSENT' }), 'Le shift du caissier sortant n’est pas encore arrivé. Réessayez plus tard.')
  assert.equal(messageDecision({ message: 'PGRST202 does not exist' }), 'Script supabase_correction_stock_initial.sql non passé dans Supabase.')
  assert.equal(messageDecision({ message: 'autre' }), 'autre')
})
```

Le test importe `correctionStockInitial.messages.js`, sans dépendance Supabase : ajouter ce fichier à la liste **Create**.

- [ ] **Step 2: Vérifier l'échec**

Run: `node lib/correctionStockInitial.test.mjs`
Expected: FAIL, module introuvable.

- [ ] **Step 3: Implémenter**

`lib/correctionStockInitial.messages.js` :

```js
const MESSAGES = {
  LITIGE_DEJA_TRAITE: 'Ce litige a déjà été traité',
  LITIGE_INTROUVABLE: 'Litige introuvable',
  SHIFT_SORTANT_ABSENT: 'Le shift du caissier sortant n’est pas encore arrivé. Réessayez plus tard.',
  SHIFT_PLACE_ABSENT: 'Le shift du caissier sur place n’est pas encore arrivé. Réessayez plus tard.',
  PRIX_PRODUIT_INCONNU: 'Le prix de ce produit est inconnu : impossible de calculer la retenue.',
}

export function messageDecision(erreur) {
  const m = erreur?.message || ''
  for (const [code, texte] of Object.entries(MESSAGES)) if (m.includes(code)) return texte
  if (/PGRST202|does not exist/.test(m)) return 'Script supabase_correction_stock_initial.sql non passé dans Supabase.'
  return m
}
```

`lib/correctionStockInitial.js` :

```js
import { supabase } from './supabase'
import { messageDecision } from './correctionStockInitial.messages'

export async function chargerLitigesStock(pointId) {
  const { data, error } = await supabase.rpc('corrections_stock_initial_du_point', { p_point_id: pointId })
  // Script pas encore passé : l'écran Vérification doit continuer à fonctionner.
  if (error) return []
  return data || []
}

export async function deciderLitigeStock(id, decision, par) {
  const { error } = await supabase.rpc('decider_correction_stock_initial', { p_id: id, p_decision: decision, p_par: par })
  if (error) throw new Error(messageDecision(error))
}

export async function compterLitigesStockEnAttente(restaurantId) {
  let requete = supabase.from('corrections_stock_initial').select('id', { count: 'exact', head: true }).eq('statut', 'en_attente')
  if (restaurantId) requete = requete.eq('restaurant_id', restaurantId)
  const { count, error } = await requete
  return error ? 0 : count || 0
}
```

`components/LitigesStockInitial.js` :

```js
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { chargerLitigesStock, deciderLitigeStock } from '../lib/correctionStockInitial'

const fcfa = (n) => `${Math.round(n || 0).toLocaleString('fr-FR')} F`
const LIBELLES = { validee: 'Validé : le sortant paie', annulee: 'Annulé : le caissier sur place paie', appliquee: 'Réglé sur place', information: 'Pour information' }

export default function LitigesStockInitial({ pointId, utilisateur, onDecide }) {
  const [litiges, setLitiges] = useState([])
  const [enCours, setEnCours] = useState(null)

  const charger = useCallback(async () => {
    if (pointId) setLitiges(await chargerLitigesStock(pointId))
  }, [pointId])
  useEffect(() => { charger() }, [charger])

  function confirmer(l, decision) {
    const texte = decision === 'validee'
      ? `${l.caissier_sortant_nom || 'Le caissier sortant'} paiera ${fcfa(l.montant_si_valide)}.`
      : `${l.caissier_place_nom || 'Le caissier sur place'} paiera ${fcfa(l.montant_si_annule)}.`
    Alert.alert(decision === 'validee' ? 'Valider ce litige ?' : 'Annuler cette correction ?', texte, [
      { text: 'Retour', style: 'cancel' },
      { text: 'Confirmer', onPress: () => decider(l, decision) },
    ])
  }

  async function decider(l, decision) {
    setEnCours(l.id)
    try {
      await deciderLitigeStock(l.id, decision, utilisateur)
      await charger()
      await onDecide?.()
    } catch (e) {
      Alert.alert('Décision impossible', e.message)
    } finally {
      setEnCours(null)
    }
  }

  if (litiges.length === 0) return null
  return (
    <View style={styles.bloc}>
      <Text style={styles.titre}>Litiges de stock initial ({litiges.length})</Text>
      {litiges.map((l) => (
        <View key={l.id} style={styles.carte}>
          <Text style={styles.produit}>{l.produit_nom} : {l.stock_reporte} → {l.stock_corrige}</Text>
          <Text style={styles.ligne}>Corrigé par {l.saisi_par_nom || l.caissier_place_nom || '—'} · Sortant : {l.caissier_sortant_nom || '—'}</Text>
          <Text style={styles.ligne}>« {l.explication} »</Text>
          {l.shift_intermediaire_debloque && (
            <Text style={styles.alerte}>Un shift a été débloqué sans comptage entre les deux : le chiffre vient d’un caissier plus ancien.</Text>
          )}
          {l.statut === 'en_attente' ? (
            enCours === l.id ? <ActivityIndicator /> : (
              <>
                {!l.sortant_arrive && <Text style={styles.alerte}>Le shift du sortant n’est pas encore arrivé.</Text>}
                <View style={styles.boutons}>
                  <TouchableOpacity style={[styles.bouton, styles.valider]} disabled={!l.sortant_arrive} onPress={() => confirmer(l, 'validee')}>
                    <Text style={styles.boutonTxt}>Valider · sortant {l.montant_si_valide != null ? fcfa(l.montant_si_valide) : ''}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.bouton, styles.annuler]} onPress={() => confirmer(l, 'annulee')}>
                    <Text style={styles.boutonTxt}>Annuler · sur place {fcfa(l.montant_si_annule)}</Text>
                  </TouchableOpacity>
                </View>
              </>
            )
          ) : (
            <Text style={styles.statut}>{LIBELLES[l.statut]}{l.decide_par ? ` · ${l.decide_par}` : ''}{l.nouveau_montant ? ` · ${fcfa(l.nouveau_montant)}` : ''}</Text>
          )}
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  bloc: { marginBottom: 16 },
  titre: { fontSize: 15, fontWeight: '700', marginBottom: 8 },
  carte: { borderWidth: 1, borderColor: '#E5E5E5', borderRadius: 10, padding: 12, marginBottom: 8, backgroundColor: '#FFFFFF' },
  produit: { fontSize: 15, fontWeight: '700' },
  ligne: { fontSize: 13, color: '#555555', marginTop: 4 },
  alerte: { fontSize: 13, color: '#854F0B', marginTop: 6, fontWeight: '600' },
  statut: { fontSize: 13, color: '#3B6D11', marginTop: 8, fontWeight: '700' },
  boutons: { flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' },
  bouton: { flex: 1, minWidth: 150, minHeight: 44, borderRadius: 8, padding: 10, alignItems: 'center', justifyContent: 'center' },
  valider: { backgroundColor: '#3B6D11' },
  annuler: { backgroundColor: '#A32D2D' },
  boutonTxt: { color: '#FFFFFF', fontWeight: '700', fontSize: 13, textAlign: 'center' },
})
```

Dans `app/verification.js`, juste avant le commentaire `SECTION 2` :

```jsx
{peutVoirEcarts && (
  <LitigesStockInitial
    pointId={pointSelectionne?.id}
    utilisateur={nomUtilisateurActif}
    onDecide={() => chargerInventaire(pointSelectionne)}
  />
)}
```

Reprendre pour `nomUtilisateurActif` la valeur que `deciderEcartInv` passe déjà à `par`. Rendre le bloc aussi lorsqu'aucun inventaire n'est affiché n'est pas nécessaire : le service sur place a toujours un inventaire. Dans `app/litiges.js`, charger `compterLitigesStockEnAttente(restaurantId)` à l'ouverture et afficher, si le nombre est positif :

```jsx
<View style={styles.rappelLitigesStock}>
  <Text style={styles.rappelLitigesStockTxt}>
    {nb} litige{nb > 1 ? 's' : ''} de stock initial à décider dans l’écran Vérification.
  </Text>
</View>
```

- [ ] **Step 4: Vérifier et commiter**

Run: `node lib/correctionStockInitial.test.mjs && npm run lint -- app/verification.js app/litiges.js components/LitigesStockInitial.js lib/correctionStockInitial.js`
Expected: test PASS, lint sans nouvelle erreur.

```bash
git add lib/correctionStockInitial.js lib/correctionStockInitial.messages.js lib/correctionStockInitial.test.mjs components/LitigesStockInitial.js app/verification.js app/litiges.js
git commit -m "feat(verification): décider les litiges de stock initial"
```

---

### Task 8: Vérification finale et notice de déploiement

**Files:**
- Create: `docs/DEPLOIEMENT_CORRECTION_STOCK.md`
- Modify: `docs/ETAT_PROJET.md`
- Modify: `CLAUDE.md` (règle métier)

- [ ] **Step 1: Ajouter la règle à `CLAUDE.md`**

```markdown
### Correction du stock initial
Pendant la première heure du shift (`ouvert_le`), le caissier peut corriger le
stock initial d'un produit, avec une explication obligatoire. On recalcule l'écart
du sortant, on ne soustrait jamais. Un manquant créé ou augmenté est imputé au
sortant par son code ou celui d'un manager, sinon le litige part dans SamerTrackly.
```

- [ ] **Step 2: Écrire la notice de déploiement**

Lister dans cet ordre : SQL SamerTrackly et écrans ; migration cloud, puis `sync-push` et `samtrackly-points` ; mise à jour des caisses. Préciser pour chaque étape la commande, le contrôle et le retour arrière.

- [ ] **Step 3: Lancer toute la vérification**

```bash
POS_TEST_DB=pos_samer_test_stock pnpm --filter @pos/server test
node --test supabase/functions/_shared/*.test.ts
pnpm --recursive --filter '!@pos/desktop' build
```
Expected: tout vert. En cas d'échec, relever la sortie exacte.

- [ ] **Step 4: Commiter**

```bash
git add CLAUDE.md docs
git commit -m "docs(inventaire): règle et déploiement de la correction du stock initial"
```
