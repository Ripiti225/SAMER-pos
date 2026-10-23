// Battement de cœur d'un site — lecture de ce que le POS envoie avec sa descente.
//
// Le corps vient d'un mini-PC qu'on ne contrôle pas une fois posé dans un
// restaurant : un POS plus ancien, plus récent, ou abîmé peut envoyer n'importe
// quoi. Rien de ce qui est ici ne doit pouvoir faire échouer la descente — la
// fonction rend `null` plutôt que de lever, et l'appelant écrit au mieux.

/** Ligne de `sites_sante`, prête pour l'upsert (sans `restaurant_id`). */
export interface BattementSite {
  version_code: string | null;
  commit_git: string | null;
  lignes_en_attente: number | null;
  plus_ancienne_en_attente: string | null;
  dernier_acquittement: string | null;
  derniere_descente: string | null;
  derniere_erreur: string | null;
  heure_site: string | null;
}

/** Un message d'erreur sert à comprendre, pas à archiver une pile d'appels. */
const ERREUR_MAX = 500;

function texte(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function date(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function entier(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  // INTEGER Postgres : au-delà, l'upsert échouerait pour un chiffre absurde.
  return Math.min(Math.floor(v), 2_147_483_647);
}

/**
 * Lit le champ `sante` du corps de `sync-pull`. `null` si absent (POS antérieur
 * au battement) ou inexploitable : le siège verra alors « version inconnue »
 * plutôt qu'une donnée inventée.
 */
export function lireBattement(brut: unknown): BattementSite | null {
  if (typeof brut !== 'object' || brut === null || Array.isArray(brut)) return null;
  const b = brut as Record<string, unknown>;
  const commit = texte(b.commit_git, 64);
  return {
    version_code: texte(b.version_code, 64),
    // Un commit qui n'en est pas un ne doit pas servir plus tard de référence
    // à une mise à jour à distance.
    commit_git: commit && /^[0-9a-f]{7,64}$/i.test(commit) ? commit.toLowerCase() : null,
    lignes_en_attente: entier(b.lignes_en_attente),
    plus_ancienne_en_attente: date(b.plus_ancienne_en_attente),
    dernier_acquittement: date(b.dernier_acquittement),
    derniere_descente: date(b.derniere_descente),
    derniere_erreur: texte(b.derniere_erreur, ERREUR_MAX),
    heure_site: date(b.heure_site),
  };
}

// ---------------------------------------------------------------------------
// Bloc `sante.maj` (mise à jour à distance, contrat docs/MAJ_CONTRAT.md § 3).
//
// FACULTATIF : un POS antérieur ne l'envoie pas, et la descente ne doit jamais
// en dépendre. Écrit à part du battement de base (voir `sync-pull`) pour que
// l'absence des colonnes `maj_*` (migration 20261023000000 pas encore passée)
// ne fasse pas perdre le battement lui-même.
// ---------------------------------------------------------------------------

export const ETATS_MAJ = ['A_JOUR', 'TELECHARGEMENT', 'PRETE', 'REPORTEE', 'INSTALLATION', 'ECHEC', 'REFUSEE'] as const;
export type EtatMaj = (typeof ETATS_MAJ)[number];

/** Colonnes `maj_*` de `sites_sante` (hors `maj_lanceur_numero` / `maj_consulte_le`, écrites par la fonction `maj`). */
export interface BlocMajSite {
  maj_etat: EtatMaj | null;
  maj_numero_installe: number | null;
  maj_numero_prete: number | null;
  maj_installation_prevue: string | null;
  maj_report_jusqua: string | null;
  maj_derniere_erreur: string | null;
  maj_espace_libre_mo: number | null;
  maj_taille_pgdata_mo: number | null;
  maj_suspects_grenam: number | null;
}

/** BIGINT Postgres, mais un numéro de version tient dans un entier sûr JavaScript. */
function numeroVersion(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/**
 * Lit `sante.maj`. `null` si absent ou si ce n'est pas un objet ; chaque champ
 * abîmé devient NULL plutôt que de faire échouer l'écriture des autres.
 */
export function lireBlocMaj(sante: unknown): BlocMajSite | null {
  if (typeof sante !== 'object' || sante === null || Array.isArray(sante)) return null;
  const brut = (sante as Record<string, unknown>).maj;
  if (typeof brut !== 'object' || brut === null || Array.isArray(brut)) return null;
  const b = brut as Record<string, unknown>;
  const integrite = typeof b.integrite === 'object' && b.integrite !== null ? (b.integrite as Record<string, unknown>) : {};
  return {
    maj_etat: (ETATS_MAJ as readonly string[]).includes(String(b.etat)) ? (b.etat as EtatMaj) : null,
    maj_numero_installe: numeroVersion(b.numero_installe),
    maj_numero_prete: numeroVersion(b.numero_prete),
    maj_installation_prevue: date(b.installation_prevue),
    maj_report_jusqua: date(b.report_jusqua),
    maj_derniere_erreur: texte(b.derniere_erreur, ERREUR_MAX),
    maj_espace_libre_mo: entier(b.espace_libre_mo),
    maj_taille_pgdata_mo: entier(b.taille_pgdata_mo),
    maj_suspects_grenam: entier(integrite.suspects_grenam),
  };
}
