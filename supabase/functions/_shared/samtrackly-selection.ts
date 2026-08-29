import { doitTransferer, type ConfigPont } from './samtrackly-shift.ts';

export interface ServiceASelectionner {
  id: string;
  restaurant_id: string;
  ouvert_le?: string | null;
  cloture_le?: string | null;
}

/** Lit une table Supabase entière sans dépendre de sa limite API par requête. */
export async function chargerToutesLesPages<T>(
  chargerPage: (debut: number, fin: number) => Promise<T[]>,
  taillePage = 1000,
): Promise<T[]> {
  const toutes: T[] = [];

  for (let debut = 0; ; debut += taillePage) {
    const page = await chargerPage(debut, debut + taillePage - 1);
    toutes.push(...page);
    if (page.length < taillePage) return toutes;
  }
}

/**
 * Parcourt les services par pages jusqu'à remplir le lot réellement en attente.
 *
 * Filtrer après un unique `limit(100)` bloque définitivement le pont lorsque
 * les 100 premiers services sont déjà transférés : les nouveaux services ne
 * sont alors jamais lus. La pagination continue tant que le lot n'est pas
 * rempli et qu'une page complète laisse supposer qu'il reste des lignes.
 */
export async function chargerServicesEnAttente<T extends ServiceASelectionner>(
  chargerPage: (debut: number, fin: number) => Promise<T[]>,
  faits: ReadonlySet<string>,
  configParResto: ReadonlyMap<string, ConfigPont>,
  lotMax: number,
  taillePage = 100,
): Promise<T[]> {
  const retenus: T[] = [];
  const vus = new Set<string>();

  for (let debut = 0; retenus.length < lotMax; debut += taillePage) {
    const page = await chargerPage(debut, debut + taillePage - 1);

    for (const service of page) {
      if (vus.has(service.id)) continue;
      vus.add(service.id);
      if (faits.has(service.id)) continue;
      if (!doitTransferer(service, configParResto.get(service.restaurant_id))) continue;
      retenus.push(service);
      if (retenus.length === lotMax) break;
    }

    if (page.length < taillePage) break;
  }

  return retenus;
}
