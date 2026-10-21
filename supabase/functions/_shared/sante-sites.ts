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
