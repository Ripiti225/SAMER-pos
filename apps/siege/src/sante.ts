/**
 * Santé des sites — ce que la console tire des faits renvoyés par l'action
 * `sante_sites` : une couleur, une phrase, et l'état du paiement en points.
 *
 * Tout est calculé contre `maintenant`, l'heure du CLOUD renvoyée avec les
 * données, et non contre l'horloge du PC qui affiche la console : un PC du
 * siège à l'heure d'hier peindrait sinon tout le groupe en vert.
 */
import type { RestoGroupe } from './api';

const MIN = 60_000;
const HEURE = 60 * MIN;

/** Vert tant que le site a parlé au cloud dans le dernier quart d'heure. */
export const SEUIL_VERT_MS = 15 * MIN;
/**
 * Au-delà, rouge. Ce n'est pas un seuil arbitraire : c'est la règle des 24 h
 * du POS (`soldeVerifiable`, fidelite/service.ts) — sans descente depuis 24 h,
 * le site refuse le paiement en points.
 */
export const SEUIL_ROUGE_MS = 24 * HEURE;
/** Écart d'horloge site/cloud au-delà duquel on le signale. */
export const SEUIL_HORLOGE_MS = 5 * MIN;

/** Ligne de `siege_sante_sites()` (migration 20261021010000_sante_sites). */
export interface SanteBrute {
  restaurant_id: string;
  code: string | null;
  actif: boolean | null;
  /** Dernier lot de ventes acquitté (journal PUSH). */
  dernier_push: string | null;
  /** Dernière descente servie (journal PULL, toutes les 5 min). */
  dernier_pull: string | null;
  rejets_24h: number | null;
  /** NULL : le site tourne un POS antérieur au battement de cœur. */
  battement_le: string | null;
  version_code: string | null;
  commit_git: string | null;
  lignes_en_attente: number | null;
  plus_ancienne_en_attente: string | null;
  dernier_acquittement: string | null;
  /** Dernière descente APPLIQUÉE sur le site — celle de la règle des 24 h. */
  derniere_descente: string | null;
  derniere_erreur: string | null;
  heure_site: string | null;
}

export interface SiteSante extends RestoGroupe {
  sante: SanteBrute | null;
}

export interface ReponseSante {
  maintenant: string;
  /** La fonction SQL manque : migration cloud pas encore passée. */
  migration_absente: boolean;
  sites: SiteSante[];
}

export type CouleurSante = 'vert' | 'orange' | 'rouge' | 'gris';

export interface EvaluationSite {
  couleur: CouleurSante;
  /** Phrase courte, en français, qui dit POURQUOI cette couleur. */
  resume: string;
  /** Dernière fois que le cloud a entendu le site (montée, descente ou battement). */
  dernier_contact: string | null;
  /** Lignes en attente côté site, NULL si le site ne sait pas encore le dire. */
  en_attente: number | null;
  /** Le site refuse en ce moment le paiement en points (règle des 24 h). */
  points_bloques: boolean;
  /** Temps restant avant le blocage des points, quand ils sont encore ouverts. */
  points_bloques_dans_ms: number | null;
  /** Écart d'horloge du mini-PC par rapport au cloud, s'il est notable. */
  decalage_horloge_ms: number | null;
}

function t(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const v = new Date(iso).getTime();
  return Number.isNaN(v) ? null : v;
}

/** « il y a 3 min », « il y a 5 h », « il y a 2 j ». */
export function ilYa(ms: number): string {
  if (ms < MIN) return 'à l’instant';
  if (ms < HEURE) return `il y a ${Math.floor(ms / MIN)} min`;
  if (ms < 48 * HEURE) return `il y a ${Math.floor(ms / HEURE)} h`;
  return `il y a ${Math.floor(ms / (24 * HEURE))} j`;
}

/** Durée sans « il y a » : « 3 h », « 40 min ». */
export function duree(ms: number): string {
  if (ms < HEURE) return `${Math.max(1, Math.floor(ms / MIN))} min`;
  if (ms < 48 * HEURE) return `${Math.floor(ms / HEURE)} h`;
  return `${Math.floor(ms / (24 * HEURE))} j`;
}

function couleurAge(age: number): CouleurSante {
  if (age < SEUIL_VERT_MS) return 'vert';
  if (age < SEUIL_ROUGE_MS) return 'orange';
  return 'rouge';
}

const RANG: Record<CouleurSante, number> = { gris: 0, vert: 1, orange: 2, rouge: 3 };
const pire = (a: CouleurSante, b: CouleurSante): CouleurSante => (RANG[a] >= RANG[b] ? a : b);

