/** Premier envoi du catalogue d'inventaire local vers le siège.
 *
 * La descente cloud est ensuite maîtresse. On n'écrit donc QUE les lignes
 * absentes : une correction faite au siège ne doit jamais être écrasée par
 * une ancienne copie locale. L'envoi est rejouable après une coupure réseau.
 */
import { db } from '../../db/client.js';
import { inventaireConsommations, produitsInventaire, restaurant } from '../../db/schema/index.js';
import { ErreurMetier } from '../../lib/erreurs.js';
import { chargerConfigSync } from '../sync/config.js';
import { ClientCloud, ErreurSync, type LigneDescente } from '../sync/cloud-client.js';

type ProduitLocal = typeof produitsInventaire.$inferSelect;
type RecetteLocale = typeof inventaireConsommations.$inferSelect;

export function preparerPublicationInventaire(
  produits: ProduitLocal[],
  recettes: RecetteLocale[],
  lignesCloud: LigneDescente[],
): { produits: ProduitLocal[]; recettes: RecetteLocale[] } {
  const auSiege = lignesCloud.filter((l) => l.table_name === 'produits_inventaire').map((l) => l.row);
  const recettesSiege = lignesCloud.filter((l) => l.table_name === 'inventaire_consommations').map((l) => l.row);
  const articlesSiege = lignesCloud.filter((l) => l.table_name === 'articles').map((l) => l.row);
  // sync-pull plafonne chaque table à 2 000 lignes. Une liste tronquée ne
  // permettrait pas de distinguer une ligne absente d'une ligne non reçue.
  if ([auSiege, recettesSiege, articlesSiege].some((lignes) => lignes.length >= 2000)) {
    throw new ErreurMetier('Le catalogue cloud est trop volumineux pour vérifier ce transfert. Contactez le support avant de le lancer.', 409);
  }
  const parCode = new Map(auSiege.map((p) => [String(p.code), String(p.id)]));
  const parId = new Map(auSiege.map((p) => [String(p.id), String(p.code)]));
  const parNom = new Map(auSiege.map((p) => [
    `${String(p.categorie)}:${String(p.nom).trim().toLocaleLowerCase('fr')}`, String(p.id),
  ]));

  for (const p of produits) {
    if (parCode.has(p.code) && parCode.get(p.code) !== p.id) {
      throw new ErreurMetier(`Le produit « ${p.nom} » existe déjà au siège avec un autre identifiant. Vérifiez ce doublon avant le transfert.`, 409);
    }
    if (parId.has(p.id) && parId.get(p.id) !== p.code) {
      throw new ErreurMetier(`L’identifiant du produit « ${p.nom} » est déjà utilisé au siège pour un autre code.`, 409);
    }
    const nomCle = `${p.categorie}:${p.nom.trim().toLocaleLowerCase('fr')}`;
    if (parNom.has(nomCle) && parNom.get(nomCle) !== p.id) {
      throw new ErreurMetier(`Un produit nommé « ${p.nom} » existe déjà au siège dans cette catégorie. Vérifiez ce doublon avant le transfert.`, 409);
    }
  }

  const parCouple = new Map(recettesSiege.map((r) => [`${r.produit_id}:${r.article_id}`, String(r.id)]));
  const recetteParId = new Map(recettesSiege.map((r) => [String(r.id), `${r.produit_id}:${r.article_id}`]));
  for (const r of recettes) {
    const couple = `${r.produit_id}:${r.article_id}`;
    if (parCouple.has(couple) && parCouple.get(couple) !== r.id) {
      throw new ErreurMetier('Une recette existe déjà au siège avec un autre identifiant. Vérifiez cette liaison avant le transfert.', 409);
    }
    if (recetteParId.has(r.id) && recetteParId.get(r.id) !== couple) {
      throw new ErreurMetier('L’identifiant d’une recette est déjà utilisé au siège pour une autre liaison.', 409);
    }
  }

  const recettesManquantes = recettes.filter((r) => !recetteParId.has(r.id));
  const articlesPresents = new Set(articlesSiege.map((a) => String(a.id)));
  if (recettesManquantes.some((r) => !articlesPresents.has(r.article_id))) {
    throw new ErreurMetier('Des articles des recettes ne sont pas encore au cloud. Attendez la synchronisation du catalogue de vente, puis réessayez.', 409);
  }
  return { produits: produits.filter((p) => !parId.has(p.id)), recettes: recettesManquantes };
}

async function envoyerParLots<T>(lignes: T[], envoyer: (ligne: T) => Promise<unknown>): Promise<number> {
  let envoyees = 0;
  for (let debut = 0; debut < lignes.length; debut += 8) {
    const lot = lignes.slice(debut, debut + 8);
    const resultats = await Promise.allSettled(lot.map(envoyer));
    envoyees += resultats.filter((r) => r.status === 'fulfilled').length;
    const erreur = resultats.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (erreur) throw erreur.reason;
  }
  return envoyees;
}

export async function publierInventaireHistorique(): Promise<{ produits: number; recettes: number }> {
  const cfg = await chargerConfigSync();
  if (!cfg.actif || !cfg.url || !cfg.cleSite) {
    throw new ErreurMetier('Ce POS n’est pas connecté au cloud. Vérifiez son enrôlement et sa synchronisation.', 503);
  }
  const [site] = await db.select({ marque: restaurant.marque, code: restaurant.code }).from(restaurant).limit(1);
  if (site?.marque === 'A_LA_BRAISE' || site?.code === 'ALA_BRAISE') {
    throw new ErreurMetier('Le transfert de produits À la Braise nécessite une validation particulière.', 403);
  }

  const [produits, recettes] = await Promise.all([
    db.select().from(produitsInventaire),
    db.select().from(inventaireConsommations),
  ]);
  const client = new ClientCloud(cfg.url, cfg.cleSite);
  try {
    const reponse = await client.pull({ catalogue: 0 });
    if (!reponse.catalogue) throw new ErreurMetier('Le catalogue du siège n’a pas pu être vérifié.', 503);
    const aEnvoyer = preparerPublicationInventaire(produits, recettes, reponse.catalogue.lignes);
    const nbProduits = await envoyerParLots(aEnvoyer.produits, (p) => client.adminCatalogue('upsert', 'produit_inventaire', {
      id: p.id, code: p.code, categorie: p.categorie, nom: p.nom, prix: p.prix,
      unite: p.unite, role: p.role, ratio: p.ratio === null ? null : Number(p.ratio),
      ordre: p.ordre, actif: p.actif,
    }));
    const nbRecettes = await envoyerParLots(aEnvoyer.recettes, (r) => client.adminCatalogue('upsert', 'recette_inventaire', {
      id: r.id, produit_id: r.produit_id, article_id: r.article_id, quantite: Number(r.quantite),
    }));
    return { produits: nbProduits, recettes: nbRecettes };
  } catch (e) {
    if (e instanceof ErreurSync) {
      throw new ErreurMetier(`Transfert interrompu : ${e.message}. Réessayez ; les lignes déjà envoyées ne seront pas écrasées.`, e.estReseau ? 503 : 502);
    }
    throw e;
  }
}
