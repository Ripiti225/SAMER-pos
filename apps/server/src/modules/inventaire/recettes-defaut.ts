/**
 * RECETTES D'INVENTAIRE PAR DÉFAUT (migration 0022).
 *
 * Même patron que `appliquerRoutageDefaut` : un jeu de liaisons de départ,
 * appliqué au seed et après un import de catalogue, **idempotent**, et qui
 * n'écrase jamais un choix fait à la main dans Réglages › Recettes d'inventaire.
 *
 * Règle de prudence : un produit qui a DÉJÀ au moins une recette n'est plus
 * jamais touché — sinon une liaison supprimée exprès par le manager (« non, la
 * Manaïche Zaatar ne consomme pas de fromage ») reviendrait au prochain import.
 *
 * Ce que ce jeu par défaut couvre : les liaisons **lisibles dans le nom de
 * l'article** du catalogue de marque. Rien d'autre. Sont volontairement laissés
 * VIDES, faute d'une réponse dans les noms — le manager les remplit à l'écran :
 *
 *   p3  Pain fahita          aucun article « fahita » au catalogue
 *   po6 Cuisses de poulet    « Crispy » ne dit pas combien de cuisses il prend
 *   a10/a11 Brochettes       « Brochette Frites » ne dit pas poulet ou viande
 *   f3  Pizza spéciale       aucune taille « spéciale » au catalogue
 *   f6  Mini pizza           aucun article
 *   b4/b5 Boisson 1000/1500f dépend du prix réel de chaque boisson du site
 *   g4  Cornets              vendus avec la glace, sans article propre
 *
 * `quantite` = unités du produit consommées par article vendu. Elle NE remplace
 * PAS `ratio` (grammes de fromage, boules, portions par sachet), qui convertit
 * ensuite dans `calcul.ts` : pour une ligne CONSO_*, la quantité vaut donc 1 et
 * c'est le ratio qui fait le reste. Le demi-poulet est le cas où elle sert
 * vraiment : 0,5 poulet par « Demi Poulet Pané ».
 */
import { eq, inArray } from 'drizzle-orm';
import type { DbOuTx } from '../../db/client.js';
import { articles, inventaireConsommations, produitsInventaire } from '../../db/schema/index.js';

export interface RegleRecette {
  /** Code du produit d'inventaire (`produits_inventaire.code`). */
  produit: string;
  /** Testé sur le nom d'article NORMALISÉ (minuscules, sans accents). */
  motif: RegExp;
  quantite: number;
}

