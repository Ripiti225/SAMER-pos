import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { auditLog, syncOutbox } from '../src/db/schema/index.js';
import { journaliser } from '../src/modules/audit/audit.js';
import {
  ouvrirServiceEtCommande,
  PIN_CAISSIER,
  resetDonnees,
  seConnecter,
  type Donnees,
} from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

/** Drizzle enveloppe l'erreur PostgreSQL : le message du trigger est dans la cause. */
function messageComplet(e: unknown): string {
  const erreur = e as Error & { cause?: Error };
  return `${erreur.message} ${erreur.cause?.message ?? ''}`;
}

describe('audit_log append-only (trigger SQL §14.2)', () => {
  it('le trigger bloque toute mise à jour', async () => {
    await db.transaction(async (tx) => {
      await journaliser(tx, { action: 'CONNEXION', entite: 'utilisateurs', entite_id: donnees.caissier_id });
    });
    const [entree] = await db.select().from(auditLog).limit(1);
    expect(entree).toBeDefined();

    const echec = await db
      .update(auditLog)
      .set({ motif: 'falsification' })
      .where(eq(auditLog.seq, entree!.seq))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(echec).not.toBeNull();
    expect(messageComplet(echec)).toContain('append-only');
  });

  it('le trigger bloque toute suppression', async () => {
    const [entree] = await db.select().from(auditLog).limit(1);
    const echec = await db
      .delete(auditLog)
      .where(eq(auditLog.seq, entree!.seq))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(echec).not.toBeNull();
    expect(messageComplet(echec)).toContain('append-only');

    // la ligne est toujours là, intacte
    const [toujours] = await db.select().from(auditLog).where(eq(auditLog.seq, entree!.seq));
    expect(toujours).toBeDefined();
  });
});

describe('sync_outbox : écrit dans la MÊME transaction que la donnée métier', () => {
  it('alimente l’outbox pour service, commande, item et paiement', async () => {
    const { commande_id, service_id } = await ouvrirServiceEtCommande(app, cookies, donnees, 1);

    const lignesService = await db
      .select()
      .from(syncOutbox)
      .where(and(eq(syncOutbox.table_name, 'services_caisse'), eq(syncOutbox.record_id, service_id)));
    expect(lignesService.some((l) => l.operation === 'INSERT')).toBe(true);

    const lignesCommande = await db
      .select()
      .from(syncOutbox)
      .where(and(eq(syncOutbox.table_name, 'commandes'), eq(syncOutbox.record_id, commande_id)));
    expect(lignesCommande.some((l) => l.operation === 'INSERT')).toBe(true);
    // l'ajout d'item recalcule les totaux → UPDATE de la commande aussi dans l'outbox
    expect(lignesCommande.some((l) => l.operation === 'UPDATE')).toBe(true);

    const items = await db.select().from(syncOutbox).where(eq(syncOutbox.table_name, 'commande_items'));
    expect(items.length).toBeGreaterThan(0);

    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commande_id}/paiements`,
      cookies,
      payload: { mode: 'ESPECES', montant: 3000 },
    });
    expect(rep.statusCode).toBe(200);
    const paiementsOutbox = await db.select().from(syncOutbox).where(eq(syncOutbox.table_name, 'paiements'));
    expect(paiementsOutbox.length).toBe(1);

    // le payload contient bien la ligne complète sérialisée
    expect((paiementsOutbox[0]!.payload as { montant: number }).montant).toBe(3000);
  });

  it('rollback transactionnel : un échec en cours de route ne laisse AUCUNE ligne outbox', async () => {
    const avant = (
      await db.execute<{ avant: string }>(sql`SELECT COUNT(*)::text AS avant FROM sync_outbox`)
    ).rows[0]!.avant;

    // Supplément inexistant → l'insertion de l'item échoue APRÈS le verrou et
    // AVANT le commit : toute la transaction (item + outbox) doit être annulée.
    const c = await app.inject({ method: 'POST', url: '/api/commandes', cookies, payload: { type: 'EMPORTER' } });
    const id = c.json().id as string;
    const nbApresCreation = (
      await db.execute<{ n: string }>(sql`SELECT COUNT(*)::text AS n FROM sync_outbox`)
    ).rows[0]!.n;

    const rep = await app.inject({
      method: 'POST',
      url: `/api/commandes/${id}/items`,
      cookies,
      payload: {
        article_id: donnees.article_id,
        quantite: 1,
        options: [],
        supplements: [{ id: '00000000-0000-0000-0000-000000000000' }],
      },
    });
    expect(rep.statusCode).toBe(400);

    const nbFinal = (
      await db.execute<{ n: string }>(sql`SELECT COUNT(*)::text AS n FROM sync_outbox`)
    ).rows[0]!.n;
    expect(nbFinal).toBe(nbApresCreation);
    expect(Number(nbFinal)).toBeGreaterThan(Number(avant));

    const itemsOrphelins = await db
      .select()
      .from(syncOutbox)
      .where(and(eq(syncOutbox.table_name, 'commande_items'), eq(syncOutbox.operation, 'INSERT')));
    // aucun item outbox ne référence la commande dont l'ajout a échoué
    for (const l of itemsOrphelins) {
      expect((l.payload as { commande_id: string }).commande_id).not.toBe(id);
    }
  });
});
