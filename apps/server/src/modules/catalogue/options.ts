/**
 * Résolution des options proposées pour un article (migration 0020).
 *
 * RÈGLE UNIQUE, définie ici et nulle part ailleurs :
 *   options d'un article = options liées à sa CATÉGORIE
 *                        ∪ options liées à l'article lui-même
 * L'union est volontaire : lier « Pâte à l'ail » à la catégorie Chawarmas la
 * propose sur tous les chawarmas, sans empêcher d'ajouter « Fromage » sur un
 * seul d'entre eux. Une option inactive n'est jamais proposée.
 *
 * Ce module est la source de vérité partagée par la lecture du catalogue
 * (chargerCatalogue) ET par la validation à l'ajout d'un article dans une
 * commande (figerNouvelItem) : les deux DOIVENT voir exactement le même
 * ensemble, sinon la caisse proposerait une option que le serveur refuse.
 */
import { and, eq, or } from 'drizzle-orm';
import type { OptionExtraVue } from '@pos/shared';
import type { DbOuTx } from '../../db/client.js';
import { optionsCatalogue, optionsLiaisons } from '../../db/schema/index.js';

interface ArticleLigne {
  id: string;
  categorie_id: string;
}
interface OptionLigne {
  id: string;
  nom: string;
  prix: number;
  ordre: number;
}
interface LiaisonLigne {
  option_id: string;
  categorie_id: string | null;
  article_id: string | null;
}

/** Tri d'affichage stable : ordre choisi par le gérant, puis alphabétique. */
function trier(a: OptionExtraVue, b: OptionExtraVue, ordres: Map<string, number>): number {
  const oa = ordres.get(a.id) ?? 0;
  const ob = ordres.get(b.id) ?? 0;
  return oa !== ob ? oa - ob : a.nom.localeCompare(b.nom, 'fr');
}

/**
 * Version en mémoire, pour le chargement du catalogue complet : évite une
 * requête par article (le catalogue peut compter des centaines de lignes).
 */
export function resoudreOptionsParArticle(
  arts: ArticleLigne[],
  optionsActives: OptionLigne[],
  liaisons: LiaisonLigne[],
): Map<string, OptionExtraVue[]> {
  const parId = new Map(optionsActives.map((o) => [o.id, o]));
  const ordres = new Map(optionsActives.map((o) => [o.id, o.ordre]));

  const parCategorie = new Map<string, string[]>();
  const parArticle = new Map<string, string[]>();
  for (const l of liaisons) {
    if (!parId.has(l.option_id)) continue; // option désactivée ou supprimée
    const cible = l.categorie_id ? parCategorie : parArticle;
    const cle = l.categorie_id ?? l.article_id!;
    const liste = cible.get(cle);
    if (liste) liste.push(l.option_id);
    else cible.set(cle, [l.option_id]);
  }

  const resultat = new Map<string, OptionExtraVue[]>();
  for (const a of arts) {
    const ids = new Set([...(parCategorie.get(a.categorie_id) ?? []), ...(parArticle.get(a.id) ?? [])]);
    if (ids.size === 0) continue;
    const extras: OptionExtraVue[] = [];
    for (const id of ids) {
      const o = parId.get(id)!;
      extras.push({ id: o.id, nom: o.nom, prix: o.prix });
    }
    extras.sort((x, y) => trier(x, y, ordres));
    resultat.set(a.id, extras);
  }
  return resultat;
}

/**
 * Version base, pour UN article : utilisée au moment de figer un item dans une
 * commande. Doit rendre le même ensemble que la fonction ci-dessus.
 */
export async function optionsAutoriseesPourArticle(
  tx: DbOuTx,
  articleId: string,
  categorieId: string,
): Promise<OptionExtraVue[]> {
  const lignes = await tx
    .select({
      id: optionsCatalogue.id,
      nom: optionsCatalogue.nom,
      prix: optionsCatalogue.prix,
      ordre: optionsCatalogue.ordre,
    })
    .from(optionsLiaisons)
    .innerJoin(optionsCatalogue, eq(optionsCatalogue.id, optionsLiaisons.option_id))
    .where(
      and(
        eq(optionsCatalogue.actif, true),
        or(
          eq(optionsLiaisons.categorie_id, categorieId),
          eq(optionsLiaisons.article_id, articleId),
        ),
      ),
    );

  // Une option liée À LA FOIS à la catégorie et à l'article remonte deux fois.
  const parId = new Map(lignes.map((l) => [l.id, l]));
  const ordres = new Map([...parId.values()].map((o) => [o.id, o.ordre]));
  const extras = [...parId.values()].map((o) => ({ id: o.id, nom: o.nom, prix: o.prix }));
  extras.sort((x, y) => trier(x, y, ordres));
  return extras;
}
