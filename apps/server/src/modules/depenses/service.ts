/**
 * Registre des dépenses du service (DESIGN_V2 § 6.8).
 *
 * `services_caisse.depenses` n'est plus une saisie : c'est la SOMME de ce
 * registre, calculée par le serveur à la clôture. La caissière ne retape rien,
 * et un total tapé à la main ne peut plus diverger des lignes qui le composent.
 */
import { eq, sql } from 'drizzle-orm';
import type { DbOuTx } from '../../db/client.js';
import { depenses, servicesCaisse } from '../../db/schema/index.js';
import { ErreurMetier } from '../../lib/erreurs.js';

/**
 * Catégories saisies librement au registre. SALAIRES et ENCOURAGEMENTS n'en
 * font PAS partie : elles naissent d'un paiement réel (routes dédiées, ligne
 * `auto` non supprimable) — les ouvrir ici permettrait de fabriquer un salaire
 * sans payer personne, et de l'effacer ensuite.
 */
export const CATEGORIES_LIBRES = ['MARCHE', 'LEGUMES', 'FRUITS', 'ANNEXES'] as const;
export type CategorieLibre = (typeof CATEGORIES_LIBRES)[number];

export type ServiceOuvert = typeof servicesCaisse.$inferSelect;

/**
 * Le service ouvert du poste. Il n'y en a qu'un à la fois (invariant « shift
 * unique »), et il n'appartient pas au seul caissier connecté : un manager peut
 * enregistrer une dépense ou débloquer un inventaire pendant que la caissière
 * tient le tiroir. On résout donc le shift du POSTE, pas celui de la session.
 */
export async function serviceOuvertCourant(dbx: DbOuTx): Promise<ServiceOuvert> {
  const [service] = await dbx
    .select()
    .from(servicesCaisse)
    .where(eq(servicesCaisse.statut, 'OUVERT'));
  if (!service) throw new ErreurMetier('Aucun service ouvert', 409);
  return service;
}

/** Somme des dépenses d'un service (0 si aucune ligne). */
export async function totalDepenses(dbx: DbOuTx, serviceId: string): Promise<number> {
  const [ligne] = await dbx
    .select({ total: sql<string>`COALESCE(SUM(${depenses.montant}), 0)` })
    .from(depenses)
    .where(eq(depenses.service_id, serviceId));
  return Number(ligne?.total ?? 0);
}

/** Répartition par catégorie, pour le panneau droit de l'écran Dépenses. */
export async function repartitionDepenses(
  dbx: DbOuTx,
  serviceId: string,
): Promise<Record<string, number>> {
  const lignes = await dbx
    .select({ categorie: depenses.categorie, total: sql<string>`SUM(${depenses.montant})` })
    .from(depenses)
    .where(eq(depenses.service_id, serviceId))
    .groupBy(depenses.categorie);
  const par: Record<string, number> = {};
  for (const l of lignes) par[l.categorie] = Number(l.total);
  return par;
}
