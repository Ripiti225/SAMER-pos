/**
 * Codes promo « cartes colis » en caisse (brief PROMO § 5) — HORS LIGNE.
 *
 * La caisse ne parle pas au cloud pour valider un code : elle lit les codes
 * descendus (PROMO-08). Elle les RÉSERVE pour une commande ouverte, les libère
 * si la commande est annulée, et les consomme à l'encaissement (PROMO-10).
 *
 * Les montants des lignes arrivent tout calculés de commandes/service : ce
 * module ne l'importe pas (commandes/service l'importe, lui).
 */
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  normaliserCodePromo,
  normaliserTelephoneClient,
  remiseCodePromo,
  repartir,
  type CanalCodePromo,
} from '@pos/shared';
import type { DbOuTx } from '../../db/client.js';
import { articles, comboArticles, promoCategoriesExclues, promoCodes, promoLots } from '../../db/schema/index.js';
import { ErreurMetier } from '../../lib/erreurs.js';
import { statutEffectif, type StatutCloud, type StatutLocal } from './statut.js';

type CodeLigne = typeof promoCodes.$inferSelect;
type LotLigne = typeof promoLots.$inferSelect;

/** Une ligne de commande active, son montant déjà calculé (totalLigne). */
export interface LigneCommande {
  id: string;
  article_id: string | null;
  combo_id: string | null;
  montant: number;
}

const jourMois = (d: Date) => d.toISOString().slice(8, 10) + '/' + d.toISOString().slice(5, 7);

/**
 * Pourquoi ce code ne peut pas servir sur CETTE commande, ou `null`.
 * Un code réservé par le site (commande WhatsApp) est accepté : c'est la
 * caisse qui l'encaisse (§ 5.4). Un code déjà réservé ici pour une AUTRE
 * commande ne l'est pas.
 */
export function motifRefus(code: CodeLigne, lot: LotLigne, commandeId: string, maintenant: Date): string | null {
  const statut = statutEffectif(code.statut as StatutCloud, code.local_statut as StatutLocal);
  if (statut === 'UTILISE') return 'Ce code a déjà servi.';
  if (lot.annule_le || statut === 'ANNULE') return 'Ce code a été annulé par le siège.';
  if (code.local_statut === 'RESERVE' && code.local_commande_id !== commandeId) {
    return 'Ce code est déjà sur une autre commande en cours.';
  }
  if (maintenant < lot.valide_du) return `Ce code n’est valable qu’à partir du ${jourMois(lot.valide_du)}.`;
  if (maintenant > lot.valide_au) return `Ce code a expiré le ${jourMois(lot.valide_au)}.`;
  return null;
}

async function codesAvecLot(dbx: DbOuTx, condition: ReturnType<typeof eq>) {
  return dbx
    .select({ code: promoCodes, lot: promoLots })
    .from(promoCodes)
    .innerJoin(promoLots, eq(promoLots.id, promoCodes.lot_id))
    .where(condition);
}

export interface CodeTrouve {
  code: CodeLigne;
  lot: LotLigne;
  /** Trouvé par le numéro du client : la caisse n'affiche que le code masqué. */
  parNumero: boolean;
  /** Autres codes utilisables gardés sur le même numéro. */
  autres: number;
}

/**
 * Le code tapé, ou celui que le client a gardé sur son numéro (R12) : parmi
 * ses codes utilisables, celui qui expire en premier. Lève une ErreurMetier au
 * message prêt à afficher.
 */
export async function resoudreSaisie(dbx: DbOuTx, saisie: string, commandeId: string, maintenant: Date): Promise<CodeTrouve> {
  const code = normaliserCodePromo(saisie);
  if (code) {
    const [trouve] = await codesAvecLot(dbx, eq(promoCodes.code, code));
    if (!trouve) throw new ErreurMetier(await messageCodeInconnu(dbx, code), 404);
    const refus = motifRefus(trouve.code, trouve.lot, commandeId, maintenant);
    if (refus) throw new ErreurMetier(refus, 409);
    return { ...trouve, parNumero: false, autres: 0 };
  }

  const telephone = normaliserTelephoneClient(saisie);
  if (!telephone) {
    throw new ErreurMetier('Ce n’est ni un code promo (ex. PAM-7K3QX) ni un numéro de téléphone à 10 chiffres.', 400);
  }
  const candidats = await codesAvecLot(dbx, eq(promoCodes.telephone, telephone));
  const utilisables = candidats
    .filter((c) => motifRefus(c.code, c.lot, commandeId, maintenant) === null)
    .sort((a, b) => a.lot.valide_au.getTime() - b.lot.valide_au.getTime());
  if (utilisables.length === 0) {
    throw new ErreurMetier(
      candidats.length > 0
        ? 'Les codes gardés sur ce numéro ont déjà servi ou ont expiré.'
        : 'Aucun code promo gardé sur ce numéro. Le client peut donner le code de son autocollant.',
      404,
    );
  }
  return { ...utilisables[0]!, parNumero: true, autres: utilisables.length - 1 };
}

/** Code introuvable : d'un autre restaurant, ou pas encore descendu. */
async function messageCodeInconnu(dbx: DbOuTx, code: string): Promise<string> {
  const [connu] = await dbx.select({ code: promoCodes.code }).from(promoCodes).limit(1);
  if (connu && connu.code.slice(0, 3) !== code.slice(0, 3)) return 'Ce code n’est pas valable dans ce restaurant.';
  return 'Code inconnu de cette caisse. Vérifiez-le sur l’autocollant (un lot tout récent arrive par internet en quelques minutes).';
}

