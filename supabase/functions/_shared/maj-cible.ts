// Mise à jour à distance — ce que la fonction `maj` répond à un site.
//
// Logique pure, sans Supabase ni Deno : testée sous Node (`node --test`), la
// fonction ne fait que lire les tables et appeler ces fonctions. Contrat :
// docs/MAJ_CONTRAT.md § 2 — les formes renvoyées ici en sont la lettre.

export type StatutVersion = 'BROUILLON' | 'PILOTE' | 'GENERALE' | 'RETIREE';
export type TypeSite = 'FERME_LA_NUIT' | 'H24';
export type Anneau = 'PILOTE' | 'GENERAL';

/** Ce qu'il faut d'une ligne de `maj_versions` pour choisir une cible. */
export interface VersionResumee {
  numero: number;
  version: string;
  statut: StatutVersion;
  pilote_le: string | null;
  generale_le: string | null;
  publie_le?: string | null;
  fichiers_purges_le?: string | null;
}

/** Ligne de `maj_reglages_site` (toutes colonnes utiles à la fonction). */
export interface LigneReglages {
  restaurant_id?: string;
  type_site: TypeSite;
  heure_installation: string;
  heure_filet: string;
  anneau: Anneau;
  pause: boolean;
  version_epinglee: number | null;
  installer_maintenant: string | null;
  reessayer: string | null;
  maj_le?: string | null;
}

/** Bloc `reglages` de la réponse `consulter` (contrat § 2, au caractère près). */
export interface ReglagesContrat {
  type_site: TypeSite;
  heure_installation: string;
  heure_filet: string;
  pause: boolean;
  installer_maintenant: string | null;
  reessayer: string | null;
}

/**
 * Défauts d'un site sans ligne de réglages (enrôlé après la migration, ou
 * migration pas encore passée) : 24h/24 à 06:00, anneau général. Ce sont les
 * valeurs de `REGLAGES_DEFAUT` du lot L0 (apps/desktop/maj/creneau.cjs).
 */
export const REGLAGES_DEFAUT: Readonly<LigneReglages> = Object.freeze({
  type_site: 'H24',
  heure_installation: '06:00',
  heure_filet: '05:00',
  anneau: 'GENERAL',
  pause: false,
  version_epinglee: null,
  installer_maintenant: null,
  reessayer: null,
});

export const RE_HEURE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Les réglages du site, ou les défauts. Une valeur abîmée retombe sur le défaut, sans lever. */
export function reglagesDuSite(ligne: Partial<LigneReglages> | null | undefined): LigneReglages {
  const l = ligne ?? {};
  return {
    type_site: l.type_site === 'FERME_LA_NUIT' || l.type_site === 'H24' ? l.type_site : REGLAGES_DEFAUT.type_site,
    heure_installation: typeof l.heure_installation === 'string' && RE_HEURE.test(l.heure_installation)
      ? l.heure_installation
      : REGLAGES_DEFAUT.heure_installation,
    heure_filet: typeof l.heure_filet === 'string' && RE_HEURE.test(l.heure_filet) ? l.heure_filet : REGLAGES_DEFAUT.heure_filet,
    anneau: l.anneau === 'PILOTE' ? 'PILOTE' : 'GENERAL',
    pause: l.pause === true,
    version_epinglee: entierPositif(l.version_epinglee),
    installer_maintenant: typeof l.installer_maintenant === 'string' && l.installer_maintenant ? l.installer_maintenant : null,
    reessayer: typeof l.reessayer === 'string' && l.reessayer ? l.reessayer : null,
    maj_le: typeof l.maj_le === 'string' ? l.maj_le : null,
  };
}

/** Le bloc `reglages` du contrat — sans l'anneau ni l'épinglage, qui ne regardent que le cloud. */
export function reglagesContrat(r: LigneReglages): ReglagesContrat {
  return {
    type_site: r.type_site,
    heure_installation: r.heure_installation,
    heure_filet: r.heure_filet,
    pause: r.pause,
    installer_maintenant: r.installer_maintenant,
    reessayer: r.reessayer,
  };
}