export function evaluerSite(site: Pick<SiteSante, 'enrole' | 'sante'>, maintenant: Date): EvaluationSite {
  const now = maintenant.getTime();
  const s = site.sante;

  if (!site.enrole) {
    return {
      couleur: 'gris',
      resume: 'POS pas encore enrôlé : ce restaurant ne synchronise pas.',
      dernier_contact: null,
      en_attente: null,
      points_bloques: false,
      points_bloques_dans_ms: null,
      decalage_horloge_ms: null,
    };
  }

  // Le contact le plus récent, quelle qu'en soit la nature : un site calme la
  // nuit ne pousse rien, mais sa descente passe toutes les 5 minutes.
  const contacts = [s?.dernier_push, s?.dernier_pull, s?.battement_le]
    .map((d) => ({ d: d ?? null, v: t(d) }))
    .filter((x): x is { d: string; v: number } => x.v !== null)
    .sort((a, b) => b.v - a.v);
  const contact = contacts[0] ?? null;

  // Règle des 24 h, avec la date que le SITE utilise : sa dernière descente
  // appliquée. Un POS sans battement ne la donne pas : on se rabat sur la
  // dernière descente servie par le cloud, très proche dans le cas normal.
  const refPoints = s?.battement_le ? t(s.derniere_descente) : t(s?.dernier_pull);
  const ageDescente = refPoints === null ? null : now - refPoints;
  const pointsBloques = ageDescente === null || ageDescente > SEUIL_ROUGE_MS;

  const horloge = s?.battement_le && s.heure_site ? t(s.heure_site)! - t(s.battement_le)! : null;
  const decalage = horloge !== null && Math.abs(horloge) > SEUIL_HORLOGE_MS ? horloge : null;

  const base = {
    dernier_contact: contact?.d ?? null,
    en_attente: s?.battement_le ? s.lignes_en_attente ?? null : null,
    points_bloques: pointsBloques,
    points_bloques_dans_ms: pointsBloques || ageDescente === null ? null : SEUIL_ROUGE_MS - ageDescente,
    decalage_horloge_ms: decalage,
  };

  if (!contact) {
    return { ...base, couleur: 'rouge', resume: 'Ce site n’a jamais parlé au cloud.' };
  }

  const age = now - contact.v;
  let couleur = couleurAge(age);
  let resume =
    couleur === 'vert'
      ? 'Synchronisé.'
      : couleur === 'orange'
        ? `Pas de nouvelles depuis ${duree(age)}.`
        : `Silencieux depuis ${duree(age)} : vérifier internet et le mini-PC.`;

  // Le site parle, mais ses ventes restent chez lui : c'est la panne du
  // 17/08 (cloud qui refuse les lignes, voyant au vert). La couleur suit l'âge
  // de la plus vieille vente en attente, pas celui du dernier contact.
  const attente = base.en_attente ?? 0;
  const plusAncienne = t(s?.plus_ancienne_en_attente);
  if (attente > 0 && plusAncienne !== null) {
    const retard = now - plusAncienne;
    const c = retard < SEUIL_VERT_MS ? 'vert' : couleurAge(retard);
    if (RANG[c] > RANG[couleur]) {
      couleur = pire(couleur, c);
      resume = `${attente} ligne(s) bloquée(s) sur le site depuis ${duree(retard)}`
        + (s?.derniere_erreur ? ` — ${s.derniere_erreur}` : '.');
    }
  }

  // Descente en panne alors que la montée passe : le site paraît vivant mais
  // les points vont se bloquer. Rouge dès qu'ils le sont.
  if (pointsBloques && couleur !== 'rouge') {
    couleur = 'rouge';
    resume = ageDescente === null
      ? 'Aucune descente du catalogue appliquée sur le site : paiement en points bloqué.'
      : `Le catalogue ne descend plus depuis ${duree(ageDescente)} : paiement en points bloqué sur le site.`;
  }

  return { ...base, couleur, resume };
}

/**
 * La version que font tourner la plupart des sites. Sert à repérer celui qui
 * n'a pas suivi une mise à jour — on ne sait pas dire laquelle est la plus
 * récente sans l'historique git, mais on sait dire laquelle est à part.
 */
export function versionMajoritaire(sites: Pick<SiteSante, 'sante'>[]): string | null {
  const compte = new Map<string, number>();
  for (const s of sites) {
    const v = s.sante?.version_code;
    if (v) compte.set(v, (compte.get(v) ?? 0) + 1);
  }
  let meilleure: string | null = null;
  let n = 0;
  for (const [v, k] of compte) {
    if (k > n) {
      meilleure = v;
      n = k;
    }
  }
  // Une seule version partout, ou une égalité : rien à signaler.
  const egalite = [...compte.values()].filter((k) => k === n).length > 1;
  return compte.size > 1 && !egalite ? meilleure : null;
}

/** Ordre d'affichage : les sites qui demandent une intervention d'abord. */
export function trierParUrgence<T extends { evaluation: EvaluationSite; nom: string }>(lignes: T[]): T[] {
  return [...lignes].sort(
    (a, b) => RANG[b.evaluation.couleur] - RANG[a.evaluation.couleur] || a.nom.localeCompare(b.nom, 'fr'),
  );
}
