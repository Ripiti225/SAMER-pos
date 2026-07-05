/**
 * MONTÉE des ventes (local → cloud) — §A. Règles NON NÉGOCIABLES :
 *  - ordre strict par seq, lots de 200 max ;
 *  - synced_at marqué UNIQUEMENT pour les seq explicitement acquittés ;
 *  - toute erreur → on ne marque rien, on réessaie (backoff) ; jamais de
 *    suppression de l'outbox en cas d'erreur ;
 *  - ne bloque JAMAIS une vente (boucle de fond indépendante).
 */
import { and, asc, isNull, lte, lt, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { syncOutbox } from '../../db/schema/index.js';
import type { ClientCloud, LignePush } from './cloud-client.js';
import { etatSync } from './etat.js';

export const LOT_MAX = 200;
const RETENTION_JOURS = 30;

export async function compterEnAttente(): Promise<number> {
  const [r] = await db
    .select({ n: sql<string>`COUNT(*)` })
    .from(syncOutbox)
    .where(isNull(syncOutbox.synced_at));
  return Number(r?.n ?? 0);
}

export interface ResultatLot {
  envoye: number;
  acquitte_jusqua_seq: number;
  reste: number;
  fini: boolean;
}

/**
 * Pousse UN lot (≤ 200 lignes). Idempotent côté cloud : rejouer le même lot ne
 * crée aucun doublon. Lève l'erreur du client en cas d'échec (rien n'est
 * marqué). Retourne fini=true quand la file est vide.
 */
export async function pousserUnLot(client: ClientCloud): Promise<ResultatLot> {
  const lignes = await db
    .select()
    .from(syncOutbox)
    .where(isNull(syncOutbox.synced_at))
    .orderBy(asc(syncOutbox.seq))
    .limit(LOT_MAX);

  if (lignes.length === 0) {
    etatSync.majEnAttente(0);
    return { envoye: 0, acquitte_jusqua_seq: 0, reste: 0, fini: true };
  }

  const charge: LignePush[] = lignes.map((l) => ({
    seq: Number(l.seq),
    table_name: l.table_name,
    record_id: l.record_id,
    operation: l.operation,
    payload: l.payload as Record<string, unknown>,
  }));

  // Peut lever ErreurSync — on laisse remonter SANS rien marquer.
  const { acquitte_jusqua_seq } = await client.push(charge);

  if (acquitte_jusqua_seq > 0) {
    // Marque synced_at UNIQUEMENT le préfixe acquitté (et jamais deux fois).
    await db
      .update(syncOutbox)
      .set({ synced_at: new Date() })
      .where(and(isNull(syncOutbox.synced_at), lte(syncOutbox.seq, acquitte_jusqua_seq)));
  }

  const reste = await compterEnAttente();
  etatSync.succesMontee(reste);
  return {
    envoye: lignes.length,
    acquitte_jusqua_seq,
    reste,
    fini: reste === 0,
  };
}

/** Vide la file entière (plusieurs lots) jusqu'à épuisement ou erreur. */
export async function pousserTout(client: ClientCloud, maxLots = 1000): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxLots; i++) {
    const r = await pousserUnLot(client);
    total += r.acquitte_jusqua_seq > 0 ? r.envoye : 0;
    if (r.fini) break;
  }
  return total;
}

/** Purge l'outbox acquitté de plus de 30 jours (jamais avant). */
export async function purgerOutbox(): Promise<number> {
  const limite = new Date(Date.now() - RETENTION_JOURS * 24 * 3600 * 1000);
  const supprimes = await db
    .delete(syncOutbox)
    .where(and(sql`${syncOutbox.synced_at} IS NOT NULL`, lt(syncOutbox.synced_at, limite)))
    .returning({ seq: syncOutbox.seq });
  return supprimes.length;
}