function entierPositif(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Une version utilisable comme cible : jamais retirée, jamais brouillon, fichiers encore là. */
function servable(v: VersionResumee): boolean {
  return (v.statut === 'PILOTE' || v.statut === 'GENERALE') && !v.fichiers_purges_le;
}

export interface Cible extends VersionResumee {
  /**
   * Depuis quand CE site peut la prendre : promotion générale, promotion pilote
   * pour l'anneau pilote, ou épinglage. Sert à la règle « en retard après 24 h ».
   */
  disponible_le: string | null;
  /** Comment elle a été choisie (affiché au siège). */
  raison: 'EPINGLEE' | 'PILOTE' | 'GENERALE';
}

/**
 * La version que CE site doit avoir, avant comparaison avec ce qu'il a
 * (contrat § 2, `cible`) :
 * - épinglée : cette version-là, si elle est servable ; une épingle sur une
 *   version retirée ou un brouillon est ignorée (on retombe sur la règle
 *   normale) — sinon un retrait laisserait le site figé sans que rien ne le dise ;
 * - anneau pilote : la plus haute PILOTE ou GENERALE ;
 * - anneau général : la plus haute GENERALE.
 * `null` : rien à servir.
 */
export function cibleDuSite(versions: VersionResumee[], reglages: LigneReglages): Cible | null {
  if (reglages.version_epinglee !== null) {
    const v = versions.find((x) => Number(x.numero) === reglages.version_epinglee);
    if (v && servable(v)) {
      return { ...v, numero: Number(v.numero), disponible_le: reglages.maj_le ?? v.pilote_le ?? v.generale_le ?? null, raison: 'EPINGLEE' };
    }
  }
  const permis: StatutVersion[] = reglages.anneau === 'PILOTE' ? ['PILOTE', 'GENERALE'] : ['GENERALE'];
  let meilleure: VersionResumee | null = null;
  for (const v of versions) {
    if (!servable(v) || !permis.includes(v.statut)) continue;
    if (!meilleure || Number(v.numero) > Number(meilleure.numero)) meilleure = v;
  }
  if (!meilleure) return null;
  const pilote = reglages.anneau === 'PILOTE';
  // Pour l'anneau pilote, une version passée directement en générale n'a pas
  // de date pilote : la date générale fait alors foi.
  const disponible = pilote ? meilleure.pilote_le ?? meilleure.generale_le : meilleure.generale_le;
  return {
    ...meilleure,
    numero: Number(meilleure.numero),
    disponible_le: disponible ?? null,
    raison: meilleure.statut === 'GENERALE' ? 'GENERALE' : 'PILOTE',
  };
}

/** `cible` du contrat : null si le site a déjà ce numéro ou plus (jamais de retour en arrière). */
export function cibleAServir(cible: Cible | null, numeroInstalle: number): Cible | null {
  if (!cible) return null;
  return cible.numero > numeroInstalle ? cible : null;
}

/** `installee.numero` envoyé par le site ; 0 (poste de développement) si absent ou abîmé. */
export function numeroInstalle(installee: unknown): number {
  if (typeof installee !== 'object' || installee === null) return 0;
  const n = (installee as { numero?: unknown }).numero;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** `lanceur_numero` envoyé par le site, ou null. */
export function numeroLanceur(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 2_147_483_647 ? v : null;
}

// ---------------------------------------------------------------------------
// Stockage
// ---------------------------------------------------------------------------

export const BUCKET_PAQUETS = 'paquets-pos';
/** Validité des URL signées servies aux sites (plan § 2). */
export const DUREE_URL_SECONDES = 3600;
export const FICHIER_MANIFESTE = 'manifeste.json';
export const FICHIER_SIGNATURE = 'manifeste.json.sig';

/** Dossier d'une version APP dans le bucket (contrat § 1). */
export function dossierVersion(numero: number): string {
  return `versions/${numero}`;
}

/** Dossier d'un paquet DEPENDANCES dans le bucket (contrat § 1). */
export function dossierDependances(empreinte: string): string {
  return `deps/${empreinte}`;
}

// ---------------------------------------------------------------------------
// Comptes rendus
// ---------------------------------------------------------------------------

export const EVENEMENTS = [
  'TELECHARGEMENT',
  'PRET',
  'AVERTI',
  'REPORTE',
  'DEBUT',
  'INSTALLE',
  'ECHEC_RETOUR_ARRIERE',
  'REFUSEE',
  'BLOQUE',
  'ESPACE_INSUFFISANT',
  'LANCEUR_TROP_ANCIEN',
  'SIGNATURE_INVALIDE',
  'ERREUR',
] as const;
export type Evenement = (typeof EVENEMENTS)[number];

/** Taille maximale de `detail` (contrat § 2 : « ≤ 8 Ko, le cloud tronque au-delà »). */
export const DETAIL_MAX_OCTETS = 8 * 1024;

/**
 * `detail` borné à 8 Ko. Au-delà, on garde un EXTRAIT texte plutôt que de
 * refuser : le compte rendu d'un échec est justement celui qui porte une longue
 * sortie d'erreur, et c'est celui qu'on veut lire au siège.
 */
export function tronquerDetail(detail: unknown): Record<string, unknown> {
  if (detail === undefined || detail === null) return {};
  const objet = typeof detail === 'object' && !Array.isArray(detail) ? (detail as Record<string, unknown>) : { valeur: detail };
  let texte: string;
  try {
    texte = JSON.stringify(objet);
  } catch {
    return { tronque: true, extrait: 'détail illisible' };
  }
  if (new TextEncoder().encode(texte).length <= DETAIL_MAX_OCTETS) return objet;
  // Découpe par caractères, puis recoupe jusqu'à tenir en octets (accents).
  let extrait = texte.slice(0, DETAIL_MAX_OCTETS - 200);
  while (new TextEncoder().encode(extrait).length > DETAIL_MAX_OCTETS - 200) extrait = extrait.slice(0, -100);
  return { tronque: true, extrait };
}

export interface Rapport {
  numero: number | null;
  evenement: Evenement;
  detail: Record<string, unknown>;
}

/** Lit le corps d'un `rapporter`. Renvoie un message d'erreur français si inexploitable. */
export function lireRapport(corps: Record<string, unknown>): Rapport | { erreur: string } {
  const evenement = String(corps.evenement ?? '');
  if (!(EVENEMENTS as readonly string[]).includes(evenement)) return { erreur: `Événement inconnu : ${evenement || '(vide)'}` };
  const n = corps.numero;
  let numero: number | null = null;
  if (n !== undefined && n !== null) {
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return { erreur: 'Numéro de version invalide' };
    numero = n;
  }
  return { numero, evenement: evenement as Evenement, detail: tronquerDetail(corps.detail) };
}

/**
 * Une erreur PostgREST qui veut dire « table ou colonne absente » : migration
 * pas encore passée. La fonction répond alors des défauts (contrat § 2), jamais
 * une erreur — un site ne doit pas se mettre en échec pour un oubli du cloud.
 */
export function estTableAbsente(erreur: { code?: string; message?: string } | null | undefined): boolean {
  if (!erreur) return false;
  if (['42P01', '42703', 'PGRST204', 'PGRST205', 'PGRST202'].includes(String(erreur.code ?? ''))) return true;
  return /does not exist|schema cache|n'existe pas/i.test(String(erreur.message ?? ''));
}
