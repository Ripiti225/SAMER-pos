/**
 * Stock en cuisine sous la photo de chaque plat (2026-10-22).
 *
 * « Il me reste de quoi faire combien de pizzas ? » — la question que le
 * caissier et le serveur se posent au moment de prendre la commande, et à
 * laquelle l'inventaire ne répond qu'en fin de service. On l'affiche donc sous
 * la photo : « Fromage 2,4 kg · ≈ 12 », « Poulet 18 · ≈ 9 », « Reste 18 ».
 *
 * Trois règles tenues ici :
 *
 *  1. Le chiffre sort du MÊME calcul que l'écran d'inventaire et le ticket Z
 *     (`lignesInventaireSansCreer` → `calculerLignes`). Une vignette qui dirait
 *     autre chose que la clôture du soir ouvrirait des discussions sans fin.
 *  2. Le produit qui sert de référence à un plat est DÉDUIT de ses recettes
 *     d'inventaire, dans l'ordre décidé par le propriétaire : produit fini,
 *     fromage, poulet, ingrédient principal, sinon rien. Une exception posée à
 *     la main (Réglages › Stock en cuisine) l'emporte toujours.
 *  3. Le stock est THÉORIQUE : une livraison pas encore saisie suffit à le
 *     tromper. Il INFORME la caisse et la tablette, il ne bloque jamais leur
 *     vente. Seule la page client (QR) refuse un plat épuisé — un client ne
 *     peut pas savoir que la cuisine en a encore.
 */
import type { EtatStockPlat, RaisonReferenceStock, StockPlat, StockPlatsVue } from '@pos/shared';
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { DbOuTx } from '../../db/client.js';
import {
  articles,
  categories,
  commandeItems,
  commandes,
  inventaireConsommations,
  parametresLocaux,
  produitsInventaire,
  servicesCaisse,
  stockPlatsReference,
} from '../../db/schema/index.js';
import { arrondi, seCompte, sortiesPourVentes, type Produit } from './calcul.js';
import { normaliserNomArticle } from './recettes-defaut.js';
import { lignesInventaireSansCreer, stocksReportes } from './service.js';

/** Clé `parametres_locaux` du seuil orange « bientôt épuisé », en plats. */
export const CLE_SEUIL_STOCK_PLATS = 'stock_plats_seuil_bientot_epuise';
export const SEUIL_STOCK_PLATS_DEFAUT = 5;

/**
 * Ventes fictives utilisées pour mesurer la consommation d'UN plat. Les
 * formules de `calcul.ts` arrondissent au centième (sachets, pots) : 1 portion
 * de frites sur 8 par sachet y deviendrait 0,13 au lieu de 0,125, et faussait
 * le nombre de plats possibles de plusieurs unités. On mesure donc 1 000 plats
 * et on divise.
 */
const ECHELLE = 1000;

export type RaisonReference = RaisonReferenceStock;

export interface LigneRecette {
  article_id: string;
  produit_id: string;
  quantite: number;
}

export interface Reference {
  produit: Produit;
  raison: RaisonReference;
}

/** Choix posé à la main pour un plat ; absent = automatique. */
export type Surcharge = { mode: 'PRODUIT'; produit_id: string } | { mode: 'AUCUN' };

/** Catégories dont un produit compté EST ce qu'on vend (une boisson, des nems). */
const CATEGORIES_PRODUIT_FINI = new Set(['BOIS', 'APER']);

/** Le total dérivé qui porte le stock d'une ligne de consommation. */
const TOTAL_DE: Record<string, string> = {
  CONSO_POULET: 'TOTAL_POULET',
  CONSO_FROMAGE: 'TOTAL_FROMAGE',
  CONSO_GLACE: 'TOTAL_GLACE',
  CONSO_FRITES: 'TOTAL_FRITES',
};

