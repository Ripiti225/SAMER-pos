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
  // Mise à jour à distance (migration 20261023000000) — absents avant elle,
  // NULL tant que le site ne remonte pas le bloc `sante.maj`.
  maj_etat?: EtatMajSite | null;
  maj_numero_installe?: number | null;
  maj_numero_prete?: number | null;
  maj_installation_prevue?: string | null;
  maj_report_jusqua?: string | null;
  maj_derniere_erreur?: string | null;
  maj_espace_libre_mo?: number | null;
  maj_taille_pgdata_mo?: number | null;
  maj_suspects_grenam?: number | null;
  maj_lanceur_numero?: number | null;
  maj_consulte_le?: string | null;
}

export type EtatMajSite = 'A_JOUR' | 'TELECHARGEMENT' | 'PRETE' | 'REPORTEE' | 'INSTALLATION' | 'ECHEC' | 'REFUSEE';

/** Ce que le cloud attend de ce site (action `sante_sites`, bloc `maj`). */
export interface MajSite {
  cible: { numero: number; version: string; disponible_le: string | null; raison: 'EPINGLEE' | 'PILOTE' | 'GENERALE' } | null;
  type_site: 'FERME_LA_NUIT' | 'H24';
  heure_installation: string;
  anneau: 'PILOTE' | 'GENERAL';
  pause: boolean;
}

export interface SiteSante extends RestoGroupe {
  sante: SanteBrute | null;
  /** Absent avant la migration de mise à jour à distance, ou site non enrôlé. */
  maj?: MajSite | null;
}

export interface ReponseSante {
  maintenant: string;
  /** La fonction SQL manque : migration cloud pas encore passée. */
  migration_absente: boolean;
  /** Les tables de mise à jour à distance manquent (migration 20261023000000). */
  maj_absente?: boolean;
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

// ---------------------------------------------------------------------------
// Mise à jour à distance (plan docs/PLAN_MAJ_A_DISTANCE.md § 4)
// ---------------------------------------------------------------------------

/**
 * « En retard » : la version cible est disponible pour ce site depuis plus de
 * 24 h et il ne l'a toujours pas. Décision du propriétaire : au-delà, le siège
 * doit le voir — un poste resté éteint, un disque plein, un antivirus…
 */
export const SEUIL_RETARD_MAJ_MS = 24 * HEURE;

/** AAAAMMJJnn → AAAA.MM.JJ-n (affichage, quand le site ne donne que le numéro). */
export function versionDeNumero(numero: number | null | undefined): string | null {
  if (!numero || !Number.isSafeInteger(numero) || numero < 1_000_000_000) return numero ? String(numero) : null;
  const s = String(numero);
  return `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6, 8)}-${Number(s.slice(8))}`;
}

export type TonMaj = 'ok' | 'attente' | 'alerte' | 'neutre';

export interface EvaluationMaj {
  installe: number | null;
  cible: number | null;
  /** Libellé court de l'état, en français. */
  etat: string;
  ton: TonMaj;
  en_retard: boolean;
  /** Depuis combien de temps la cible attend ce site (si pas à jour). */
  attente_ms: number | null;
  /** Sentinelle Grenam : fichiers suspects trouvés par le site. */
  suspects_grenam: number;
  detail: string | null;
}

const LIBELLE_ETAT: Record<EtatMajSite, { texte: string; ton: TonMaj }> = {
  A_JOUR: { texte: 'À jour', ton: 'ok' },
  TELECHARGEMENT: { texte: 'Téléchargement', ton: 'attente' },
  PRETE: { texte: 'Prête', ton: 'attente' },
  REPORTEE: { texte: 'Reportée', ton: 'attente' },
  INSTALLATION: { texte: 'Installation en cours', ton: 'attente' },
  ECHEC: { texte: 'Échec', ton: 'alerte' },
  REFUSEE: { texte: 'Refusée', ton: 'alerte' },
};

function heureCourte(iso: string | null | undefined): string | null {
  const v = t(iso);
  if (v === null) return null;
  const d = new Date(v);
  // Abidjan = UTC+0 : l'heure UTC EST l'heure du restaurant.
  return `${String(d.getUTCHours()).padStart(2, '0')}h${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function evaluerMaj(site: Pick<SiteSante, 'enrole' | 'sante' | 'maj'>, maintenant: Date): EvaluationMaj {
  const s = site.sante;
  const installe = s?.maj_numero_installe ?? null;
  const cible = site.maj?.cible ?? null;
  const suspects = s?.maj_suspects_grenam ?? 0;
  const base = { installe, cible: cible?.numero ?? null, suspects_grenam: suspects };

  if (!site.enrole) return { ...base, etat: '—', ton: 'neutre', en_retard: false, attente_ms: null, detail: null };

  const aJour = cible === null || (installe !== null && installe >= cible.numero);
  const dispo = t(cible?.disponible_le);
  const attente = !aJour && dispo !== null ? Math.max(0, maintenant.getTime() - dispo) : null;
  // Un site en pause n'est pas « en retard » : c'est voulu par le siège.
  const enRetard = attente !== null && attente > SEUIL_RETARD_MAJ_MS && !site.maj?.pause;

  let etat: string;
  let ton: TonMaj;
  let detail: string | null = null;
  const e = s?.maj_etat ?? null;
  if (e) {
    etat = LIBELLE_ETAT[e].texte;
    ton = LIBELLE_ETAT[e].ton;
    if (e === 'PRETE' && s?.maj_installation_prevue) detail = `installation prévue à ${heureCourte(s.maj_installation_prevue)}`;
    if (e === 'REPORTEE' && s?.maj_report_jusqua) detail = `reportée jusqu’à ${heureCourte(s.maj_report_jusqua)}`;
    if ((e === 'ECHEC' || e === 'REFUSEE') && s?.maj_derniere_erreur) detail = s.maj_derniere_erreur;
    // Le site se dit à jour mais n'a pas la cible : il ne la connaît pas encore.
    if (e === 'A_JOUR' && !aJour) {
      etat = 'En attente';
      ton = 'attente';
    }
  } else if (installe === null) {
    etat = 'Inconnu';
    ton = 'neutre';
    detail = 'Ce POS ne remonte pas encore l’état de ses mises à jour.';
  } else {
    etat = aJour ? 'À jour' : 'En attente';
    ton = aJour ? 'ok' : 'attente';
  }
  if (site.maj?.pause) detail = detail ? `${detail} · en pause` : 'mises à jour en pause';
  if (enRetard) ton = 'alerte';
  if (suspects > 0) {
    ton = 'alerte';
    detail = `${suspects} fichier(s) suspect(s) Grenam détecté(s) sur le poste${detail ? ` · ${detail}` : ''}`;
  }
  return { ...base, etat, ton, en_retard: enRetard, attente_ms: attente, detail };
}
