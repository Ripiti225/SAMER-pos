/**
 * Exécution des ORDRES du siège (canal cloud → site).
 *
 * Le seul ordre d'aujourd'hui est `RASER_SEQUENCE`. Il emprunte exactement le
 * même chemin que le gérant devant sa caisse — `raserSequence()` est partagée —
 * pour que les règles ne divergent pas : seul un shift CLÔTURÉ se rase, ce qui
 * reste est reporté sur la séquence suivante, le rapport est figé, le journal
 * écrit.
 *
 * TROIS GARDE-FOUS, parce que figer la journée d'un restaurant à distance est
 * un geste qu'on ne rattrape pas :
 *
 *  1. **Anti-doublon** — l'uuid de l'ordre est inséré dans `actions_recues`
 *     AVANT exécution. Si le site redémarre entre l'exécution et
 *     l'acquittement, il rejouera l'ordre : l'insertion échoue, on n'exécute
 *     pas deux fois. C'est la table faite pour ça, déjà utilisée par la
 *     tablette serveur.
 *  2. **Péremption** — passé `expire_le`, on refuse. Un ordre émis pendant que
 *     le site était hors ligne tomberait sinon sur la recette d'un autre jour.
 *  3. **Séquence visée** — l'ordre porte l'id de la séquence QUE LE SIÈGE A VUE.
 *     Si le gérant a rasé entre-temps, la séquence ouverte n'est plus la même :
 *     on refuse plutôt que de raser la journée suivante à sa place.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { actionsRecues, sequencesCaisse } from '../../db/schema/index.js';
import { raserSequence } from '../services/sequences.js';
import type { OrdreSiege } from './cloud-client.js';

/** Ce que le site renvoie au siège pour un ordre traité. */
export interface Acquittement {
  statut: 'EXECUTE' | 'ECHEC';
  resultat?: unknown;
  erreur?: string;
}

/** Effets de bord confiés par le serveur (imprimante, diffusion temps réel). */
export interface EffetsOrdre {
  imprimerRapportSequence: (rapport: unknown) => Promise<void>;
  diffuser: (canal: string, id: string) => void;
}

/**
 * Réserve l'ordre. `false` = déjà traité, ne rien faire.
 * L'insertion échoue sur la clé primaire, c'est le comportement recherché.
 */
async function reserver(id: string): Promise<boolean> {
  try {
    await db.insert(actionsRecues).values({ uuid: id });
    return true;
  } catch {
    return false;
  }
}

export async function executerOrdre(ordre: OrdreSiege, effets: EffetsOrdre): Promise<Acquittement | null> {
  if (new Date(ordre.expire_le).getTime() < Date.now()) {
    return { statut: 'ECHEC', erreur: 'Ordre périmé — le site ne l’a pas reçu à temps' };
  }
  if (ordre.type !== 'RASER_SEQUENCE') {
    return { statut: 'ECHEC', erreur: `Ordre inconnu de cette version du POS : ${ordre.type}` };
  }

  // `null` = rien à dire au siège : l'ordre a déjà été traité et acquitté.
  if (!(await reserver(ordre.id))) return null;

  try {
    const sequenceVisee = typeof ordre.params.sequence_id === 'string' ? ordre.params.sequence_id : null;
    const serviceIds = Array.isArray(ordre.params.service_ids)
      ? (ordre.params.service_ids as unknown[]).filter((s): s is string => typeof s === 'string')
      : undefined;

    if (sequenceVisee) {
      const [ouverte] = await db
        .select({ id: sequencesCaisse.id })
        .from(sequencesCaisse)
        .where(eq(sequencesCaisse.statut, 'OUVERTE'))
        .limit(1);
      if (!ouverte) {
        return { statut: 'ECHEC', erreur: 'Aucune séquence ouverte sur ce site' };
      }
      if (ouverte.id !== sequenceVisee) {
        return {
          statut: 'ECHEC',
          erreur: 'La séquence a changé depuis la demande — le gérant a rasé entre-temps. Refaites la demande sur la séquence en cours.',
        };
      }
    }

    const rapport = await raserSequence({
      serviceIds,
      auteurId: null, // le demandeur n'a pas de compte sur ce site
      auteurNom: `Siège — ${ordre.demandeur}`,
      origine: 'SIEGE',
    });

    // Le gérant repart quand même avec son papier : la séquence a été rasée,
    // le récap du jour existe. Hors du chemin d'erreur — une imprimante en
    // panne ne doit pas faire croire au siège que le rasage a échoué.
    await effets.imprimerRapportSequence(rapport).catch(() => {});
    effets.diffuser('service', rapport.sequence_id);

    return { statut: 'EXECUTE', resultat: rapport };
  } catch (e) {
    return { statut: 'ECHEC', erreur: e instanceof Error ? e.message : 'Échec inattendu' };
  }
}
