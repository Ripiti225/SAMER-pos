/**
 * Exécution des ORDRES du siège (canal cloud → site).
 *
 * Deux ordres : `RASER_SEQUENCE` et `REINIT_PIN` (plus bas).
 *
 * `RASER_SEQUENCE` emprunte exactement le
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
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { actionsRecues, sequencesCaisse, utilisateurs } from '../../db/schema/index.js';
import { raserSequence } from '../services/sequences.js';
import { nomDuRole, poserCodeTemporaire } from '../equipe/service.js';
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
  /** Coupe les sessions ouvertes d'un compte (PIN réinitialisé). */
  deconnecter: (utilisateurId: string) => void;
}

const TYPES_CONNUS = ['RASER_SEQUENCE', 'REINIT_PIN'];

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
  if (!TYPES_CONNUS.includes(ordre.type)) {
    return { statut: 'ECHEC', erreur: `Ordre inconnu de cette version du POS : ${ordre.type}` };
  }

  // `null` = rien à dire au siège : l'ordre a déjà été traité et acquitté.
  if (!(await reserver(ordre.id))) return null;

  if (ordre.type === 'REINIT_PIN') return reinitialiserPin(ordre, effets);

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

/**
 * `REINIT_PIN` — le siège remet un employé en « PIN à poser ».
 *
 * Le compte est visé par son `externe_id` (l'id SamerTrackly) : c'est le seul
 * identifiant que le siège et le poste partagent. Le code temporaire arrive
 * DÉJÀ HACHÉ en argon2id : le siège l'a montré à l'administrateur, le cloud
 * n'en a jamais gardé que l'empreinte.
 *
 * Le compte PROPRIÉTAIRE reste protégé (invariant 1.3) : il ne se réinitialise
 * que devant la caisse, par un autre propriétaire.
 */
async function reinitialiserPin(ordre: OrdreSiege, effets: EffetsOrdre): Promise<Acquittement> {
  try {
    const externeId = typeof ordre.params.externe_id === 'string' ? ordre.params.externe_id : '';
    const codeHash = typeof ordre.params.code_hash === 'string' ? ordre.params.code_hash : '';
    if (!externeId || !codeHash.startsWith('$argon2id$')) {
      return { statut: 'ECHEC', erreur: 'Ordre incomplet — employé ou code manquant' };
    }

    const [cible] = await db
      .select({ id: utilisateurs.id, nom: utilisateurs.nom_complet, role_id: utilisateurs.role_id })
      .from(utilisateurs)
      .where(and(eq(utilisateurs.externe_id, externeId), eq(utilisateurs.actif, true)))
      .limit(1);
    if (!cible) {
      return {
        statut: 'ECHEC',
        erreur: 'Cet employé n’est pas (encore) sur la caisse de ce restaurant — synchronisez l’équipe, puis refaites la demande.',
      };
    }
    if ((await nomDuRole(db, cible.role_id)) === 'PROPRIETAIRE') {
      return { statut: 'ECHEC', erreur: 'Le compte propriétaire est protégé : il se réinitialise sur la caisse.' };
    }

    const expire = await poserCodeTemporaire(cible.id, codeHash, {
      user_id: null, // le demandeur n'a pas de compte sur ce site
      meta: { cible: cible.nom, origine: 'SIEGE', demandeur: ordre.demandeur },
    });
    effets.deconnecter(cible.id); // il devra reposer son PIN

    return { statut: 'EXECUTE', resultat: { nom: cible.nom, code_expire_le: expire.toISOString() } };
  } catch (e) {
    return { statut: 'ECHEC', erreur: e instanceof Error ? e.message : 'Échec inattendu' };
  }
}
