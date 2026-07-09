/**
 * SPRINT 4C — Disponibilité LOCALE (2.3). Source de vérité pour « épuisé »,
 * indépendante des articles pour survivre à une descente de catalogue.
 */
import { eq } from 'drizzle-orm';
import type { DbOuTx } from '../../db/client.js';
import { disponibiliteLocale } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';

/**
 * Garantit une ligne de disponibilité (TRUE par défaut) pour chaque article
 * fourni, SANS toucher aux lignes existantes. À appeler par toute descente de
 * catalogue pour les nouveaux articles.
 */
export async function assurerDisponibilite(dbx: DbOuTx, articleIds: string[]): Promise<void> {
  if (articleIds.length === 0) return;
  await dbx
    .insert(disponibiliteLocale)
    .values(articleIds.map((article_id) => ({ article_id })))
    .onConflictDoNothing();
}

/** Map article_id → disponible (true si aucune ligne). */
export async function lireDisponibilites(dbx: DbOuTx): Promise<Map<string, boolean>> {
  const lignes = await dbx.select().from(disponibiliteLocale);
  return new Map(lignes.map((l) => [l.article_id, l.disponible]));
}

/** Pose la disponibilité d'un article (upsert) + outbox. Dans la transaction. */
export async function poserDisponibilite(tx: DbOuTx, articleId: string, disponible: boolean): Promise<void> {
  await tx
    .insert(disponibiliteLocale)
    .values({ article_id: articleId, disponible, updated_at: new Date() })
    .onConflictDoUpdate({
      target: disponibiliteLocale.article_id,
      set: { disponible, updated_at: new Date() },
    });
  await ecrireOutbox(tx, 'disponibilite_locale', 'UPDATE', articleId, { article_id: articleId, disponible });
}

/** Disponibilité d'un article donné (true par défaut). */
export async function articleDisponible(dbx: DbOuTx, articleId: string): Promise<boolean> {
  const [l] = await dbx.select().from(disponibiliteLocale).where(eq(disponibiliteLocale.article_id, articleId));
  return l?.disponible ?? true;
}