/**
 * Le produit qui porte le STOCK d'une ligne de recette. Une consommation
 * (« Pizza moyenne (160g) ») ne se compte pas : son stock est celui du total
 * de sa catégorie (« Total Fromage »). `ENTREE` (poulet frais reçu) et `CONSO`
 * simple n'ont pas de stock propre : null.
 */
export function produitDeStock(ligne: Produit, produits: Produit[]): Produit | null {
  const total = TOTAL_DE[ligne.role];
  if (total) return produits.find((p) => p.role === total && p.categorie === ligne.categorie) ?? null;
  return seCompte(ligne) && ligne.role !== 'ENTREE' ? ligne : null;
}

/**
 * « Nems » est le produit fini de « Nems (10 pièces) » : même nom, au plus
 * suivi d'une précision entre parenthèses. Pas un simple début de nom : le
 * « Steak » d'un « Steak Frites » est un ingrédient, pas le plat.
 */
function memeNom(article: string, produit: string): boolean {
  const a = normaliserNomArticle(article);
  const p = normaliserNomArticle(produit);
  return p.length >= 3 && (a === p || a.startsWith(`${p} (`));
}

/**
 * Déduction automatique du produit de référence d'un plat, dans l'ordre fixé
 * par le propriétaire :
 *
 *  1. produit fini — l'article est lui-même un produit compté (boisson,
 *     apéritif préparé d'avance, ou même nom) : son propre stock ;
 *  2. recette avec du fromage → « Total Fromage » ;
 *  3. recette avec du poulet → « Total poulet » (compté en poulets entiers) ;
 *  4. sinon l'ingrédient principal : un produit compté tel quel (le steak d'un
 *     Steak Frites) passe avant un total dérivé (les frites, la glace), puis
 *     l'ordre du catalogue de comptage ;
 *  5. aucune recette exploitable → null, rien d'affiché.
 */
export function deduireReference(articleNom: string, recette: LigneRecette[], produits: Produit[]): Reference | null {
  const parId = new Map(produits.map((p) => [p.id, p]));
  const lignes = recette
    .map((r) => ({ r, p: parId.get(r.produit_id) }))
    .filter((x): x is { r: LigneRecette; p: Produit } => x.p !== undefined);

  const fini = lignes.find(
    ({ r, p }) =>
      p.role === 'COMPTE' && r.quantite === 1 && (CATEGORIES_PRODUIT_FINI.has(p.categorie) || memeNom(articleNom, p.nom)),
  );
  if (fini) return { produit: fini.p, raison: 'PRODUIT_FINI' };

  const total = (roles: string[], raison: RaisonReference): Reference | null => {
    const ligne = lignes.find(({ p }) => roles.includes(p.role));
    const stock = ligne ? produitDeStock(ligne.p, produits) : null;
    return stock ? { produit: stock, raison } : null;
  };
  const fromage = total(['CONSO_FROMAGE', 'TOTAL_FROMAGE'], 'FROMAGE');
  if (fromage) return fromage;
  const poulet = total(['CONSO_POULET', 'TOTAL_POULET'], 'POULET');
  if (poulet) return poulet;

  const candidats = lignes
    .map(({ p }) => produitDeStock(p, produits))
    .filter((p): p is Produit => p !== null)
    .sort(
      (a, b) =>
        Number(a.role.startsWith('TOTAL')) - Number(b.role.startsWith('TOTAL'))
        || a.categorie.localeCompare(b.categorie)
        || a.ordre - b.ordre,
    );
  return candidats[0] ? { produit: candidats[0], raison: 'INGREDIENT' } : null;
}

