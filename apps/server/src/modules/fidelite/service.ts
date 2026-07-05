/**
 * Fidélité (§9) — programme partagé avec SAMER DELIV.
 * Règle d'or : l'id client est LE MÊME que dans SAMER DELIV (le rapprochement
 * cloud fusionne sur cet id ; le POS applique la fusion à la descente).
 * Barème descendu du siège (parametres_locaux).
 */
import { randomUUID } from 'node:crypto';
import { desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { DbOuTx } from '../../db/client.js';
import { db } from '../../db/client.js';
import { clientsFidelite, parametresLocaux, pointsFidelite, syncEtat } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier } from '../../lib/erreurs.js';

export interface Bareme {
  tranche_fcfa: number;
  points_par_tranche: number;
  valeur_point_fcfa: number;
  seuil_utilisation: number;
}

export async function lireBareme(tx: DbOuTx): Promise<Bareme> {
  const params = await tx.select().from(parametresLocaux);
  const lire = (cle: string) => params.find((p) => p.cle === cle)?.valeur;
  const tranche = lire('fidelite_points_par_tranche') as { tranche_fcfa?: number; points?: number } | undefined;
  return {
    tranche_fcfa: tranche?.tranche_fcfa ?? 1000,
    points_par_tranche: tranche?.points ?? 1,
    valeur_point_fcfa: (lire('fidelite_valeur_point_fcfa') as number) ?? 10,
    seuil_utilisation: (lire('fidelite_seuil_utilisation') as number) ?? 50,
  };
}

export type ClientDb = typeof clientsFidelite.$inferSelect;

export async function chercherParTelephone(tx: DbOuTx, telephone: string): Promise<ClientDb | null> {
  const [c] = await tx.select().from(clientsFidelite).where(eq(clientsFidelite.telephone, telephone));
  return c ?? null;
}

export async function soldePoints(tx: DbOuTx, clientId: string): Promise<number> {
  const [r] = await tx
    .select({ s: sql<string>`COALESCE(SUM(${pointsFidelite.points}),0)` })
    .from(pointsFidelite)
    .where(eq(pointsFidelite.client_id, clientId));
  return Number(r?.s ?? 0);
}

/** Trouve ou crée un client par téléphone (id local qui remontera au cloud). */
export async function trouverOuCreer(tx: DbOuTx, telephone: string): Promise<ClientDb> {
  const existant = await chercherParTelephone(tx, telephone);
  if (existant) return existant;
  const [cree] = await tx
    .insert(clientsFidelite)
    .values({ id: randomUUID(), telephone })
    .returning();
  await ecrireOutbox(tx, 'clients_fidelite', 'INSERT', cree!.id, cree as unknown as Record<string, unknown>);
  return cree!;
}

/**
 * Solde vérifiable (§ règle des 24 h) : l'utilisation de points est refusée si
 * la dernière descente cloud date de plus de 24 h, pour éviter la double
 * dépense entre canaux (POS ↔ SAMER DELIV).
 */
export async function soldeVerifiable(tx: DbOuTx): Promise<boolean> {
  const [r] = await tx
    .select({ dernier: sql<string | null>`MAX(${syncEtat.synced_at})` })
    .from(syncEtat)
    .where(isNotNull(syncEtat.synced_at));
  if (!r?.dernier) return false;
  return Date.now() - new Date(r.dernier).getTime() <= 24 * 3600 * 1000;
}

/** Points gagnés pour un montant de vente (crédit). */
export function pointsGagnes(bareme: Bareme, montant: number): number {
  return Math.floor(montant / bareme.tranche_fcfa) * bareme.points_par_tranche;
}

/** Crédite les points d'une vente payée (écrit points_fidelite + outbox). */
export async function crediterVente(tx: DbOuTx, clientId: string, commandeId: string, montant: number): Promise<number> {
  const bareme = await lireBareme(tx);
  const points = pointsGagnes(bareme, montant);
  if (points <= 0) return 0;
  const [ligne] = await tx
    .insert(pointsFidelite)
    .values({ client_id: clientId, commande_id: commandeId, points, source: 'POS' })
    .returning();
  await ecrireOutbox(tx, 'points_fidelite', 'INSERT', ligne!.id, ligne as unknown as Record<string, unknown>);
  return points;
}

/**
 * Utilise des points comme remise FIDELITE (droit du client, pas de PIN
 * manager). Écrit une ligne NÉGATIVE + trace UTILISATION_POINTS. Refuse si le
 * solde n'est pas vérifiable (24 h) ou insuffisant.
 */
export async function utiliserPoints(
  tx: DbOuTx,
  clientId: string,
  commandeId: string,
  points: number,
): Promise<{ montant: number; points: number }> {
  const bareme = await lireBareme(tx);
  if (points < bareme.seuil_utilisation) {
    throw new ErreurMetier(`Minimum ${bareme.seuil_utilisation} points pour utiliser la fidélité`, 400);
  }
  if (!(await soldeVerifiable(tx))) {
    throw new ErreurMetier('Solde non vérifiable, réessayez plus tard', 409);
  }
  const solde = await soldePoints(tx, clientId);
  if (points > solde) throw new ErreurMetier(`Solde insuffisant (${solde} points)`, 400);

  const [ligne] = await tx
    .insert(pointsFidelite)
    .values({ client_id: clientId, commande_id: commandeId, points: -points, source: 'POS' })
    .returning();
  await ecrireOutbox(tx, 'points_fidelite', 'INSERT', ligne!.id, ligne as unknown as Record<string, unknown>);
  return { montant: points * bareme.valeur_point_fcfa, points };
}

/** Dernières lignes de points d'un client (info). */
export async function historique(clientId: string) {
  return db
    .select()
    .from(pointsFidelite)
    .where(eq(pointsFidelite.client_id, clientId))
    .orderBy(desc(pointsFidelite.created_at))
    .limit(10);
}
