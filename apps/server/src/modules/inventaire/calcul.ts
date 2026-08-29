/**
 * Moteur de calcul de l'inventaire de service (DESIGN_V2 § 6.9).
 *
 * Les formules sont reprises À L'IDENTIQUE de SamerTrackly (`app/inventaire.js`,
 * rejouées dans la maquette) : elles sont le contrat avec le back-office, pas
 * une interprétation. Trois natures de ligne :
 *
 *   COMPTE      le caissier saisit le compté ; sorties = ce qui a été vendu
 *   CONSO_*     ne se compte JAMAIS : se lit seulement (vendus + conversion)
 *   TOTAL_*     c'est elle qu'on compte ; ses sorties viennent des consommations
 *
 * Tout est calculé CÔTÉ SERVEUR : l'écran ne fait que l'afficher, et le ticket Z
 * ne peut pas raconter autre chose que l'écran.
 */
import type { entreesStock, inventaireLignes, produitsInventaire } from '../../db/schema/index.js';

export type Produit = typeof produitsInventaire.$inferSelect;
export type LigneDb = typeof inventaireLignes.$inferSelect;
export type EntreeDb = typeof entreesStock.$inferSelect;

/**
 * Une Darina part avec chaque Pot Fresco : ses sorties ne viennent pas d'une
 * vente à elle, mais des ventes de b6. Le lien est nommé ici plutôt que dissous
 * dans une règle générique — c'est une exception métier, pas un motif.
 */
const CODE_POT_FRESCO = 'b6';

/** Deux décimales : la glace se compte en pots (4,5), les frites en sachets. */
export const arrondi = (n: number): number => Math.round(n * 100) / 100;

const nombre = (v: string | null): number => (v === null ? 0 : Number(v));

/** Les consommations et le produit d'entrée ne se comptent pas (§ 6.9). */
export function seCompte(produit: Produit): boolean {
  return !produit.role.startsWith('CONSO') && produit.role !== 'ENTREE';
}

export interface LigneCalculee {
  produit_id: string;
  code: string;
  categorie: string;
  nom: string;
  unite: string;
  role: string;
  prix: number;
  ordre: number;
  stock_initial: number;
  entrees: number;
  sorties: number;
  theorique: number;
  stock_compte: number | null;
  ecart: number | null;
  quantite_expliquee: number;
  explication: string | null;
  /** Manquant non expliqué chiffré en FCFA — information, jamais une retenue. */
  manque_chiffre: number;
  a_compter: boolean;
  /** Le calcul en clair, sous les champs : sinon le chiffre tombe du ciel. */
  calcul: string;
}

export interface Bilan {
  a_compter: number;
  justes: number;
  manquants: number;
  surplus: number;
  montant: number;
}

interface Contexte {
  produits: Produit[];
  /** Quantité vendue du service, par produit (via `article_id`). */
  ventes: Map<string, number>;
  /** Réceptions saisies dans l'onglet « Entrées reçues », par produit. */
  entrees: Map<string, number>;
}

const parRole = (ctx: Contexte, role: string, categorie?: string): Produit[] =>
  ctx.produits.filter((p) => p.role === role && (!categorie || p.categorie === categorie));

const ratioDe = (p: Produit): number => Number(p.ratio ?? 0);
const venduDe = (ctx: Contexte, p: Produit): number => ctx.ventes.get(p.id) ?? 0;
const entreeDe = (ctx: Contexte, p: Produit): number => ctx.entrees.get(p.id) ?? 0;

/** Le produit « source » d'une catégorie (le poulet frais reçu, pour POUL). */
const produitEntree = (ctx: Contexte, categorie: string): Produit | undefined =>
  parRole(ctx, 'ENTREE', categorie)[0];

/**
 * Sorties d'une ligne. Pour les totaux dérivés, elles se déduisent de ce qui a
 * été vendu sur les lignes de consommation de la même catégorie.
 */
