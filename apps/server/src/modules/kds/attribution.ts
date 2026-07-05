/**
 * Attribution automatique des plats préparés (correction 4).
 *
 * Un plat est attribué aux employés dont le poste_cuisine correspond à la
 * catégorie de l'article (table mapping_poste_categorie, défaut CUISINIER)
 * ET qui sont « en poste » au moment de la préparation :
 *  - en poste = pointage d'arrivée ouvert aujourd'hui (module pointage) ;
 *  - tant que le pointage n'existe pas (sprint ultérieur) : si AUCUN pointage
 *    ouvert n'existe, tous les employés cuisine actifs sont considérés en
 *    poste, pour ne jamais bloquer.
 * Si plusieurs personnes du même poste sont en poste, l'attribution est
 * collective. Si personne : attribution vide, le service continue.
 * Le KDS n'a aucune notion d'identité : tout est calculé ici, côté serveur.
 */
import { and, eq, gte, isNull } from 'drizzle-orm';
import type { DbOuTx } from '../../db/client.js';
import {
  articles,
  commandeItems,
  mappingPosteCategorie,
  pointages,
  utilisateurs,
} from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';

type Poste = 'CUISINIER' | 'PIZZAIOLO' | 'COMPTOIRISTE';
const POSTE_PAR_DEFAUT: Poste = 'CUISINIER';

/** Employés cuisine « en poste » maintenant, groupés par poste. */
async function enPosteParPoste(tx: DbOuTx): Promise<Map<Poste, string[]>> {
  const cuisine = await tx
    .select()
    .from(utilisateurs)
    .where(and(eq(utilisateurs.role, 'CUISINE'), eq(utilisateurs.actif, true)));

  const debutJour = new Date();
  debutJour.setHours(0, 0, 0, 0);
  const pointes = await tx
    .select({ user_id: pointages.user_id })
    .from(pointages)
    .where(and(gte(pointages.arrivee, debutJour), isNull(pointages.depart)));

  // Sprint 4 A4 : attribution RÉELLE — seuls les employés effectivement
  // POINTÉS (pointage d'arrivée ouvert aujourd'hui) sont « en poste ». Si
  // personne du poste n'est pointé, l'attribution reste vide (à rattacher).
  const idsPointes = new Set(pointes.map((p) => p.user_id));
  const enPoste = cuisine.filter((u) => idsPointes.has(u.id));

  const parPoste = new Map<Poste, string[]>();
  for (const u of enPoste) {
    const poste = (u.poste_cuisine ?? POSTE_PAR_DEFAUT) as Poste;
    parPoste.set(poste, [...(parPoste.get(poste) ?? []), u.id]);
  }
  return parPoste;
}

/**
 * Calcule et enregistre l'attribution de tous les articles envoyés d'une
 * commande (appelé au passage « Prêt » — moment de la préparation).
 */
export async function attribuerPlats(tx: DbOuTx, commandeId: string): Promise<void> {
  const [items, lignesMapping, parPoste] = await Promise.all([
    tx.select().from(commandeItems).where(eq(commandeItems.commande_id, commandeId)),
    tx.select().from(mappingPosteCategorie),
    enPosteParPoste(tx),
  ]);

  const posteParCategorie = new Map(lignesMapping.map((m) => [m.categorie_id, m.poste_cuisine as Poste]));

  // Catégorie de chaque article concerné (les combos vont au poste par défaut)
  const idsArticles = items.map((i) => i.article_id).filter((x): x is string => x !== null);
  const lignesArticles = idsArticles.length
    ? await tx.select({ id: articles.id, categorie_id: articles.categorie_id }).from(articles)
    : [];
  const categorieParArticle = new Map(lignesArticles.map((a) => [a.id, a.categorie_id]));

  for (const item of items) {
    if (item.statut_cuisine === 'ANNULE' || item.envoye_le === null) continue;
    const categorieId = item.article_id ? categorieParArticle.get(item.article_id) : undefined;
    const poste = (categorieId ? posteParCategorie.get(categorieId) : undefined) ?? POSTE_PAR_DEFAUT;
    const attribues = parPoste.get(poste) ?? []; // vide = à rattacher plus tard

    const [maj] = await tx
      .update(commandeItems)
      .set({ attribue_a: attribues })
      .where(eq(commandeItems.id, item.id))
      .returning();
    await ecrireOutbox(tx, 'commande_items', 'UPDATE', item.id, maj as unknown as Record<string, unknown>);
  }
}