/** La surcharge manuelle l'emporte ; `AUCUN` éteint l'affichage du plat. */
export function referenceDuPlat(
  articleNom: string,
  recette: LigneRecette[],
  produits: Produit[],
  surcharge: Surcharge | undefined,
): Reference | null {
  if (surcharge?.mode === 'AUCUN') return null;
  if (surcharge?.mode === 'PRODUIT') {
    const produit = produits.find((p) => p.id === surcharge.produit_id);
    // Produit désactivé depuis : on retombe sur la déduction plutôt que sur
    // une vignette muette que personne ne saurait expliquer.
    if (produit) return { produit, raison: 'MANUEL' };
  }
  return deduireReference(articleNom, recette, produits);
}

/**
 * Ce qu'UN plat retire du stock de référence, dans l'unité de ce stock
 * (poulets, grammes, sachets, pots) — recette × ratio, par les formules de
 * l'inventaire. 0 quand la recette ne touche pas ce produit (référence posée à
 * la main sur un produit sans lien) : on affiche alors le stock seul.
 */
export function consommationParPlat(recette: LigneRecette[], produits: Produit[], reference: Produit): number {
  const ventes = new Map<string, number>();
  for (const r of recette) ventes.set(r.produit_id, (ventes.get(r.produit_id) ?? 0) + r.quantite * ECHELLE);
  return (sortiesPourVentes(produits, ventes).get(reference.id) ?? 0) / ECHELLE;
}

const fr = (n: number, decimales = 2) => n.toLocaleString('fr-FR', { maximumFractionDigits: decimales });

/**
 * Quantité lisible dans l'unité du produit : 2 400 g → « 2,4 kg », 850 g →
 * « 850 g », 3,5 sachets, 18 (unités sans suffixe : « Poulet 18 »).
 */
export function formaterQuantite(quantite: number, unite: string): string {
  const u = unite.trim().toLowerCase();
  if (u === 'g') return Math.abs(quantite) >= 1000 ? `${fr(quantite / 1000, 1)} kg` : `${fr(Math.round(quantite))} g`;
  if (u === 'ml') return Math.abs(quantite) >= 1000 ? `${fr(quantite / 1000, 1)} L` : `${fr(Math.round(quantite))} ml`;
  if (u === 'u' || u === '') return fr(quantite);
  // Unités nommées (sachet, pot…) : pluriel français au-delà de 1.
  const pluriel = Math.abs(quantite) >= 2 && !u.endsWith('s') && !u.endsWith('x') ? `${unite}s` : unite;
  return `${fr(quantite)} ${pluriel}`;
}

/** Le nom court de l'ingrédient : « Total Fromage » se lit « Fromage ». */
export function nomIngredient(produit: Produit): string {
  switch (produit.role) {
    case 'TOTAL_FROMAGE': return 'Fromage';
    case 'TOTAL_POULET': return 'Poulet';
    case 'TOTAL_FRITES': return 'Frites';
    case 'TOTAL_GLACE': return 'Glace';
    default: return produit.nom;
  }
}

/**
 * Le stock d'un plat, à partir du stock courant de son produit de référence.
 * Épuisé = plus aucun plat possible (≤ 0) ; bientôt = au plus `seuil` plats.
 */
export function stockDuPlat(
  reference: Reference,
  stock: number,
  consommation: number,
  seuil: number,
): StockPlat {
  const { produit, raison } = reference;
  const plats = consommation > 0 ? Math.max(0, Math.floor(arrondi(stock / consommation) + 1e-9)) : null;
  // Sans nombre de plats (référence posée à la main sur un produit que la
  // recette ne consomme pas), seul « plus rien du tout » a un sens : comparer
  // 3 g de fromage à un seuil de 5 plats ne voudrait rien dire.
  const etat: EtatStockPlat = plats === null
    ? (stock <= 0 ? 'EPUISE' : 'OK')
    : plats <= 0 ? 'EPUISE' : plats <= seuil ? 'BIENTOT' : 'OK';

  let texte: string;
  if (raison === 'PRODUIT_FINI') {
    texte = `Reste ${plats ?? formaterQuantite(Math.max(0, stock), produit.unite)}`;
  } else {
    const quantite = formaterQuantite(stock, produit.unite);
    texte = plats === null ? `${nomIngredient(produit)} ${quantite}` : `${nomIngredient(produit)} ${quantite} · ≈ ${plats}`;
  }
  return {
    produit_id: produit.id,
    produit_nom: produit.nom,
    raison,
    stock: arrondi(stock),
    unite: produit.unite,
    plats_possibles: plats,
    etat,
    texte,
  };
}

