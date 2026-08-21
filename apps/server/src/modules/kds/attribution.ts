/**
 * Attribution automatique des plats préparés (correction 4).
 *
 * Un plat est attribué aux employés dont le poste_cuisine correspond à la
 * catégorie de l'article (table mapping_poste_categorie, défaut CUISINIER)
 * ET qui sont « en poste » au moment de la préparation :
 *  - en poste = membre de l'« équipe du jour » d'un service ouvert (allègement,
 *    remplace le pointage) ;
 *  - si AUCUNE équipe n'est enregistrée sur un service ouvert, tous les employés
 *    cuisine actifs sont considérés en poste, pour ne jamais bloquer.
 * Le regroupement reste sur poste_cuisine (permanent) : le poste du jour est une
 * info et ne change pas le routage KDS.
 * Si plusieurs personnes du même poste sont en poste, l'attribution est
 * collective. Si personne : attribution vide, le service continue.
 * Le KDS n'a aucune notion d'identité : tout est calculé ici, côté serveur.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { DbOuTx } from '../../db/client.js';
import {
  articles,
  commandeItems,
  equipeService,
  mappingPosteCategorie,
  servicesCaisse,
  utilisateurs,
} from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';

type Poste = 'CUISINIER' | 'PIZZAIOLO' | 'COMPTOIRISTE';
const POSTE_PAR_DEFAUT: Poste = 'CUISINIER';

/**
 * Rôles qui PRÉPARENT des plats et peuvent donc s'en voir attribuer.
 *
 * COMPTOIRISTE ajouté le 2026-08-17 : c'est un rôle à part entière depuis la
 * migration 0024, et sans lui ici, les comptoiristes disparaîtraient de
 * l'attribution — les plats du comptoir ne seraient crédités à personne.
 * ENTRETIEN en est volontairement absent : c'était le défaut d'avant, où un
 * agent d'entretien classé CUISINE se voyait attribuer des plats.
 */
const ROLES_PREPARATION = ['CUISINE', 'COMPTOIRISTE'] as const;

/** Employés en cuisine « en poste » maintenant, groupés par poste. */
async function enPosteParPoste(tx: DbOuTx): Promise<Map<Poste, string[]>> {
  const cuisine = await tx
    .select()
    .from(utilisateurs)
    .where(
      and(
        inArray(utilisateurs.role, [...ROLES_PREPARATION]),
        eq(utilisateurs.actif, true),
      ),
    );

  // Présents = équipe du jour des services encore ouverts.
  const presents = await tx
    .select({ user_id: equipeService.utilisateur_id })
    .from(equipeService)
    .innerJoin(servicesCaisse, eq(servicesCaisse.id, equipeService.service_id))
    .where(eq(servicesCaisse.statut, 'OUVERT'));
  const idsPresents = new Set(presents.map((p) => p.user_id));

  // Aucune équipe enregistrée → on ne bloque jamais : tous les cuisiniers actifs.
  const enPoste = idsPresents.size > 0 ? cuisine.filter((u) => idsPresents.has(u.id)) : cuisine;

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
