/** Configuration de la synchro : env prioritaire, sinon parametres_locaux. */
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { parametresLocaux } from '../../db/schema/index.js';

export interface ConfigSync {
  url: string | null;
  cleSite: string | null;
  intervalleMonteeMs: number;
  intervalleDescenteMs: number;
  actif: boolean;
}

async function param(cle: string): Promise<string | null> {
  const [p] = await db.select().from(parametresLocaux).where(eq(parametresLocaux.cle, cle));
  return typeof p?.valeur === 'string' ? p.valeur : null;
}

export async function chargerConfigSync(): Promise<ConfigSync> {
  const url = process.env.SUPABASE_SYNC_URL || (await param('supabase_sync_url'));
  const cleSite = process.env.CLE_SITE || (await param('cle_site'));
  const actif = process.env.SYNC_ACTIF !== '0' && !!url && !!cleSite;
  return {
    url: url ?? null,
    cleSite: cleSite ?? null,
    intervalleMonteeMs: Number(process.env.SYNC_INTERVALLE_MONTEE ?? 30) * 1000,
    intervalleDescenteMs: Number(process.env.SYNC_INTERVALLE_DESCENTE ?? 300) * 1000,
    actif,
  };
}

/** Backoff progressif de la montée : 30 s → 1 min → 5 min (plafonné). */
export const PALIERS_BACKOFF_MS = [30_000, 60_000, 300_000] as const;
export function prochainBackoff(echecs: number): number {
  return PALIERS_BACKOFF_MS[Math.min(echecs, PALIERS_BACKOFF_MS.length) - 1] ?? 300_000;
}