function sortiesDe(ctx: Contexte, p: Produit): number {
  switch (p.role) {
    case 'TOTAL_POULET':
      return parRole(ctx, 'CONSO_POULET', p.categorie).reduce((t, c) => t + venduDe(ctx, c) * (ratioDe(c) || 1), 0);
    case 'TOTAL_FROMAGE':
      return parRole(ctx, 'CONSO_FROMAGE', p.categorie).reduce((t, c) => t + venduDe(ctx, c) * ratioDe(c), 0);
    case 'TOTAL_GLACE': {
      const boules = parRole(ctx, 'CONSO_GLACE', p.categorie).reduce((t, c) => t + venduDe(ctx, c) * ratioDe(c), 0);
      const parPot = ratioDe(p) || 1; // 38 boules par pot
      return arrondi(boules / parPot);
    }
    case 'TOTAL_FRITES':
      return arrondi(
        parRole(ctx, 'CONSO_FRITES', p.categorie).reduce((t, c) => {
          const parSachet = ratioDe(c) || 1;
          return t + venduDe(ctx, c) / parSachet;
        }, 0),
      );
    case 'DARINA': {
      const source = ctx.produits.find((x) => x.code === CODE_POT_FRESCO);
      return source ? venduDe(ctx, source) : 0;
    }
    case 'ENTREE':
      // Le poulet frais ne « sort » pas : il alimente Total poulet et Pâte de
      // poulet, qui portent la consommation.
      return 0;
    default:
      return venduDe(ctx, p);
  }
}

/** Entrées utiles : le poulet et la pâte tirent la leur du poulet frais reçu. */
function entreesUtiles(ctx: Contexte, p: Produit): number {
  if (p.role === 'TOTAL_POULET') {
    const source = produitEntree(ctx, p.categorie);
    return source ? entreeDe(ctx, source) : 0;
  }
  if (p.role === 'AUTO_ENT') {
    const source = produitEntree(ctx, p.categorie);
    const parPate = ratioDe(p) || 1; // 10 poulets frais = 1 unité de pâte
    return source ? arrondi(entreeDe(ctx, source) / parPate) : 0;
  }
  return entreeDe(ctx, p);
}

/** Le calcul affiché en clair sous les champs (§ 6.9). */
function calculDe(ctx: Contexte, p: Produit, sorties: number, entrees: number): string {
  const fr = (n: number) => n.toLocaleString('fr-FR');
  switch (p.role) {
    case 'TOTAL_POULET': {
      const noms = parRole(ctx, 'CONSO_POULET', p.categorie).map((c) => c.nom).join(' + ');
      return `Sorties = ${noms} = ${fr(sorties)} · entrée reprise du poulet frais reçu (${fr(entrees)})`;
    }
    case 'AUTO_ENT': {
      const source = produitEntree(ctx, p.categorie);
      const recu = source ? entreeDe(ctx, source) : 0;
      return `Entrée automatique : ${fr(recu)} ${source?.nom ?? 'reçus'} ÷ ${ratioDe(p) || 1} = ${fr(entrees)}`;
    }
    case 'TOTAL_FROMAGE': {
      const n = parRole(ctx, 'CONSO_FROMAGE', p.categorie).filter((c) => venduDe(ctx, c) > 0).length;
      return `${fr(sorties)} g consommés par ${n} produit${n > 1 ? 's' : ''} vendu${n > 1 ? 's' : ''}`;
    }
    case 'TOTAL_GLACE': {
      const boules = parRole(ctx, 'CONSO_GLACE', p.categorie).reduce((t, c) => t + venduDe(ctx, c) * ratioDe(c), 0);
      return `${fr(boules)} boules ÷ ${ratioDe(p) || 1} = ${fr(sorties)} pots`;
    }
    case 'TOTAL_FRITES': {
      const detail = parRole(ctx, 'CONSO_FRITES', p.categorie)
        .map((c) => `${fr(venduDe(ctx, c))} ÷ ${ratioDe(c) || 1}`)
        .join(' + ');
      return `${detail} = ${fr(sorties)} sachets`;
    }
    case 'DARINA':
      return `Une Darina part avec chaque Pot Fresco vendu (${fr(sorties)})`;
    case 'ENTREE':
      return `Reçu ${fr(entrees)} — alimente Total poulet et Pâte de poulet`;
    case 'CONSO_FROMAGE':
      return `${fr(venduDe(ctx, p))} × ${ratioDe(p)} g = ${fr(venduDe(ctx, p) * ratioDe(p))} g de fromage`;
    case 'CONSO_GLACE':
      return `${fr(venduDe(ctx, p))} × ${ratioDe(p)} boules = ${fr(venduDe(ctx, p) * ratioDe(p))} boules`;
    case 'CONSO_FRITES':
      return `${fr(venduDe(ctx, p))} ÷ ${ratioDe(p) || 1} = ${arrondi(venduDe(ctx, p) / (ratioDe(p) || 1))} sachets`;
    case 'CONSO_POULET':
      return 'Compté dans Total poulet';
    default:
      return `Théorique = initial + entrées (${fr(entrees)}) − sorties (${fr(sorties)})`;
  }
}

