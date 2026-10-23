// Mise à jour à distance — règles des actions `maj_*` de la fonction `siege`.
//
// Logique pure (testée sous Node) : lecture d'un manifeste publié, cycle de vie
// des versions, réglages par site, rétention du bucket. La fonction `siege`
// ne fait que lire/écrire les tables et le stockage autour.
import { RE_HEURE, type Anneau, type StatutVersion, type TypeSite } from './maj-cible.ts';

const RE_SHA256 = /^[0-9a-f]{64}$/;
const RE_COMMIT = /^[0-9a-f]{7,40}$/;
const RE_VERSION = /^(\d{4})\.(\d{2})\.(\d{2})-([1-9]\d{0,2})$/;
/** Même règle que les noms de morceaux du lot L0 (manifeste.cjs, RE_NOM_MORCEAU). */
const RE_NOM_MORCEAU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NOMS_MANIFESTE = ['manifeste.json', 'manifeste.json.sig'];
/** Plafond d'un objet du bucket `paquets-pos` (migration : 50 Mo ; morceaux de 40 Mo). */
export const TAILLE_OBJET_MAX = 50 * 1024 * 1024;
/** Durée d'observation sur l'anneau pilote avant la promotion générale (décision du 23/10). */
export const DUREE_PILOTE_MS = 48 * 3_600_000;

export class ErreurPaquet extends Error {}

export interface MorceauPublie {
  nom: string;
  taille: number;
  sha256: string;
}

/** Ce que le cloud retient d'un manifeste APP ou DEPENDANCES. */
export interface ManifestePublie {
  type: 'APP' | 'DEPENDANCES';
  numero: number | null;
  version: string | null;
  commit: string | null;
  empreinte: string | null;
  dependances_empreinte: string | null;
  lanceur_min: number | null;
  migrations: unknown;
  notes: string;
  morceaux: MorceauPublie[];
  taille_octets: number;
}

function refus(detail: string): never {
  throw new ErreurPaquet(`Manifeste refusé : ${detail}`);
}

function entier(v: unknown, nom: string, min: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) refus(`« ${nom} » doit être un entier ≥ ${min}`);
  return v;
}

/** Un nom de fichier qu'on accepte de placer dans le bucket. */
export function nomFichierValide(nom: unknown): nom is string {
  return typeof nom === 'string' && (NOMS_MANIFESTE.includes(nom) || RE_NOM_MORCEAU.test(nom));
}

/**
 * Lit le manifeste TEL QU'IL A ÉTÉ SIGNÉ (la signature est vérifiée avant,
 * sur ces mêmes octets) et contrôle qu'il correspond à ce que le poste de
 * publication a annoncé. Validation volontairement plus légère que celle du
 * lot L0 : le cloud n'installe rien, il lui faut juste de quoi servir les
 * morceaux et refuser une incohérence grossière. Le lanceur, lui, revalide tout.
 */
