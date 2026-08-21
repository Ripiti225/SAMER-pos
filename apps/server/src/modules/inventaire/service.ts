/**
 * Inventaire de service — accès aux données (DESIGN_V2 § 6.9).
 * Le calcul lui-même est dans `calcul.ts`.
 */
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { DbOuTx } from '../../db/client.js';
import { ecrireOutbox } from '../../db/outbox.js';
import {
  commandeItems,
  commandes,
  entreesStock,
  inventaireConsommations,
  inventaireLignes,
  inventairesService,
  produitsInventaire,
} from '../../db/schema/index.js';
import { bilan, calculerLignes, seCompte, type Bilan, type LigneCalculee, type Produit } from './calcul.js';

export type Inventaire = typeof inventairesService.$inferSelect;

/**
 * Quantités CONSOMMÉES pendant le service, par produit d'inventaire.
 *
 * Le pont est la table de recettes `inventaire_consommations` (migration 0022)
 * et non plus une colonne `article_id` : un produit est consommé par toute une
 * famille d'articles (les 6 Chawarmas mangent le même pain), et un article
 * consomme plusieurs produits à la fois. Pour chaque recette :
 *
 *     sorties += quantité vendue de l'article × quantité de la recette
 *
 * `ratio` n'intervient PAS ici : il convertit ensuite (grammes de fromage,
 * boules par pot, portions par sachet) dans `calcul.ts`, exactement comme dans
 * SamerTrackly. Un produit sans recette garde des sorties à 0 — son théorique
 * vaut initial + entrées, incomplet mais honnête. Les articles annulés et les
 * commandes non payées ne comptent pas.
 */
export async function ventesParProduit(dbx: DbOuTx, serviceId: string): Promise<Map<string, number>> {
  const lignes = await dbx
    .select({
      produit_id: inventaireConsommations.produit_id,
      quantite: sql<string>`COALESCE(SUM(${commandeItems.quantite} * ${inventaireConsommations.quantite}), 0)`,
    })
    .from(inventaireConsommations)
    .innerJoin(commandeItems, eq(commandeItems.article_id, inventaireConsommations.article_id))
    .innerJoin(commandes, eq(commandes.id, commandeItems.commande_id))
    .where(
      and(
        eq(commandes.service_id, serviceId),
        eq(commandes.statut, 'PAYEE'),
        ne(commandeItems.statut_cuisine, 'ANNULE'),
      ),
    )
    .groupBy(inventaireConsommations.produit_id);
  return new Map(lignes.map((l) => [l.produit_id, Number(l.quantite)]));
}

/** Réceptions saisies dans l'onglet « Entrées reçues », par produit. */
export async function entreesParProduit(dbx: DbOuTx, inventaireId: string): Promise<Map<string, number>> {
  const lignes = await dbx
    .select({
      produit_id: entreesStock.produit_id,
      quantite: sql<string>`SUM(${entreesStock.quantite})`,
    })
    .from(entreesStock)
    .where(eq(entreesStock.inventaire_id, inventaireId))
    .groupBy(entreesStock.produit_id);
  return new Map(lignes.map((l) => [l.produit_id, Number(l.quantite)]));
}

/**
 * L'inventaire du service, créé à la volée au premier accès avec une ligne par
 * produit à compter. Le stock initial est le stock final du DERNIER inventaire
 * validé — repris, jamais modifiable : c'est la continuité d'un service à
 * l'autre, et la retaper à la main serait la première source d'écart.
 */
export async function assurerInventaire(dbx: DbOuTx, serviceId: string): Promise<Inventaire> {
  const [existant] = await dbx
    .select()
    .from(inventairesService)
    .where(eq(inventairesService.service_id, serviceId));
  if (existant) return existant;

  const [cree] = await dbx.insert(inventairesService).values({ service_id: serviceId }).returning();
  await ecrireOutbox(dbx, 'inventaires_service', 'INSERT', cree!.id, cree as unknown as Record<string, unknown>);

  const [precedent] = await dbx
    .select()
    .from(inventairesService)
    .where(and(eq(inventairesService.valide, true), ne(inventairesService.service_id, serviceId)))
    .orderBy(desc(inventairesService.valide_le))
    .limit(1);

  const finales = precedent
    ? await dbx
        .select({ produit_id: inventaireLignes.produit_id, stock: inventaireLignes.stock_compte })
        .from(inventaireLignes)
        .where(eq(inventaireLignes.inventaire_id, precedent.id))
    : [];
  const report = new Map(finales.map((f) => [f.produit_id, f.stock ?? '0']));

  const produits = await dbx.select().from(produitsInventaire).where(eq(produitsInventaire.actif, true));
  const aCompter = produits.filter(seCompte);
  if (aCompter.length > 0) {
    // `returning()` pour publier les lignes : le siège doit voir le comptage
    // produit par produit, pas seulement le résumé du ticket Z.
    const creees = await dbx
      .insert(inventaireLignes)
      .values(
        aCompter.map((p) => ({
          inventaire_id: cree!.id,
          produit_id: p.id,
          stock_initial: report.get(p.id) ?? '0',
        })),
      )
      .returning();
    for (const l of creees) {
      await ecrireOutbox(dbx, 'inventaire_lignes', 'INSERT', l.id, l as unknown as Record<string, unknown>);
    }
  }
  return cree!;
}

export interface EtatInventaire {
  inventaire: Inventaire;
  lignes: LigneCalculee[];
  bilan: Bilan;
  /** Clôture autorisée : inventaire validé, ou débloqué par un manager. */
  cloture_autorisee: boolean;
}

/** État complet de l'inventaire d'un service (lignes calculées + bilan). */
export async function etatInventaire(dbx: DbOuTx, serviceId: string): Promise<EtatInventaire> {
  const inventaire = await assurerInventaire(dbx, serviceId);
  const produits: Produit[] = await dbx
    .select()
    .from(produitsInventaire)
    .where(eq(produitsInventaire.actif, true));
  const lignesDb = await dbx
    .select()
    .from(inventaireLignes)
    .where(eq(inventaireLignes.inventaire_id, inventaire.id));

  const lignes = calculerLignes(
    produits,
    lignesDb,
    await entreesParProduit(dbx, inventaire.id),
    await ventesParProduit(dbx, serviceId),
  );

  return {
    inventaire,
    lignes,
    bilan: bilan(lignes),
    cloture_autorisee: inventaire.valide || inventaire.debloque_par !== null,
  };
}