/**
 * Calcule toutes les lignes de l'inventaire. `lignes` porte ce que le caissier
 * a saisi (compté, justification) ; tout le reste est dérivé.
 */
export function calculerLignes(
  produits: Produit[],
  lignes: LigneDb[],
  entrees: Map<string, number>,
  ventes: Map<string, number>,
): LigneCalculee[] {
  const ctx: Contexte = { produits, ventes, entrees };
  const parProduit = new Map(lignes.map((l) => [l.produit_id, l]));

  return produits
    .slice()
    .sort((a, b) => a.categorie.localeCompare(b.categorie) || a.ordre - b.ordre)
    .map((p) => {
      const ligne = parProduit.get(p.id);
      const stockInitial = nombre(ligne?.stock_initial ?? '0');
      const sorties = arrondi(sortiesDe(ctx, p));
      const entreesUtile = arrondi(entreesUtiles(ctx, p));
      const theorique = arrondi(stockInitial + entreesUtile - sorties);
      const compte = ligne?.stock_compte == null ? null : Number(ligne.stock_compte);
      const ecart = compte === null ? null : arrondi(compte - theorique);
      const expliquee = nombre(ligne?.quantite_expliquee ?? '0');
      const resteInexplique = ecart !== null && ecart < 0 ? Math.max(0, Math.abs(ecart) - expliquee) : 0;

      return {
        produit_id: p.id,
        code: p.code,
        categorie: p.categorie,
        nom: p.nom,
        unite: p.unite,
        role: p.role,
        prix: p.prix,
        ordre: p.ordre,
        stock_initial: stockInitial,
        entrees: entreesUtile,
        sorties,
        theorique,
        stock_compte: compte,
        ecart,
        quantite_expliquee: expliquee,
        explication: ligne?.explication ?? null,
        manque_chiffre: Math.round(resteInexplique * p.prix),
        a_compter: seCompte(p),
        calcul: calculDe(ctx, p, sorties, entreesUtile),
      };
    });
}

/** Compteurs du panneau droit + manquant non expliqué chiffré. */
export function bilan(lignes: LigneCalculee[]): Bilan {
  let aCompter = 0;
  let justes = 0;
  let manquants = 0;
  let surplus = 0;
  let montant = 0;
  for (const l of lignes) {
    if (!l.a_compter) continue;
    if (l.ecart === null) {
      aCompter += 1;
      continue;
    }
    if (l.ecart === 0) justes += 1;
    else if (l.ecart < 0) manquants += 1;
    else surplus += 1;
    montant += l.manque_chiffre;
  }
  return { a_compter: aCompter, justes, manquants, surplus, montant };
}

/**
 * Une explication ne peut pas couvrir plus d'unités qu'il n'en manque.
 *
 * Constaté en production le 2026-08-23 : « Total poulet, manquant 3, expliqué
 * 24 000 ». Le caissier avait saisi le MONTANT (3 × 8 000) dans un champ qui
 * attend un nombre d'unités — l'écran affiche « soit 24 000 F non expliqués »
 * juste au-dessus, il recopie ce nombre. Le manquant passait alors pour
 * entièrement justifié et la retenue tombait à zéro.
 *
 * S'applique aux DEUX SENS depuis le 2026-08-24 : un surplus est une anomalie
 * au même titre qu'un manquant (« d'où sortent ces 3 pains ? ») et Samtrackly
 * le facture déjà — `montantDeduit()` y calcule sur `Math.abs(ecart)`. Le
 * caissier peut donc désormais justifier un surplus, et la même borne
 * s'applique : pas plus d'unités que l'écart constaté.
 *
 * La tolérance absorbe les arrondis des quantités fractionnaires (sachets de
 * frites, boules de glace) : expliquer 0,65 pour un manquant de 0,65 doit
 * passer, malgré la virgule flottante.
 */
export function expliqueeInvalide(ecart: number | null, quantiteExpliquee: number): boolean {
  if (ecart === null || Math.abs(ecart) < 0.01) return false;
  return quantiteExpliquee > Math.abs(ecart) + 0.001;
}