/** Minuscules, sans accents : les noms de la carte sont écrits à la main. */
export function normaliserNomArticle(nom: string): string {
  return nom
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

export const RECETTES_DEFAUT: RegleRecette[] = [
  // --- Pains -------------------------------------------------------------
  { produit: 'p1', motif: /^chawarma /, quantite: 1 },
  { produit: 'p2', motif: /^(burger|chicken burger)$/, quantite: 1 },

  // --- Poulet (lignes CONSO_POULET) : un demi-poulet, c'est 0,5 poulet ----
  { produit: 'po2', motif: /^poulet pane/, quantite: 1 },
  { produit: 'po2', motif: /^demi poulet pane/, quantite: 0.5 },
  { produit: 'po3', motif: /^poulet roti/, quantite: 1 },
  { produit: 'po3', motif: /^demi poulet roti/, quantite: 0.5 },
  { produit: 'po4', motif: /^poulet brais/, quantite: 1 },
  { produit: 'po4', motif: /^demi poulet brais/, quantite: 0.5 },
  { produit: 'po5', motif: /^poulet saute/, quantite: 1 },
  { produit: 'po5', motif: /^demi poulet saute/, quantite: 0.5 },

  // --- Apéritifs ---------------------------------------------------------
  { produit: 'a1', motif: /^nems/, quantite: 1 },
  { produit: 'a2', motif: /^kebbe$/, quantite: 1 },
  { produit: 'a3', motif: /^bourak$/, quantite: 1 },
  { produit: 'a4', motif: /^fatayer viande$/, quantite: 1 },
  { produit: 'a5', motif: /^fatayer legumes$/, quantite: 1 },
  { produit: 'a6', motif: /^fatayer maison$/, quantite: 1 },
  { produit: 'a7', motif: /^fatayer jambon fromage$/, quantite: 1 },
  { produit: 'a8', motif: /^mini tacos$/, quantite: 1 },
  { produit: 'a9', motif: /^francisco$/, quantite: 1 },
  { produit: 'f1', motif: /^philadelphia$/, quantite: 1 },

  // --- Plats -------------------------------------------------------------
  { produit: 'pl1', motif: /^steak /, quantite: 1 },
  { produit: 'pl2', motif: /^(escalope creme|assiette escalope)/, quantite: 1 },
  { produit: 'pl3', motif: /^chicken burger$/, quantite: 1 },
  { produit: 'pl4', motif: /^burger$/, quantite: 1 },
  { produit: 'pl5', motif: /^5 pieces crispy/, quantite: 1 },
  { produit: 'pl5', motif: /^10 pieces crispy/, quantite: 2 },

  // --- Fromage (le ratio du produit convertit en grammes) ----------------
  // La Manaïche Zaatar est la seule sans fromage : le thym, c'est du thym.
  { produit: 'f2', motif: /^manaich (?!zaatar)/, quantite: 1 },
  { produit: 'f4', motif: /^pizza .*\(m\)$/, quantite: 1 },
  { produit: 'f5', motif: /^pizza .*\(g\)$/, quantite: 1 },
  { produit: 'f7', motif: /^fatayer jambon fromage$/, quantite: 1 },
  { produit: 'f8', motif: /^(burger|chicken burger|crispy|escalope|francisco|philadelphia)$/, quantite: 1 },
  { produit: 'f8', motif: /^tacos /, quantite: 1 },
  { produit: 'f9', motif: /^mini tacos$/, quantite: 1 },

  // --- Glaces (le ratio convertit en boules, puis en pots) ---------------
  { produit: 'g1', motif: /^glace \(2 boules\)$/, quantite: 1 },
  { produit: 'g2', motif: /^(milkshake|glace speciale)$/, quantite: 1 },

  // --- Frites (le ratio convertit les portions en sachets) ---------------
  { produit: 'fr1', motif: /\+ frites$/, quantite: 1 },
  { produit: 'fr1', motif: /^(frites|steak frites|brochette frites)$/, quantite: 1 },
  { produit: 'fr2', motif: /^tacos /, quantite: 1 },

  // --- Boissons ----------------------------------------------------------
  { produit: 'b1', motif: /^nespresso$/, quantite: 1 },
  { produit: 'b2', motif: /^eau celeste \(grande\)$/, quantite: 1 },
  { produit: 'b3', motif: /^eau celeste \(petite\)$/, quantite: 1 },
  { produit: 'b6', motif: /^fresco$/, quantite: 1 },
  { produit: 'b8', motif: /^the$/, quantite: 1 },
];

/**
 * Pose les recettes par défaut. Ne touche QUE les produits qui n'en ont
 * aucune. Renvoie le nombre de liaisons créées.
 */
export async function appliquerRecettesDefaut(dbx: DbOuTx): Promise<number> {
  const [produits, cartes, existantes] = await Promise.all([
    dbx.select({ id: produitsInventaire.id, code: produitsInventaire.code }).from(produitsInventaire),
    dbx.select({ id: articles.id, nom: articles.nom }).from(articles).where(eq(articles.actif, true)),
    dbx.select({ produit_id: inventaireConsommations.produit_id }).from(inventaireConsommations),
  ]);

  const idParCode = new Map(produits.map((p) => [p.code, p.id]));
  const dejaServis = new Set(existantes.map((x) => x.produit_id));
  const nomsNormalises = cartes.map((a) => ({ id: a.id, nom: normaliserNomArticle(a.nom) }));

  const aInserer: { produit_id: string; article_id: string; quantite: string }[] = [];
  for (const regle of RECETTES_DEFAUT) {
    const produitId = idParCode.get(regle.produit);
    if (!produitId || dejaServis.has(produitId)) continue;
    for (const article of nomsNormalises) {
      if (!regle.motif.test(article.nom)) continue;
      // Une règle plus spécifique déjà appliquée l'emporte (« demi poulet »).
      if (aInserer.some((x) => x.produit_id === produitId && x.article_id === article.id)) continue;
      aInserer.push({ produit_id: produitId, article_id: article.id, quantite: String(regle.quantite) });
    }
  }

  if (aInserer.length === 0) return 0;
  await dbx.insert(inventaireConsommations).values(aInserer).onConflictDoNothing();
  return aInserer.length;
}

/** Recettes d'un lot de produits, pour l'écran de réglages. */
export async function recettesDesProduits(dbx: DbOuTx, produitIds: string[]) {
  if (produitIds.length === 0) return [];
  return dbx
    .select({
      id: inventaireConsommations.id,
      produit_id: inventaireConsommations.produit_id,
      article_id: inventaireConsommations.article_id,
      quantite: inventaireConsommations.quantite,
      article_nom: articles.nom,
    })
    .from(inventaireConsommations)
    .innerJoin(articles, eq(articles.id, inventaireConsommations.article_id))
    .where(inArray(inventaireConsommations.produit_id, produitIds));
}
