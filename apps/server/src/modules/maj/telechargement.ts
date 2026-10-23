/**
 * Téléchargement des morceaux d'un paquet (contrat § 1-2).
 *
 * Client HTTP DÉDIÉ, pas `ClientCloud` : celui-ci coupe à 15 s, taillé pour
 * les petits JSON de la synchro ; un morceau de 40 Mo sur la 4G d'un
 * restaurant prend des minutes. Ici :
 * - pas de délai global, mais un délai d'INACTIVITÉ (aucun octet reçu
 *   pendant 60 s → on abandonne et on reprendra) ;
 * - reprise : morceau par morceau (les morceaux complets et vérifiés ne sont
 *   jamais retéléchargés) et, dans un morceau, par `Range` à partir du
 *   `.partiel` déjà reçu ;
 * - URL signée expirée (1 h) : `ErreurUrlExpiree`, l'appelant redemande des
 *   URL fraîches au cloud ;
 * - débit bridé (voir DEBIT_MAX_OCTETS_S) pour ne pas étouffer la synchro des
 *   ventes ;
 * - chaque morceau est contrôlé (taille + SHA-256 du manifeste signé) avant
 *   d'être renommé à son nom définitif.
 */
import { createHash } from 'node:crypto';
import { open, rename, rm, stat, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { ErreurMaj, sha256Fichier, verifierMorceaux, type Manifeste } from './fondations.js';

export class ErreurUrlExpiree extends Error {
  constructor(message = 'Lien de téléchargement expiré') {
    super(message);
    this.name = 'ErreurUrlExpiree';
  }
}

export interface OptionsTelechargement {
  /** Octets par seconde, 0 = illimité. */
  debitMax: number;
  delaiInactiviteMs?: number;
  /** Rapport d'avancement (octets reçus depuis le début de cet appel). */
  progression?: (octets: number) => void;
  fetch?: typeof fetch;
}

const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tailleExistante(chemin: string): Promise<number> {
  try {
    return (await stat(chemin)).size;
  } catch {
    return 0;
  }
}

/** Télécharge UN morceau vers `destination` (via `destination.partiel`), contrôlé contre le manifeste. */
export async function telechargerMorceau(
  url: string,
  destination: string,
  attendu: { taille: number; sha256: string },
  options: OptionsTelechargement,
): Promise<void> {
  const partiel = `${destination}.partiel`;
  const faireFetch = options.fetch ?? fetch;
  const inactivite = options.delaiInactiviteMs ?? 60_000;
  let deja = await tailleExistante(partiel);
  if (deja >= attendu.taille) {
    await rm(partiel, { force: true });
    deja = 0;
  }

  const controleur = new AbortController();
  let minuteur = setTimeout(() => controleur.abort(), inactivite);
  const relancer = () => {
    clearTimeout(minuteur);
    minuteur = setTimeout(() => controleur.abort(), inactivite);
  };
  try {
    let rep: Response;
    try {
      rep = await faireFetch(url, {
        headers: deja > 0 ? { range: `bytes=${deja}-` } : {},
        signal: controleur.signal,
      });
    } catch (e) {
      throw new ErreurMaj('RESEAU', `Téléchargement interrompu : ${(e as Error).message}`);
    }
    // Supabase Storage répond 400 (« InvalidJWT ») ou 403 sur un lien signé expiré.
    if (rep.status === 400 || rep.status === 401 || rep.status === 403) throw new ErreurUrlExpiree();
    if (rep.status !== 200 && rep.status !== 206) {
      throw new ErreurMaj('RESEAU', `Téléchargement refusé par le stockage (HTTP ${rep.status}).`);
    }
    if (rep.status === 200 && deja > 0) {
      // Le serveur ignore le Range : on repart de zéro.
      await truncate(partiel, 0).catch(() => {});
      deja = 0;
    }
    if (!rep.body) throw new ErreurMaj('RESEAU', 'Réponse vide du stockage.');

    const fh = await open(partiel, deja > 0 ? 'a' : 'w');
    const debut = Date.now();
    let recus = 0;
    try {
      const lecteur = rep.body.getReader();
      for (;;) {
        let lu: Awaited<ReturnType<typeof lecteur.read>>;
        try {
          lu = await lecteur.read();
        } catch (e) {
          // Connexion perdue en plein morceau : passager, le `.partiel` reste pour la reprise.
          throw new ErreurMaj('RESEAU', `Téléchargement interrompu : ${(e as Error).message}`);
        }
        const { done, value } = lu;
        if (done) break;
        relancer();
        if (deja + recus + value.length > attendu.taille) {
          throw new ErreurMaj('MORCEAU_CORROMPU', 'Le stockage envoie plus d’octets que prévu.');
        }
        await fh.write(value);
        recus += value.length;
        options.progression?.(recus);
        if (options.debitMax > 0) {
          const enAvance = (recus / options.debitMax) * 1000 - (Date.now() - debut);
          if (enAvance > 0) await attendre(enAvance);
          relancer();
        }
      }
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch (e) {
    if (controleur.signal.aborted) throw new ErreurMaj('RESEAU', 'Téléchargement interrompu : aucune donnée reçue depuis une minute.');
    throw e;
  } finally {
    clearTimeout(minuteur);
  }

  const taille = await tailleExistante(partiel);
  if (taille !== attendu.taille) {
    // Coupure en cours de route : le `.partiel` est gardé pour la reprise.
    throw new ErreurMaj('RESEAU', `Morceau incomplet (${taille} octets sur ${attendu.taille}).`);
  }
  if ((await sha256Fichier(partiel)) !== attendu.sha256) {
    await rm(partiel, { force: true });
    throw new ErreurMaj('MORCEAU_CORROMPU', 'Empreinte du morceau téléchargé incorrecte.');
  }
  await rename(partiel, destination);
}

/**
 * Complète `dossier` avec les morceaux manquants ou abîmés du manifeste.
 * `urls` : nom du morceau → URL signée (réponse `consulter`).
 */
export async function telechargerPaquet(
  dossier: string,
  manifeste: Manifeste,
  urls: Map<string, string>,
  options: OptionsTelechargement,
): Promise<{ telecharges: number }> {
  const { invalides } = await verifierMorceaux(dossier, manifeste);
  let telecharges = 0;
  for (const { nom, raison } of invalides) {
    const morceau = manifeste.morceaux.find((m) => m.nom === nom)!;
    const url = urls.get(nom);
    if (!url) throw new ErreurMaj('MORCEAU_ABSENT', `Le cloud n’a pas fourni de lien pour le morceau ${nom}.`);
    if (raison !== 'ABSENT') await rm(join(dossier, nom), { force: true });
    await telechargerMorceau(url, join(dossier, nom), morceau, options);
    telecharges += 1;
  }
  return { telecharges };
}

/** Empreinte hexadécimale d'un texte (identifiants de rapports). */
export function empreinteCourte(texte: string): string {
  return createHash('sha256').update(texte).digest('hex').slice(0, 12);
}