/** Seuil orange du site, entier ≥ 0 ; 5 plats si rien n'est réglé. */
export async function lireSeuilStockPlats(dbx: DbOuTx): Promise<number> {
  const [ligne] = await dbx.select().from(parametresLocaux).where(eq(parametresLocaux.cle, CLE_SEUIL_STOCK_PLATS));
  const valeur = Number(ligne?.valeur);
  return Number.isFinite(valeur) && valeur >= 0 ? Math.floor(valeur) : SEUIL_STOCK_PLATS_DEFAUT;
}

/**
 * Consommation des plats DÉJÀ PARTIS EN CUISINE mais pas encore payés.
 *
 * L'inventaire ne décompte une vente qu'au paiement (c'est la règle du ticket
 * Z, et elle reste). Mais une table servie à 13 h paie souvent à 14 h : sans
 * ce complément, la vignette annoncerait pendant une heure du fromage déjà
 * fondu sur les pizzas. On retire donc aussi ce qui a été envoyé en cuisine
 * sur une commande encore ouverte — jamais ce qui dort dans un panier, jamais
 * une ligne annulée. À l'encaissement, la même quantité passe simplement de
 * cette colonne aux ventes de l'inventaire : le chiffre affiché ne bouge pas.
 */
async function consommationsEnCuisine(dbx: DbOuTx): Promise<Map<string, number>> {
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
        inArray(commandes.statut, ['OUVERTE', 'ENVOYEE_CUISINE', 'PRETE', 'SERVIE']),
        isNotNull(commandeItems.envoye_le),
        ne(commandeItems.statut_cuisine, 'ANNULE'),
      ),
    )
    .groupBy(inventaireConsommations.produit_id);
  return new Map(lignes.map((l) => [l.produit_id, Number(l.quantite)]));
}

/** Recettes, produits, surcharges : tout ce qui décide du produit de référence. */
async function chargerReferences(dbx: DbOuTx) {
  const [produits, recettes, surcharges, arts] = await Promise.all([
    dbx.select().from(produitsInventaire).where(eq(produitsInventaire.actif, true)),
    dbx.select().from(inventaireConsommations),
    dbx.select().from(stockPlatsReference),
    dbx.select({ id: articles.id, nom: articles.nom }).from(articles).where(eq(articles.actif, true)),
  ]);
  const recetteDe = new Map<string, LigneRecette[]>();
  for (const r of recettes) {
    const liste = recetteDe.get(r.article_id) ?? [];
    liste.push({ article_id: r.article_id, produit_id: r.produit_id, quantite: Number(r.quantite) });
    recetteDe.set(r.article_id, liste);
  }
  const surchargeDe = new Map<string, Surcharge>(
    surcharges.map((s) => [
      s.article_id,
      s.mode === 'PRODUIT' && s.produit_id ? { mode: 'PRODUIT', produit_id: s.produit_id } : { mode: 'AUCUN' },
    ]),
  );
  return { produits, recetteDe, surchargeDe, arts };
}

/**
 * Le stock de TOUS les plats d'un coup : une seule lecture de l'inventaire
 * pour toute la carte, jamais un calcul par vignette.
 */
