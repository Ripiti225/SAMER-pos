/**
 * Lecture périodique de la pointeuse. L'appareil garde ses pointages en
 * mémoire : si le POS est éteint ou la pointeuse injoignable un moment, la
 * lecture suivante rattrape tout (le journal dédoublonne).
 *
 * Mot de passe refusé : la lecture automatique s'ARRÊTE. Retenter toutes les
 * 20 s fait bloquer le POS par l'appareil, et le bon mot de passe ne passe
 * plus non plus. Elle reprend après « Enregistrer et tester » ou « Lire
 * maintenant » (mot de passe changé sur l'appareil lui-même), ou au
 * redémarrage du POS — un seul essai.
 */
import { desc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { pointeuseEvenements } from '../../db/schema/index.js';
import { ErreurAuthPointeuse, lireEvenements, lireInfoAppareil, type ConfigPointeuse } from './isapi.js';
import { appliquerEvenement, chargerConfigPointeuse, reprendreAttente } from './presence.js';

export const INTERVALLE_POINTEUSE_MS = 20_000;
/** Recul à la première lecture : les arrivées du jour déjà pointées. */
const PREMIERE_LECTURE_MS = 12 * 3600_000;
/** Chevauchement entre deux lectures (horloges, pointages en cours d'écriture). */
const CHEVAUCHEMENT_MS = 10 * 60_000;

export interface EtatPointeuse {
  configuree: boolean;
  appareil: string | null;
  modele: string | null;
  derniere_lecture: string | null;
  derniere_erreur: string | null;
  /** Identifiants refusés : plus de lecture automatique jusqu'à une action à l'écran. */
  en_pause: boolean;
}

const etat: EtatPointeuse = {
  configuree: false,
  appareil: null,
  modele: null,
  derniere_lecture: null,
  derniere_erreur: null,
  en_pause: false,
};

export function etatPointeuse(): EtatPointeuse {
  return { ...etat };
}

let enCours = false;

/** Une lecture complète. Renvoie le nombre de pointages nouveaux. */
export async function lirePointeuse(
  quandNouveau?: () => void,
  cfg?: ConfigPointeuse | null,
): Promise<number> {
  const config = cfg ?? (await chargerConfigPointeuse());
  etat.configuree = !!config;
  if (!config || enCours) return 0;
  enCours = true;
  try {
    if (!etat.appareil) {
      const info = await lireInfoAppareil(config);
      etat.appareil = info.numero_serie;
      etat.modele = info.modele;
    }
    const appareil = etat.appareil;
    const [dernier] = await db
      .select({ pointe_le: pointeuseEvenements.pointe_le })
      .from(pointeuseEvenements)
      .where(eq(pointeuseEvenements.appareil, appareil))
      .orderBy(desc(pointeuseEvenements.pointe_le))
      .limit(1);
    const depuis = dernier
      ? new Date(dernier.pointe_le.getTime() - CHEVAUCHEMENT_MS)
      : new Date(Date.now() - PREMIERE_LECTURE_MS);

    const evenements = await lireEvenements(config, depuis);
    let nouveaux = 0;
    for (const ev of evenements) {
      const statut = await db.transaction((tx) => appliquerEvenement(tx, appareil, ev));
      if (statut) nouveaux++;
    }
    nouveaux += await db.transaction((tx) => reprendreAttente(tx));
    etat.derniere_lecture = new Date().toISOString();
    etat.derniere_erreur = null;
    etat.en_pause = false;
    if (nouveaux > 0) quandNouveau?.();
    return nouveaux;
  } catch (e) {
    // L'appareil a pu être remplacé : on le réidentifiera.
    etat.appareil = null;
    noterErreurPointeuse(e);
    throw e;
  } finally {
    enCours = false;
  }
}

/** Retient l'erreur pour l'écran ; un refus d'identifiants met la lecture en pause. */
export function noterErreurPointeuse(e: unknown): void {
  etat.derniere_erreur = (e as Error).message;
  if (e instanceof ErreurAuthPointeuse) etat.en_pause = true;
}

/** Oublie l'appareil identifié (après un changement d'adresse ou de mot de passe). */
export function reinitialiserPointeuse(): void {
  etat.appareil = null;
  etat.modele = null;
  etat.derniere_erreur = null;
  etat.en_pause = false;
}

/** Un tour de la boucle : rien tant que la lecture est en pause. */
export async function tourAutomatique(quandNouveau?: () => void): Promise<number> {
  if (etat.en_pause) return 0;
  return lirePointeuse(quandNouveau);
}

export function demarrerPointeuse(
  quandNouveau: () => void,
  journal: { warn: (o: object, m: string) => void },
): void {
  let derniereErreur: string | null = null;
  const lancer = () =>
    tourAutomatique(quandNouveau)
      .then(() => { derniereErreur = null; })
      .catch((e) => {
        // Une seule ligne de journal par panne, pas une toutes les 20 s.
        const msg = String((e as Error).message ?? e);
        if (msg !== derniereErreur) {
          journal.warn({ e: msg }, etat.en_pause
            ? 'Pointeuse : identifiants refusés, lecture automatique arrêtée'
            : 'Lecture de la pointeuse échouée (réessai automatique)');
        }
        derniereErreur = msg;
      });
  void lancer();
  setInterval(lancer, INTERVALLE_POINTEUSE_MS);
}
