/**
 * Meilleurs clients du mois et tirage au sort — logique pure de la fonction
 * `siege`, isolée ici pour être testée sans Deno ni base.
 *
 * Règles du propriétaire (2026-10-21) :
 *  * un gagnant par restaurant et par mois ;
 *  * participants = les 20 clients qui ont le plus dépensé dans ce restaurant
 *    sur le mois (l'agrégation est faite en SQL : `siege_clients_mois`) ;
 *  * chances ÉGALES entre les 20 — le classement désigne qui joue, il ne pèse
 *    pas sur le tirage ;
 *  * l'aléa est tiré ICI, côté serveur : un tirage fait dans le navigateur
 *    pourrait être rejoué ou truqué par qui tient la console.
 */

/** Nombre de participants au tirage d'un restaurant pour un mois. */
export const NB_PARTICIPANTS = 20;

/** Une ligne de `siege_clients_mois`. Les BIGINT arrivent parfois en texte. */
export interface DepenseClient {
  client_id: string;
  telephone: string | null;
  nom: string | null;
  montant: number | string;
  nb_visites: number | string;
}

/** Un participant, tel qu'il est affiché et FIGÉ dans le procès-verbal. */
export interface Participant {
  rang: number;
  client_id: string;
  telephone: string;
  /** Facultatif à la caisse : un client sans nom peut gagner, on l'appellera. */
  nom: string | null;
  montant: number;
  nb_visites: number;
}

export interface Mois {
  /** « 2026-10 » */
  mois: string;
  /** Premier jour du mois, pour la colonne DATE `tirages_clients.mois`. */
  premier_jour: string;
  /** Bornes [debut, fin[ en ISO. Abidjan est à UTC+0 toute l'année. */
  debut: string;
  fin: string;
}

const MOIS = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Lit « AAAA-MM » ; `null` pour tout le reste (pas de conversion implicite). */
export function lireMois(valeur: unknown): Mois | null {
  if (typeof valeur !== 'string') return null;
  const m = MOIS.exec(valeur);
  if (!m) return null;
  const annee = Number(m[1]);
  const numero = Number(m[2]);
  if (annee < 2020 || annee > 2099) return null;
  const debut = new Date(Date.UTC(annee, numero - 1, 1));
  const fin = new Date(Date.UTC(annee, numero, 1));
  return {
    mois: valeur,
    premier_jour: `${valeur}-01`,
    debut: debut.toISOString(),
    fin: fin.toISOString(),
  };
}

/**
 * Le mois est-il terminé ? On ne tire pas au sort un mois en cours : le top 20
 * du 15 n'est pas celui du 31, et le tirage, lui, ne se refait pas.
 */
export function moisTermine(mois: Mois, maintenant: Date): boolean {
  return new Date(mois.fin).getTime() <= maintenant.getTime();
}

function entier(valeur: number | string): number {
  const n = typeof valeur === 'number' ? valeur : Number(valeur);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Les participants : les `limite` clients qui ont le plus dépensé.
 *
 * Le SQL rend tous les ex aequo du dernier rang ; c'est ICI qu'ils sont
 * départagés, de façon DÉTERMINISTE — sinon deux affichages successifs du même
 * mois pourraient montrer deux listes différentes, et un 20e « au hasard de
 * l'ordre des lignes » serait contestable. À montant égal : le plus de visites,
 * puis le téléphone, puis l'identifiant (stable, jamais égal).
 *
 * Un client sans téléphone ou sans dépense est écarté : on ne pourrait pas
 * l'appeler, ou il n'a rien acheté.
 */
export function selectionnerParticipants(lignes: DepenseClient[], limite = NB_PARTICIPANTS): Participant[] {
  const parClient = new Map<string, Omit<Participant, 'rang'>>();
  for (const l of lignes) {
    const telephone = (l.telephone ?? '').trim();
    const montant = entier(l.montant);
    if (!l.client_id || !telephone || montant <= 0) continue;
    // Défense : une même fiche ne joue qu'une fois, même si elle arrivait en double.
    const deja = parClient.get(l.client_id);
    if (deja && deja.montant >= montant) continue;
    parClient.set(l.client_id, {
      client_id: l.client_id,
      telephone,
      nom: (l.nom ?? '').trim() || null,
      montant,
      nb_visites: entier(l.nb_visites),
    });
  }
  return [...parClient.values()]
    .sort((a, b) =>
      b.montant - a.montant ||
      b.nb_visites - a.nb_visites ||
      a.telephone.localeCompare(b.telephone) ||
      a.client_id.localeCompare(b.client_id))
    .slice(0, limite)
    .map((p, i) => ({ rang: i + 1, ...p }));
}

/** Rend un entier uniforme dans [0, n[. Injectable pour les tests. */
export type Alea = (n: number) => number;

/**
 * Entier uniforme dans [0, n[ tiré du générateur CRYPTOGRAPHIQUE.
 *
 * Pas de `Math.random()` (prévisible), et pas de simple modulo : 2³² n'est pas
 * un multiple de 20, un modulo favoriserait les premiers rangs d'un cheveu. On
 * rejette donc les tirages de la « queue » qui dépasse le dernier multiple
 * entier de n — chaque participant a alors EXACTEMENT la même chance.
 */
export function aleaCrypto(n: number): number {
  if (!Number.isSafeInteger(n) || n < 1 || n > 0xffffffff) throw new Error('Nombre de participants invalide');
  const plafond = Math.floor(0x1_0000_0000 / n) * n;
  const tampon = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(tampon);
    if (tampon[0]! < plafond) return tampon[0]! % n;
  }
}

/**
 * Tire le gagnant parmi les participants, à chances égales.
 *
 * L'aléa est vérifié : un générateur qui sortirait de [0, n[ ferait gagner
 * « personne » ou toujours le même — on refuse plutôt que d'enregistrer un
 * tirage faux, puisqu'il ne pourra plus être refait.
 */
export function tirerAuSort(participants: Participant[], alea: Alea = aleaCrypto): Participant {
  if (participants.length === 0) throw new Error('Aucun participant à tirer au sort');
  const index = alea(participants.length);
  if (!Number.isInteger(index) || index < 0 || index >= participants.length) {
    throw new Error('Tirage invalide');
  }
  return participants[index]!;
}