export async function calculerStockPlats(dbx: DbOuTx): Promise<StockPlatsVue> {
  const [service] = await dbx
    .select({ id: servicesCaisse.id })
    .from(servicesCaisse)
    .where(eq(servicesCaisse.statut, 'OUVERT'));
  const [{ produits, recetteDe, surchargeDe, arts }, seuil, lignes, enCuisine, reportes] = await Promise.all([
    chargerReferences(dbx),
    lireSeuilStockPlats(dbx),
    lignesInventaireSansCreer(dbx, service?.id ?? null),
    consommationsEnCuisine(dbx),
    stocksReportes(dbx, service?.id ?? null),
  ]);

  // Un produit n'a de stock CONNU que s'il a déjà été compté (dernier
  // inventaire validé), compté ou réceptionné pendant ce shift. Sinon son
  // théorique part de zéro et devient négatif à la première vente : sur un
  // site qui n'a jamais fait d'inventaire, toute la carte s'afficherait
  // épuisée et la page client refuserait tout. Mieux vaut ne rien dire que
  // dire faux.
  const connus = new Set(reportes.keys());
  for (const l of lignes) if (l.entrees > 0 || l.stock_compte !== null) connus.add(l.produit_id);

  const source: StockPlatsVue['source'] = service ? 'SERVICE' : connus.size > 0 ? 'DERNIER_INVENTAIRE' : 'AUCUNE';
  const vue: StockPlatsVue = { source, seuil, calcule_le: new Date().toISOString(), plats: {} };
  if (source === 'AUCUNE') return vue;

  const sortiesEnCuisine = sortiesPourVentes(produits, enCuisine);
  const stockDe = new Map(
    lignes.map((l) => [l.produit_id, arrondi(l.theorique - (sortiesEnCuisine.get(l.produit_id) ?? 0))]),
  );

  for (const a of arts) {
    const recette = recetteDe.get(a.id) ?? [];
    const reference = referenceDuPlat(a.nom, recette, produits, surchargeDe.get(a.id));
    if (!reference || !connus.has(reference.produit.id)) continue;
    const stock = stockDe.get(reference.produit.id);
    if (stock === undefined) continue;
    const principal = stockDuPlat(reference, stock, consommationParPlat(recette, produits, reference.produit), seuil);
    const autres = autresProduits(recette, produits, reference.produit)
      .filter((p) => connus.has(p.id) && stockDe.has(p.id))
      .map((p) => stockDuPlat(
        { produit: p, raison: 'INGREDIENT' }, stockDe.get(p.id)!, consommationParPlat(recette, produits, p), seuil,
      ));
    vue.plats[a.id] = autres.length > 0
      ? { ...principal, etat: pireEtat([principal, ...autres]), etat_produit: principal.etat, autres }
      : principal;
  }
  return vue;
}

/**
 * Les produits suivis d'une recette AUTRES que la référence (2026-10-26) : les
 * frites d'un Steak Frites, le pain d'une Assiette Hamburger. Chacun par le
 * produit qui porte son stock (une portion de frites se lit en sachets), sans
 * doublon, dans l'ordre du catalogue de comptage. Au plus deux : la bande tient
 * sur la photo.
 */
export function autresProduits(recette: LigneRecette[], produits: Produit[], reference: Produit): Produit[] {
  const parId = new Map(produits.map((p) => [p.id, p]));
  const vus = new Set([reference.id]);
  const resultat: Produit[] = [];
  for (const r of recette) {
    const ligne = parId.get(r.produit_id);
    const stock = ligne ? produitDeStock(ligne, produits) : null;
    if (!stock || vus.has(stock.id)) continue;
    vus.add(stock.id);
    resultat.push(stock);
  }
  return resultat
    .sort((a, b) => a.categorie.localeCompare(b.categorie) || a.ordre - b.ordre)
    .slice(0, 2);
}

const GRAVITE: Record<EtatStockPlat, number> = { OK: 0, BIENTOT: 1, EPUISE: 2 };
/** Un plat n'est faisable que si TOUS ses produits le sont. */
function pireEtat(stocks: { etat: EtatStockPlat }[]): EtatStockPlat {
  return stocks.reduce<EtatStockPlat>((pire, s) => (GRAVITE[s.etat] > GRAVITE[pire] ? s.etat : pire), 'OK');
}