/**
 * Lignes exclues des codes carte (R4) : article d'une catégorie exclue, ou
 * combo qui en contient un. On ne regarde jamais le nom du plat.
 */
export async function lignesExclues(dbx: DbOuTx, lignes: LigneCommande[]): Promise<Set<string>> {
  const categories = await dbx
    .select({ id: promoCategoriesExclues.id })
    .from(promoCategoriesExclues)
    .where(eq(promoCategoriesExclues.exclue, true));
  if (categories.length === 0 || lignes.length === 0) return new Set();
  const exclues = new Set(categories.map((c) => c.id));

  const articleIds = [...new Set(lignes.map((l) => l.article_id).filter((x): x is string => !!x))];
  const comboIds = [...new Set(lignes.map((l) => l.combo_id).filter((x): x is string => !!x))];
  const [arts, composants] = await Promise.all([
    articleIds.length
      ? dbx.select({ id: articles.id, categorie_id: articles.categorie_id }).from(articles).where(inArray(articles.id, articleIds))
      : Promise.resolve([]),
    comboIds.length
      ? dbx
          .select({ combo_id: comboArticles.combo_id, categorie_id: articles.categorie_id })
          .from(comboArticles)
          .innerJoin(articles, eq(articles.id, comboArticles.article_id))
          .where(inArray(comboArticles.combo_id, comboIds))
      : Promise.resolve([]),
  ]);
  const articlesExclus = new Set(arts.filter((a) => exclues.has(a.categorie_id)).map((a) => a.id));
  const combosExclus = new Set(composants.filter((c) => exclues.has(c.categorie_id)).map((c) => c.combo_id));
  return new Set(
    lignes
      .filter((l) => (l.article_id && articlesExclus.has(l.article_id)) || (l.combo_id && combosExclus.has(l.combo_id)))
      .map((l) => l.id),
  );
}

/**
 * Part du happy hour sur chaque ligne, pour le cumul en cascade (R6) : le
 * montant réellement appliqué, réparti au prorata des lignes qu'il vise (tout
 * le panier, ou les lignes de l'article en promotion).
 */
export function partsHappyHour(lignes: LigneCommande[], promo: { article_id: string | null } | null, promoMontant: number): Map<string, number> {
  const visees = promo?.article_id ? lignes.filter((l) => l.article_id === promo.article_id) : lignes;
  const parts = repartir(promoMontant, visees.map((l) => ({ id: l.id, poids: l.montant })));
  for (const l of lignes) if (!parts.has(l.id)) parts.set(l.id, 0);
  return parts;
}

export interface DetailCode {
  pourcentage: number;
  valideAu: Date;
  total: number;
  parLigne: Map<string, number>;
  exclues: Set<string>;
}

/** Remise du code d'une commande, ligne par ligne, après le happy hour. */
export async function detailCodePromo(
  dbx: DbOuTx,
  codeId: string,
  lignes: LigneCommande[],
  promo: { article_id: string | null } | null,
  promoMontant: number,
): Promise<DetailCode | null> {
  const [lot] = await dbx
    .select({ pourcentage: promoLots.pourcentage, valide_au: promoLots.valide_au })
    .from(promoCodes)
    .innerJoin(promoLots, eq(promoLots.id, promoCodes.lot_id))
    .where(eq(promoCodes.id, codeId));
  if (!lot) return null;
  const exclues = await lignesExclues(dbx, lignes);
  const parts = partsHappyHour(lignes, promo, promoMontant);
  const { total, parLigne } = remiseCodePromo(
    lignes.map((l) => ({ id: l.id, montant: l.montant, partHappyHour: parts.get(l.id) ?? 0, exclue: exclues.has(l.id) })),
    lot.pourcentage,
  );
  return { pourcentage: lot.pourcentage, valideAu: lot.valide_au, total, parLigne, exclues };
}

/**
 * Réserve le code pour cette commande. La condition est dans l'UPDATE : si deux
 * postes du même site le tapent au même instant, un seul trouve la ligne libre.
 */
export async function reserverCode(tx: DbOuTx, codeId: string, commandeId: string, canal: CanalCodePromo): Promise<void> {
  const [pris] = await tx
    .update(promoCodes)
    .set({ local_statut: 'RESERVE', local_commande_id: commandeId, local_canal: canal, local_le: new Date() })
    .where(
      and(
        eq(promoCodes.id, codeId),
        or(isNull(promoCodes.local_statut), and(eq(promoCodes.local_statut, 'RESERVE'), eq(promoCodes.local_commande_id, commandeId))),
      ),
    )
    .returning({ id: promoCodes.id });
  if (!pris) throw new ErreurMetier('Ce code vient d’être pris par une autre commande.', 409);
}

/** Libère le code réservé par cette commande (annulée, ou code retiré) — R8. */
export async function libererCode(tx: DbOuTx, codeId: string | null, commandeId: string): Promise<void> {
  if (!codeId) return;
  await tx
    .update(promoCodes)
    .set({ local_statut: null, local_commande_id: null, local_canal: null, local_le: null })
    .where(and(eq(promoCodes.id, codeId), eq(promoCodes.local_statut, 'RESERVE'), eq(promoCodes.local_commande_id, commandeId)));
}