export function lireManifestePublie(
  octets: Uint8Array,
  attendu: { type: 'APP'; numero: number } | { type: 'DEPENDANCES'; empreinte: string },
): ManifestePublie {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(octets)) as Record<string, unknown>;
  } catch {
    refus('JSON illisible');
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) refus('ce n’est pas un objet');
  if (m.format !== 1) refus(`format ${String(m.format)} non pris en charge`);
  if (m.type !== attendu.type) refus(`type ${String(m.type)} au lieu de ${attendu.type}`);

  const archive = m.archive as { taille?: unknown; sha256?: unknown } | undefined;
  if (!archive || typeof archive !== 'object') refus('« archive » manquante');
  const tailleArchive = entier(archive.taille, 'archive.taille', 1);
  if (!Array.isArray(m.morceaux) || m.morceaux.length === 0) refus('aucun morceau');
  const noms = new Set<string>();
  let total = 0;
  const morceaux: MorceauPublie[] = (m.morceaux as unknown[]).map((brut, i) => {
    const x = brut as Record<string, unknown>;
    if (!x || typeof x !== 'object') refus(`morceau ${i} illisible`);
    if (!nomFichierValide(x.nom) || NOMS_MANIFESTE.includes(x.nom)) refus(`nom de morceau invalide « ${String(x.nom)} »`);
    if (noms.has(x.nom.toLowerCase())) refus(`morceau en double « ${x.nom} »`);
    noms.add(x.nom.toLowerCase());
    const taille = entier(x.taille, `morceaux[${i}].taille`, 1);
    if (taille > TAILLE_OBJET_MAX) refus(`le morceau « ${x.nom} » dépasse 50 Mo`);
    if (typeof x.sha256 !== 'string' || !RE_SHA256.test(x.sha256)) refus(`empreinte du morceau « ${x.nom} » invalide`);
    total += taille;
    return { nom: x.nom, taille, sha256: x.sha256 };
  });
  if (total !== tailleArchive) refus('la somme des morceaux ne fait pas la taille de l’archive');
  const notes = typeof m.notes === 'string' ? m.notes : '';

  if (attendu.type === 'DEPENDANCES') {
    if (m.empreinte !== attendu.empreinte) refus('l’empreinte ne correspond pas au paquet annoncé');
    return {
      type: 'DEPENDANCES',
      numero: null,
      version: null,
      commit: null,
      empreinte: attendu.empreinte,
      dependances_empreinte: null,
      lanceur_min: null,
      migrations: null,
      notes,
      morceaux,
      taille_octets: tailleArchive,
    };
  }

  if (m.numero !== attendu.numero) refus(`numéro ${String(m.numero)} au lieu de ${attendu.numero}`);
  if (typeof m.version !== 'string' || !RE_VERSION.test(m.version)) refus('« version » doit avoir la forme AAAA.MM.JJ-n');
  if (typeof m.commit !== 'string' || !RE_COMMIT.test(m.commit)) refus('« commit » invalide');
  const lanceurMin = entier(m.lanceur_min, 'lanceur_min', 1);
  const dep = (m.dependances as { empreinte?: unknown } | undefined)?.empreinte;
  if (typeof dep !== 'string' || !RE_SHA256.test(dep)) refus('« dependances.empreinte » invalide');
  return {
    type: 'APP',
    numero: attendu.numero,
    version: m.version,
    commit: m.commit,
    empreinte: null,
    dependances_empreinte: dep,
    lanceur_min: lanceurMin,
    migrations: m.migrations ?? {},
    notes,
    morceaux,
    taille_octets: tailleArchive,
  };
}

/**
 * Compare les morceaux annoncés aux objets réellement présents dans le bucket
 * (nom + taille). Le SHA-256 n'est pas recalculé ici — il faudrait relire des
 * centaines de Mo dans une fonction bornée en mémoire et en temps ; chaque site
 * le vérifie de toute façon morceau par morceau. Renvoie les problèmes en français.
 */
export function problemesObjets(morceaux: MorceauPublie[], objets: { name: string; taille: number | null }[]): string[] {
  const parNom = new Map(objets.map((o) => [o.name, o.taille]));
  const problemes: string[] = [];
  for (const m of morceaux) {
    if (!parNom.has(m.nom)) problemes.push(`morceau « ${m.nom} » absent du stockage`);
    else if (parNom.get(m.nom) !== null && parNom.get(m.nom) !== m.taille) {
      problemes.push(`morceau « ${m.nom} » : ${parNom.get(m.nom)} octets stockés au lieu de ${m.taille}`);
    }
  }
  return problemes;
}

/** Numéro AAAAMMJJnn cohérent avec la version AAAA.MM.JJ-n (n ≤ 99). */
export function numeroCorrespond(numero: number, version: string): boolean {
  const m = RE_VERSION.exec(version);
  if (!m) return false;
  const rang = Number(m[4]);
  if (rang > 99) return false;
  return numero === Number(`${m[1]}${m[2]}${m[3]}`) * 100 + rang;
}

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------

