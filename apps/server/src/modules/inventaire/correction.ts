/**
 * Correction du stock initial — d'où vient le chiffre, et ce qu'on en montre.
 * La route est dans `routes-correction.ts`, la formule dans `@pos/shared`.
 */
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import { DELAI_CORRECTION_STOCK_MS, type LigneSortantCorrection } from '@pos/shared';
import type { DbOuTx } from '../../db/client.js';
import {
  correctionsStockInitial,
  inventaireLignes,
  inventairesService,
  servicesCaisse,
  utilisateurs,
} from '../../db/schema/index.js';

export interface SourceCorrection {
  service_sortant_id: string | null;
  caissier_sortant_id: string | null;
  caissier_sortant_nom: string | null;
  intermediaire: boolean;
  ligne: LigneSortantCorrection | null;
}

const SANS_SOURCE: SourceCorrection = {
  service_sortant_id: null,
  caissier_sortant_id: null,
  caissier_sortant_nom: null,
  intermediaire: false,
  ligne: null,
};

/** Le stock initial vient du dernier inventaire validé d'un autre service. */
export async function sourceDuStock(dbx: DbOuTx, serviceId: string, produitId: string): Promise<SourceCorrection> {
  const [precedent] = await dbx
    .select()
    .from(inventairesService)
    .where(and(eq(inventairesService.valide, true), ne(inventairesService.service_id, serviceId)))
    .orderBy(desc(inventairesService.valide_le))
    .limit(1);
  if (!precedent) return SANS_SOURCE;

  const [ligne] = await dbx
    .select()
    .from(inventaireLignes)
    .where(and(eq(inventaireLignes.inventaire_id, precedent.id), eq(inventaireLignes.produit_id, produitId)));
  if (!ligne || ligne.stock_compte === null) return SANS_SOURCE;

  const [sortant] = await dbx
    .select({ caissier_id: servicesCaisse.caissier_id, nom: utilisateurs.nom_complet })
    .from(servicesCaisse)
    .leftJoin(utilisateurs, eq(utilisateurs.id, servicesCaisse.caissier_id))
    .where(eq(servicesCaisse.id, precedent.service_id));
  const [dernier] = await dbx
    .select({ id: servicesCaisse.id })
    .from(servicesCaisse)
    .where(eq(servicesCaisse.statut, 'CLOTURE'))
    .orderBy(desc(servicesCaisse.cloture_le))
    .limit(1);

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
export async function stockReporte(
  dbx: DbOuTx,
  inventaireId: string,
  produitId: string,
  stockActuel: number,
): Promise<number> {
  const [premiere] = await dbx
    .select({ stock: correctionsStockInitial.stock_reporte })
    .from(correctionsStockInitial)
    .where(and(eq(correctionsStockInitial.inventaire_id, inventaireId), eq(correctionsStockInitial.produit_id, produitId)))
    .orderBy(asc(correctionsStockInitial.created_at))
    .limit(1);
  return premiere ? Number(premiere.stock) : stockActuel;
}

/** L'heure part de l'ouverture du shift : se reconnecter ne la relance pas. */
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
  }));
}
