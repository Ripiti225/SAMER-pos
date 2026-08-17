/**
 * Neutralisation de l'ÉCHO WebSocket de nos PROPRES mutations d'articles.
 *
 * Le problème : après un ajout d'article ou un changement de quantité, le
 * serveur répond avec la `CommandeVue` complète (issue de la MÊME transaction,
 * elle fait donc autorité) — puis diffuse `commande` à toutes les connexions,
 * y compris la nôtre. `temps-reel.ts` invalidait alors `['commande', id]`, ce
 * qui écrasait la réponse qu'on venait d'écrire dans le cache et déclenchait un
 * GET réseau strictement inutile, en plein pendant la saisie du caissier.
 *
 * Le serveur n'expose aucun identifiant d'émetteur (et on ne modifie pas le
 * serveur) : on reconnaît donc notre écho côté client, avec un jeton posé juste
 * AVANT l'envoi de la requête et consommé à l'arrivée de l'événement.
 *
 * POURQUOI ÇA NE PEUT PAS RENDRE LA CAISSE SOURDE — quatre barrières :
 *  1. Seul le type EXACTEMENT égal à `commande` est neutralisable. Le KDS
 *     n'émet que `commande:modifiee` / `commande:servie`, le client QR que
 *     `commande:client_a_valider` : leurs changements passent toujours.
 *  2. Le jeton est lié à UNE commande : tout événement visant une autre
 *     commande passe. Un `commande` diffusé sans id (transfert de service)
 *     passe aussi.
 *  3. Les deux autres émetteurs d'un `commande` nu sur la commande en cours
 *     (tablette serveur, validation en salle) diffusent `commande:envoyee`
 *     JUSTE AVANT — événement nommé, jamais neutralisé, qui provoque déjà
 *     l'invalidation. Un ajout d'articles par la tablette reste visible.
 *  4. La fenêtre se referme en 1,5 s, et chaque mutation renvoie la vue
 *     COMPLÈTE : la moindre action suivante resynchronise l'écran.
 *
 * IMPORTANT : `consommerEcho` ne doit être appelé QUE par `temps-reel.ts`. La
 * caisse ouvre deux WebSockets (celle-ci et celle de NotificationsCaisse) qui
 * reçoivent le même message ; un second consommateur viderait le jeton une
 * deuxième fois et avalerait alors un événement légitime.
 */

interface EchoAttendu {
  commandeId: string;
  /** Instant (ms) au-delà duquel le jeton ne vaut plus rien. */
  expire: number;
}

/** Marge après réception de la réponse : l'écho arrive en quelques ms sur le LAN. */
const DELAI_APRES_REPONSE = 1500;
/** Plafond de sûreté si la requête traîne (serveur lent, base occupée). */
const DELAI_MAX = 5000;
/** Au-delà, l'état est forcément incohérent : on préfère invalider trop que trop peu. */
const MAX_JETONS = 50;

const attendus: EchoAttendu[] = [];

function purger(maintenant: number): void {
  for (let i = attendus.length - 1; i >= 0; i--) {
    if (attendus[i]!.expire <= maintenant) attendus.splice(i, 1);
  }
}

/**
 * À appeler JUSTE AVANT d'envoyer la requête — jamais après la réponse : le
 * serveur diffuse aussitôt après le commit, l'écho peut donc arriver avant que
 * React ait fini de traiter la réponse HTTP.
 */
export function attendreEcho(commandeId: string): {
  /** Réponse 2xx reçue → on resserre la fenêtre. */
  confirmer: () => void;
  /** Erreur → aucun événement n'a été diffusé, on retire le jeton. */
  abandonner: () => void;
} {
  const jeton: EchoAttendu = { commandeId, expire: Date.now() + DELAI_MAX };
  attendus.push(jeton);
  if (attendus.length > MAX_JETONS) attendus.length = 0;

  const retirer = () => {
    const i = attendus.indexOf(jeton);
    if (i >= 0) attendus.splice(i, 1);
  };

  return {
    confirmer: () => {
      if (attendus.includes(jeton)) jeton.expire = Date.now() + DELAI_APRES_REPONSE;
    },
    abandonner: retirer,
  };
}

/**
 * true = cet événement est l'écho d'une de nos mutations, le cache est déjà à
 * jour. Consomme le jeton correspondant (un jeton = un écho).
 */
export function consommerEcho(commandeId: string): boolean {
  const maintenant = Date.now();
  purger(maintenant);
  const i = attendus.findIndex((e) => e.commandeId === commandeId);
  if (i < 0) return false;
  attendus.splice(i, 1);
  return true;
}
