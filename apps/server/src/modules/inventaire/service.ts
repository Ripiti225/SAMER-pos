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
  if (existant) {
    if (!existant.valide) {
      // Un produit créé au siège peut descendre après l'ouverture de
      // l'inventaire. Lui donner une vraie ligne de comptage avant validation.
      const [produits, lignes] = await Promise.all([
        dbx.select().from(produitsInventaire).where(eq(produitsInventaire.actif, true)),
        dbx.select({ produit_id: inventaireLignes.produit_id }).from(inventaireLignes)
          .where(eq(inventaireLignes.inventaire_id, existant.id)),
      ]);
      const dejaPresents = new Set(lignes.map((l) => l.produit_id));
      const nouveaux = produits.filter((p) => seCompte(p) && !dejaPresents.has(p.id));
      if (nouveaux.length > 0) {
        const [precedent] = await dbx.select().from(inventairesService)
          .where(and(eq(inventairesService.valide, true), ne(inventairesService.service_id, serviceId)))
          .orderBy(desc(inventairesService.valide_le)).limit(1);
        const finales = precedent ? await dbx.select({ produit_id: inventaireLignes.produit_id, stock: inventaireLignes.stock_compte })
          .from(inventaireLignes).where(eq(inventaireLignes.inventaire_id, precedent.id)) : [];
        const report = new Map(finales.map((f) => [f.produit_id, f.stock ?? '0']));
        const creees = await dbx.insert(inventaireLignes).values(nouveaux.map((p) => ({
          inventaire_id: existant.id,
          produit_id: p.id,
          stock_initial: report.get(p.id) ?? '0',
        }))).onConflictDoNothing().returning();
        for (const ligne of creees) {
          await ecrireOutbox(dbx, 'inventaire_lignes', 'INSERT', ligne.id, ligne as unknown as Record<string, unknown>);
        }
      }
    }
    return existant;
  }

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

/**
 * Stock final (compté) du DERNIER inventaire validé d'un autre service que
 * `serviceIdExclu` : c'est le stock initial que reprendra le service suivant.
 */
export async function stocksReportes(dbx: DbOuTx, serviceIdExclu: string | null): Promise<Map<string, string>> {
  const [precedent] = await dbx
    .select()
    .from(inventairesService)
    .where(
      serviceIdExclu
        ? and(eq(inventairesService.valide, true), ne(inventairesService.service_id, serviceIdExclu))
        : eq(inventairesService.valide, true),
    )
    .orderBy(desc(inventairesService.valide_le))
    .limit(1);
  if (!precedent) return new Map();
  const finales = await dbx
    .select({ produit_id: inventaireLignes.produit_id, stock: inventaireLignes.stock_compte })
    .from(inventaireLignes)
    .where(eq(inventaireLignes.inventaire_id, precedent.id));
  return new Map(finales.map((f) => [f.produit_id, f.stock ?? '0']));
}

/**
 * Le même calcul que `etatInventaire()`, en LECTURE SEULE : rien n'est créé.
 *
 * Sert au stock affiché sous les plats, interrogé par chaque caisse et chaque
 * tablette plusieurs fois par minute — il ne doit ni ouvrir l'inventaire du
 * service ni écrire en base (même règle que la pastille `/api/inventaire/etat`).
 * Les produits sans ligne reçoivent le stock initial qu'`assurerInventaire()`
 * leur donnerait : le chiffre est donc celui que l'écran d'inventaire
 * afficherait au même instant.
 *
 * `serviceId` null (aucun shift ouvert, entre deux relèves) : ni ventes ni
 * entrées, le résultat est le stock compté du dernier inventaire validé —
 * exactement ce que le prochain shift reprendra.
 */
export async function lignesInventaireSansCreer(dbx: DbOuTx, serviceId: string | null): Promise<LigneCalculee[]> {
  const produits: Produit[] = await dbx.select().from(produitsInventaire).where(eq(produitsInventaire.actif, true));
  const [inventaire] = serviceId
    ? await dbx.select().from(inventairesService).where(eq(inventairesService.service_id, serviceId))
    : [];
  const lignesDb = inventaire
    ? await dbx.select().from(inventaireLignes).where(eq(inventaireLignes.inventaire_id, inventaire.id))
    : [];

  const presents = new Set(lignesDb.map((l) => l.produit_id));
  const manquants = produits.filter((p) => seCompte(p) && !presents.has(p.id));
  if (manquants.length > 0) {
    const report = await stocksReportes(dbx, serviceId);
    for (const p of manquants) {
      lignesDb.push({
        id: '',
        inventaire_id: inventaire?.id ?? '',
        produit_id: p.id,
        stock_initial: report.get(p.id) ?? '0',
        entrees: '0',
        sorties: '0',
        stock_compte: null,
        ecart: null,
        produit_code: p.code,
        produit_nom: p.nom,
        produit_prix: p.prix,
        quantite_expliquee: '0',
        explication: null,
      });
    }
  }

  return calculerLignes(
    produits,
    lignesDb,
    inventaire ? await entreesParProduit(dbx, inventaire.id) : new Map(),
    serviceId ? await ventesParProduit(dbx, serviceId) : new Map(),
  );
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

  // Une validation fige la liste comptée. Un produit reçu du siège plus tard
  // n'apparaît pas rétroactivement comme « non compté » dans ce service.
  const produitsDuService = inventaire.valide
    ? produits.filter((p) => !seCompte(p) || lignesDb.some((l) => l.produit_id === p.id))
    : produits;

  const lignes = calculerLignes(
    produitsDuService,
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
