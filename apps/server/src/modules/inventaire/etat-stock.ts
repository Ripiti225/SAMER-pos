/**
 * Tirage du stock à l'instant T (DESIGN_V2 § 6.9).
 *
 * « Combien il me reste de pain, là, maintenant ? » — la question du gérant qui
 * passe commande à 16 h, à laquelle l'écran d'inventaire ne répond pas : il est
 * fait pour le comptage de fin de service, pas pour la lecture.
 *
 * Rien n'est validé, rien n'est figé, aucun compteur ne bouge : c'est une
 * PHOTO. Les chiffres sortent du même `etatInventaire()` que l'écran et le
 * ticket Z — un tirage qui raconterait autre chose que la clôture du soir ne
 * servirait qu'à ouvrir des discussions.
 */
import type { EtatStockInstant, EtatStockLigne } from '@pos/shared';
import type { DbOuTx } from '../../db/client.js';
import type { ServiceOuvert } from '../depenses/service.js';
import { etatInventaire } from './service.js';

export async function tirerEtatStock(
  dbx: DbOuTx,
  service: ServiceOuvert,
  generePar: string,
): Promise<EtatStockInstant> {
  const etat = await etatInventaire(dbx, service.id);

  // Seuls les produits qui SE COMPTENT sont du stock. Les lignes de
  // consommation (fromage vendu, boules de glace) sont des sorties calculées,
  // pas de la marchandise en réserve : les imprimer ferait compter deux fois.
  const lignes: EtatStockLigne[] = etat.lignes
    .filter((l) => l.a_compter)
    .map((l) => ({
      produit_id: l.produit_id,
      code: l.code,
      categorie: l.categorie,
      nom: l.nom,
      unite: l.unite,
      stock_initial: l.stock_initial,
      entrees: l.entrees,
      sorties: l.sorties,
      stock: l.stock_compte ?? l.theorique,
      compte: l.stock_compte !== null,
    }));

  return {
    genere_le: new Date().toISOString(),
    genere_par: generePar,
    service_ouvert_le: service.ouvert_le.toISOString(),
    inventaire_valide: etat.inventaire.valide,
    nb_theoriques: lignes.filter((l) => !l.compte).length,
    lignes,
  };
}
