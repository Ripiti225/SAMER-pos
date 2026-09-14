export type StatutDecisionInventaire = 'validee' | 'refusee';

export interface LigneExplicationBrute {
  id: string;
  explication?: string | null;
  nombre_explique?: string | number | null;
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

export function construireParametresDecision(args: {
  ligneId: string;
  statut: string;
  prixSnapshot: unknown;
  auteur: string;
}): { p_ligne_id: string; p_statut: StatutDecisionInventaire; p_prix: number; p_par: string } {
  if (args.statut !== 'validee' && args.statut !== 'refusee') {
    throw new Error('Décision invalide');
  }
  const prix = Number(args.prixSnapshot);
  if (!Number.isFinite(prix) || prix < 0) throw new Error('Prix produit invalide');
  if (!args.ligneId) throw new Error('Explication introuvable');

  return {
    p_ligne_id: args.ligneId,
    p_statut: args.statut,
    p_prix: prix,
    p_par: args.auteur.trim() || 'Siège',
  };
}
