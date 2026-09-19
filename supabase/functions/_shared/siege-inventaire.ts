export type StatutDecisionInventaire = 'validee' | 'refusee';

export interface LigneExplicationBrute {
  id: string;
  explication?: string | null;
  nombre_explique?: string | number | null;
}

export interface EntreeShiftBrute {
  id: string;
  inventaire_id: string;
  produit_id: string;
  produit_nom: string | null;
  quantite: string | number | null;
  fournisseur_nom: string | null;
  source: string | null;
  created_at: string | null;
}

export interface LigneEntreeBrute {
  id: string;
  produit_id: string;
  produit_nom: string | null;
  entrees: string | number | null;
}

export interface ShiftEntreesBrut {
  id: string;
  restaurant_id: string;
  date: string;
  type_shift: string;
  caissier_id: string | null;
  pos_service_id: string | null;
  entrees_shift: EntreeShiftBrute[];
  inventaire_lignes: LigneEntreeBrute[];
}

export interface EntreeJournee {
  id: string;
  inventaire_id: string;
  restaurant_id: string;
  date: string;
  type_shift: string;
  caissier_id: string | null;
  produit_id: string;
  produit_nom: string;
  quantite: number;
  fournisseur_nom: string | null;
  source: string | null;
  created_at: string | null;
  origine: 'POS' | 'SAMERTRACKLY';
}

function nombre(valeur: unknown): number {
  const resultat = Number(valeur);
  return Number.isFinite(resultat) ? resultat : 0;
}

export function explicationUtile(ligne: Pick<LigneExplicationBrute, 'explication' | 'nombre_explique'>): boolean {
  return Boolean(ligne.explication?.trim()) || nombre(ligne.nombre_explique) > 0;
}

export function lignesExpliquees<T extends LigneExplicationBrute>(lignes: T[]): T[] {
  return lignes
    .filter(explicationUtile)
    .map((ligne) => ({
      ...ligne,
      explication: ligne.explication?.trim() || null,
    }));
}

/**
 * Réunit les réceptions détaillées et les rares entrées uniquement agrégées
 * dans `inventaire_lignes` (Darina aujourd'hui), sans compter deux fois un
 * produit qui possède déjà son détail dans `entrees_shift`.
 */
export function construireEntreesJournee(shifts: ShiftEntreesBrut[]): EntreeJournee[] {
  return shifts.flatMap((shift) => {
    const origine = shift.pos_service_id ? 'POS' as const : 'SAMERTRACKLY' as const;
    const produitsDetailles = new Set(
      shift.entrees_shift
        .filter((entree) => nombre(entree.quantite) > 0)
        .map((entree) => entree.produit_id),
    );
    const contexte = {
      restaurant_id: shift.restaurant_id,
      date: shift.date,
      type_shift: shift.type_shift,
      caissier_id: shift.caissier_id,
      origine,
    };

    const detail: EntreeJournee[] = shift.entrees_shift
      .filter((entree) => nombre(entree.quantite) > 0)
      .map((entree) => ({
        ...contexte,
        id: entree.id,
        inventaire_id: entree.inventaire_id || shift.id,
        produit_id: entree.produit_id,
        produit_nom: entree.produit_nom?.trim() || entree.produit_id,
        quantite: nombre(entree.quantite),
        fournisseur_nom: entree.fournisseur_nom?.trim() || null,
        source: entree.source,
        created_at: entree.created_at,
      }));

    const agregees: EntreeJournee[] = shift.inventaire_lignes
      .filter((ligne) => nombre(ligne.entrees) > 0 && !produitsDetailles.has(ligne.produit_id))
      .map((ligne) => ({
        ...contexte,
        id: `ligne:${shift.id}:${ligne.produit_id}`,
        inventaire_id: shift.id,
        produit_id: ligne.produit_id,
        produit_nom: ligne.produit_nom?.trim() || ligne.produit_id,
        quantite: nombre(ligne.entrees),
        fournisseur_nom: null,
        source: 'inventaire_ligne',
        created_at: null,
      }));

    return [...detail, ...agregees];
  });
}

export function construireParametresDecision(args: {
  ligneId: string;
  statut: string;
  prixSnapshot: unknown;
  auteur: string;
}): {
  p_ligne_id: string;
  p_statut: StatutDecisionInventaire;
  p_quantite_acceptee: null;
  p_prix: number;
  p_par: string;
} {
  if (args.statut !== 'validee' && args.statut !== 'refusee') {
    throw new Error('Décision invalide');
  }
  const prix = Number(args.prixSnapshot);
  if (!Number.isFinite(prix) || prix < 0) throw new Error('Prix produit invalide');
  if (!args.ligneId) throw new Error('Explication introuvable');

  return {
    p_ligne_id: args.ligneId,
    p_statut: args.statut,
    // NULL signifie « accepter la quantité expliquée complète ». SamerTrackly
    // peut toujours envoyer une valeur pour conserver son acceptation partielle.
    p_quantite_acceptee: null,
    p_prix: prix,
    p_par: args.auteur.trim() || 'Siège',
  };
}
