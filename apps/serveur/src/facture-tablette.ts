import { formatFCFA } from '@pos/shared';

interface ItemFacture {
  id: string;
  nom_snapshot: string;
  prix_unitaire: number;
  quantite: number;
  total_ligne: number;
  statut_cuisine: string;
  supplements: { nom: string; prix: number }[];
  options: { groupe: string; choix: string[] }[];
}

export function lignesFactureNumerique(commande: { items: ItemFacture[] }) {
  return commande.items
    .filter((item) => item.statut_cuisine !== 'ANNULE')
    .map((item) => ({
      id: item.id,
      nom: item.nom_snapshot,
      quantite: item.quantite,
      prix_unitaire: item.prix_unitaire,
      // Montant calculé par l'API : la tablette ne recalcule jamais une vente.
      total: item.total_ligne,
      supplements: item.supplements.map((s) => `${s.nom} (+${formatFCFA(s.prix)})`),
      options: item.options.filter((o) => o.choix.length > 0).map((o) => `${o.groupe} : ${o.choix.join(', ')}`),
    }));
}