/**
 * Plusieurs caisses et tablettes reçoivent le même événement WebSocket et
 * redemandent le stock dans la même seconde : elles partagent le calcul en
 * cours au lieu d'en lancer un chacune. Aucune mise en cache au-delà — un
 * appel arrivé APRÈS la fin du calcul en relance un ; au pire, un appel reçoit
 * le chiffre d'un calcul lancé quelques millisecondes plus tôt. Le refus d'une
 * commande QR, lui, recalcule toujours (`platsEpuises`).
 */
let calculEnCours: Promise<StockPlatsVue> | null = null;
export function stockPlatsPartage(dbx: DbOuTx): Promise<StockPlatsVue> {
  if (!calculEnCours) {
    calculEnCours = calculerStockPlats(dbx).finally(() => {
      calculEnCours = null;
    });
  }
  return calculEnCours;
}

/** Les plats d'une commande QR qui n'ont plus rien en stock, par nom. */
export async function platsEpuises(dbx: DbOuTx, articleIds: string[]): Promise<string[]> {
  if (articleIds.length === 0) return [];
  const vue = await calculerStockPlats(dbx);
  const ids = [...new Set(articleIds)].filter((id) => vue.plats[id]?.etat === 'EPUISE');
  if (ids.length === 0) return [];
  const noms = await dbx.select({ nom: articles.nom }).from(articles).where(inArray(articles.id, ids));
  return noms.map((n) => n.nom);
}

/**
 * Vue des Réglages : pour chaque plat, sa recette, ce que la déduction
 * automatique choisit, la correction éventuelle et la bande telle qu'elle
 * s'affiche en ce moment — le manager voit l'effet de son choix sans quitter
 * l'écran.
 */
export async function referencesPourReglages(dbx: DbOuTx) {
  const [{ produits, recetteDe, surchargeDe, arts }, cats, artsCat, apercu] = await Promise.all([
    chargerReferences(dbx),
    dbx.select({ id: categories.id, nom: categories.nom, ordre: categories.ordre }).from(categories),
    dbx.select({ id: articles.id, categorie_id: articles.categorie_id }).from(articles),
    calculerStockPlats(dbx),
  ]);
  const parId = new Map(produits.map((p) => [p.id, p]));
  const categorieDe = new Map(artsCat.map((a) => [a.id, cats.find((c) => c.id === a.categorie_id)]));
  return {
    seuil: apercu.seuil,
    source: apercu.source,
    produits: produits
      .filter((p) => seCompte(p) && p.role !== 'ENTREE')
      .sort((a, b) => a.categorie.localeCompare(b.categorie) || a.ordre - b.ordre)
      .map((p) => ({ id: p.id, nom: p.nom, categorie: p.categorie, unite: p.unite })),
    articles: arts.map((a) => {
      const recette = recetteDe.get(a.id) ?? [];
      const categorie = categorieDe.get(a.id);
      const auto = deduireReference(a.nom, recette, produits);
      const surcharge = surchargeDe.get(a.id);
      return {
        article_id: a.id,
        nom: a.nom,
        categorie: categorie?.nom ?? '',
        categorie_ordre: categorie?.ordre ?? 0,
        affichage: apercu.plats[a.id] ?? null,
        recette: recette.map((r) => parId.get(r.produit_id)?.nom).filter((n): n is string => !!n),
        automatique: auto ? { produit_id: auto.produit.id, produit_nom: auto.produit.nom, raison: auto.raison } : null,
        mode: surcharge?.mode ?? 'AUTO',
        produit_id: surcharge?.mode === 'PRODUIT' ? surcharge.produit_id : null,
      };
    }).sort((x, y) => x.categorie_ordre - y.categorie_ordre || x.nom.localeCompare(y.nom, 'fr')),
  };
}
