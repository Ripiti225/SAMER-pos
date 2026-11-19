/**
 * Où en est l'employé aujourd'hui, vu depuis son téléphone : arrivée et départ
 * déjà pointés (par la pointeuse, le téléphone ou la caisse), et donc le seul
 * geste encore possible. Décision 2026-11-19 : arrivée + départ, pas de pause.
 */
import { and, desc, eq, gt } from 'drizzle-orm';
import type { DbOuTx } from '../../db/client.js';
import { equipeService, pointeuseEvenements, servicesCaisse } from '../../db/schema/index.js';
import { sourceDeLAppareil } from '../pointeuse/presence.js';

/** Même fraîcheur qu'une arrivée de pointeuse en attente (≤ 8 h). */
const FRAICHEUR_ATTENTE_MS = 8 * 3600_000;

export type ActionPossible = 'ARRIVEE' | 'DEPART' | 'AUCUNE';

export interface EtatPresence {
  service_ouvert: boolean;
  arrivee: Date | null;
  depart: Date | null;
  /** POINTEUSE, TELEPHONE, CAISSE ou OUVERTURE. */
  source: string | null;
  /** Arrivée pointée avant l'ouverture du shift : elle y entrera à l'ouverture. */
  en_attente: boolean;
  action: ActionPossible;
}

export async function etatPresence(tx: DbOuTx, utilisateurId: string): Promise<EtatPresence> {
  const [service] = await tx
    .select({ id: servicesCaisse.id })
    .from(servicesCaisse)
    .where(eq(servicesCaisse.statut, 'OUVERT'))
    .limit(1);

  if (service) {
    const [membre] = await tx
      .select()
      .from(equipeService)
      .where(and(eq(equipeService.service_id, service.id), eq(equipeService.utilisateur_id, utilisateurId)));
    if (membre?.pointe_le) {
      return {
        service_ouvert: true,
        arrivee: membre.pointe_le,
        depart: membre.depart_le,
        source: membre.source,
        en_attente: false,
        action: membre.depart_le ? 'AUCUNE' : 'DEPART',
      };
    }
  }

  // Pas (encore) dans l'équipe : une arrivée pointée avant l'ouverture attend.
  const [attente] = await tx
    .select()
    .from(pointeuseEvenements)
    .where(and(
      eq(pointeuseEvenements.utilisateur_id, utilisateurId),
      eq(pointeuseEvenements.statut, 'EN_ATTENTE'),
      eq(pointeuseEvenements.sens, 'ENTREE'),
      gt(pointeuseEvenements.pointe_le, new Date(Date.now() - FRAICHEUR_ATTENTE_MS)),
    ))
    .orderBy(desc(pointeuseEvenements.pointe_le))
    .limit(1);
  if (attente) {
    return {
      service_ouvert: !!service,
      arrivee: attente.pointe_le,
      depart: null,
      source: sourceDeLAppareil(attente.appareil),
      en_attente: true,
      // Le départ se pointe sur un shift : rien tant qu'il n'est pas ouvert.
      action: service ? 'DEPART' : 'AUCUNE',
    };
  }

  return { service_ouvert: !!service, arrivee: null, depart: null, source: null, en_attente: false, action: 'ARRIVEE' };
}

const LIBELLES_SOURCE: Record<string, string> = {
  POINTEUSE: 'à la pointeuse',
  TELEPHONE: 'au téléphone',
  CAISSE: 'à la caisse',
  OUVERTURE: 'à l’ouverture du shift',
};

export function libelleSource(source: string | null): string {
  return (source && LIBELLES_SOURCE[source]) ?? '';
}

/** « 8 h 02 », heure d'Abidjan (UTC+0, sans heure d'été). */
export function heureLisible(d: Date): string {
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  return `${h} h ${String(m).padStart(2, '0')}`;
}
