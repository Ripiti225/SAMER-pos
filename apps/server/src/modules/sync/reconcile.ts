/**
 * Réconciliation quotidienne (§C) — le filet de sécurité.
 * Le local calcule ses chiffres de la veille, le cloud recalcule les siens ;
 * en cas d'écart, on re-pousse (idempotent) les lignes du jour puis on
 * re-vérifie. Écart persistant → audit ECART_RECONCILIATION + voyant rouge.
 * Note : Côte d'Ivoire = UTC+0 → le jour local == le jour UTC.
 */
import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import type { ModePaiement } from '@pos/shared';
import { MODES_PAIEMENT } from '@pos/shared';
import { db } from '../../db/client.js';
import { commandes, paiements, syncOutbox } from '../../db/schema/index.js';
import { journaliser } from '../audit/audit.js';
import type { ClientCloud, ReponseReconcile } from './cloud-client.js';
import { etatSync } from './etat.js';

export interface ChiffresLocaux {
  nb_payees: number;
  total_ventes: number;
  par_mode: Record<ModePaiement, number>;
}

function bornesJour(jour: string): { debut: Date; fin: Date } {
  const debut = new Date(`${jour}T00:00:00.000Z`);
  const fin = new Date(debut.getTime() + 24 * 3600 * 1000);
  return { debut, fin };
}

export function hier(): string {
  const d = new Date(Date.now() - 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Chiffres locaux d'un jour : commandes PAYEES, total, paiements par mode. */
export async function calculerChiffresLocaux(jour: string): Promise<ChiffresLocaux> {
  const { debut, fin } = bornesJour(jour);
  const lignes = await db
    .select({ total: commandes.total })
    .from(commandes)
    .where(and(eq(commandes.statut, 'PAYEE'), gte(commandes.created_at, debut), lt(commandes.created_at, fin)));

  const parModeLignes = await db
    .select({ mode: paiements.mode, total: sql<string>`SUM(${paiements.montant})` })
    .from(paiements)
    .where(and(gte(paiements.created_at, debut), lt(paiements.created_at, fin)))
    .groupBy(paiements.mode);
  const parMode = Object.fromEntries(MODES_PAIEMENT.map((m) => [m, 0])) as Record<ModePaiement, number>;
  for (const l of parModeLignes) parMode[l.mode] = Number(l.total);

  return {
    nb_payees: lignes.length,
    total_ventes: lignes.reduce((s, c) => s + c.total, 0),
    par_mode: parMode,
  };
}

/** Re-pousse (idempotent) toutes les lignes outbox écrites ce jour-là. */
export async function rePousserJour(client: ClientCloud, jour: string): Promise<number> {
  const { debut, fin } = bornesJour(jour);
  const lignes = await db
    .select()
    .from(syncOutbox)
    .where(and(gte(syncOutbox.created_at, debut), lt(syncOutbox.created_at, fin)))
    .orderBy(asc(syncOutbox.seq));

  let envoye = 0;
  for (let i = 0; i < lignes.length; i += 200) {
    const lot = lignes.slice(i, i + 200).map((l) => ({
      seq: Number(l.seq),
      table_name: l.table_name,
      record_id: l.record_id,
      operation: l.operation,
      payload: l.payload as Record<string, unknown>,
    }));
    await client.push(lot); // idempotent : rejouer ne crée aucun doublon
    envoye += lot.length;
  }
  return envoye;
}

/**
 * Réconcilie un jour. En cas d'écart : re-poussée puis re-vérification. Si
 * l'écart persiste, trace ECART_RECONCILIATION et allume le voyant rouge.
 */
export async function reconcilierJour(client: ClientCloud, jour: string): Promise<ReponseReconcile> {
  const local = await calculerChiffresLocaux(jour);
  let r = await client.reconcile(jour, local);

  if (r.statut === 'ECART') {
    await rePousserJour(client, jour);
    r = await client.reconcile(jour, local); // re-vérifie après re-poussée
  }

  etatSync.derniere_reconciliation = {
    jour,
    statut: r.statut,
    ecart: r.ecart,
    quand: new Date().toISOString(),
  };

  if (r.statut === 'ECART') {
    await db.transaction(async (tx) => {
      await journaliser(tx, {
        action: 'ECART_RECONCILIATION',
        entite: 'reconciliations',
        montant: r.ecart,
        meta: { jour, total_local: local.total_ventes, total_cloud: r.total_cloud, nb_cloud: r.nb_cloud },
      });
    });
  }

  return r;
}