/**
 * BROUILLON → PILOTE → GENERALE ; jamais en arrière, jamais depuis RETIREE
 * (on republie sous un nouveau numéro). Pas de saut BROUILLON → GENERALE : le
 * pilote de 48 h sur Angré 7E est une décision du propriétaire (23/10/2026).
 */
export function transitionPermise(de: StatutVersion, vers: StatutVersion): boolean {
  return (de === 'BROUILLON' && vers === 'PILOTE') || (de === 'PILOTE' && vers === 'GENERALE');
}

/** Temps restant avant la fin des 48 h de pilote, 0 si écoulé. */
export function piloteRestantMs(piloteLe: string | null, maintenant: Date): number {
  if (!piloteLe) return DUREE_PILOTE_MS;
  const ecoule = maintenant.getTime() - new Date(piloteLe).getTime();
  return Math.max(0, DUREE_PILOTE_MS - ecoule);
}

// ---------------------------------------------------------------------------
// Réglages par site
// ---------------------------------------------------------------------------

export interface ModificationReglages {
  type_site?: TypeSite;
  heure_installation?: string;
  heure_filet?: string;
  anneau?: Anneau;
  pause?: boolean;
  version_epinglee?: number | null;
}

/**
 * Lit `corps.modifications` de `maj_reglages_site`. Tout champ inconnu ou mal
 * formé est REFUSÉ (pas ignoré) : un réglage qui ne s'applique pas sans le dire
 * laisserait croire au siège qu'un site s'installera à 05h00 alors qu'il
 * restera à 06h00.
 */
export function lireModificationReglages(brut: unknown): ModificationReglages | { erreur: string } {
  if (brut === undefined || brut === null) return {};
  if (typeof brut !== 'object' || Array.isArray(brut)) return { erreur: 'Modifications illisibles' };
  const b = brut as Record<string, unknown>;
  const out: ModificationReglages = {};
  for (const cle of Object.keys(b)) {
    const v = b[cle];
    switch (cle) {
      case 'type_site':
        if (v !== 'FERME_LA_NUIT' && v !== 'H24') return { erreur: 'Type de site invalide' };
        out.type_site = v;
        break;
      case 'heure_installation':
      case 'heure_filet':
        if (typeof v !== 'string' || !RE_HEURE.test(v)) return { erreur: 'Heure invalide (format HH:MM attendu)' };
        out[cle] = v;
        break;
      case 'anneau':
        if (v !== 'PILOTE' && v !== 'GENERAL') return { erreur: 'Anneau invalide' };
        out.anneau = v;
        break;
      case 'pause':
        if (typeof v !== 'boolean') return { erreur: 'Pause invalide' };
        out.pause = v;
        break;
      case 'version_epinglee':
        if (v === null) out.version_epinglee = null;
        else if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) out.version_epinglee = v;
        else return { erreur: 'Version épinglée invalide' };
        break;
      default:
        return { erreur: `Réglage inconnu : ${cle}` };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rétention du bucket (plan § 2 : « 3 dernières versions conservées »)
// ---------------------------------------------------------------------------

export const VERSIONS_CONSERVEES = 3;

/**
 * Les versions dont on peut effacer les morceaux du bucket. On garde :
 * les 3 numéros les plus hauts (tous statuts), toute version encore CIBLE d'un
 * site ou épinglée, et tout ce qui est déjà purgé est ignoré. Une version
 * retirée récente reste donc là quelques publications : on peut encore
 * regarder ce qui a été servi.
 */
export function versionsAPurger(
  versions: { numero: number; fichiers_purges_le?: string | null }[],
  aGarder: number[],
): number[] {
  const tries = [...versions].map((v) => ({ ...v, numero: Number(v.numero) })).sort((a, b) => b.numero - a.numero);
  const garder = new Set<number>([...tries.slice(0, VERSIONS_CONSERVEES).map((v) => v.numero), ...aGarder.map(Number)]);
  return tries.filter((v) => !v.fichiers_purges_le && !garder.has(v.numero)).map((v) => v.numero);
}
