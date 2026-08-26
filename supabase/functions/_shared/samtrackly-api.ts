// ──────────────────────────────────────────────────────────────────────────────
// Accès REST à SamerTrackly depuis le cloud POS.
//
// La clé vit ici, en secret de fonction, et nulle part ailleurs — surtout pas
// sur les sept postes Windows en restaurant. C'est le même principe que dans
// `siege/index.ts`, dont ce module généralise le helper de lecture.
// ──────────────────────────────────────────────────────────────────────────────

const URL_ST = Deno.env.get('SAMTRACKLY_URL') ?? '';
const CLE_ST = Deno.env.get('SAMTRACKLY_KEY') ?? '';

export class ErreurSamtrackly extends Error {}

export function samtracklyConfigure(): boolean {
  return !!(URL_ST && CLE_ST);
}

function entetes(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: CLE_ST,
    Authorization: `Bearer ${CLE_ST}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function appeler(
  chemin: string,
  init: RequestInit,
  quoi: string,
): Promise<unknown[]> {
  if (!samtracklyConfigure()) {
    throw new ErreurSamtrackly('SamerTrackly non configuré (secrets SAMTRACKLY_URL / SAMTRACKLY_KEY)');
  }
  const rep = await fetch(`${URL_ST}/rest/v1/${chemin}`, init).catch((e) => {
    throw new ErreurSamtrackly(`SamerTrackly injoignable (${quoi}) : ${e}`);
  });
  if (!rep.ok) {
    const detail = await rep.text().catch(() => '');
    throw new ErreurSamtrackly(`SamerTrackly a répondu ${rep.status} sur ${quoi} — ${detail.slice(0, 300)}`);
  }
  const txt = await rep.text();
  if (!txt) return [];
  const parse = JSON.parse(txt);
  return Array.isArray(parse) ? parse : [parse];
}

/** Lecture. `chemin` inclut la table et les filtres PostgREST. */
export function lire<T = Record<string, unknown>>(chemin: string): Promise<T[]> {
  return appeler(chemin, { headers: entetes() }, `GET ${chemin}`) as Promise<T[]>;
}

/** Insertion simple, renvoie les lignes créées. */
export function inserer<T = Record<string, unknown>>(
  table: string,
  lignes: Record<string, unknown>[],
): Promise<T[]> {
  if (lignes.length === 0) return Promise.resolve([]);
  return appeler(
    table,
    {
      method: 'POST',
      headers: entetes({ Prefer: 'return=representation' }),
      body: JSON.stringify(lignes),
    },
    `POST ${table}`,
  ) as Promise<T[]>;
}

/**
 * Écriture idempotente. `surConflit` nomme la ou les colonnes de la contrainte
 * d'unicité : rejouer le même transfert écrase la même ligne au lieu d'en créer
 * une seconde. C'est ce qui rend le pont rejouable sans risque de doublon.
 */
export function upsert<T = Record<string, unknown>>(
  table: string,
  lignes: Record<string, unknown>[],
  surConflit: string,
): Promise<T[]> {
  if (lignes.length === 0) return Promise.resolve([]);
  return appeler(
    `${table}?on_conflict=${surConflit}`,
    {
      method: 'POST',
      headers: entetes({ Prefer: 'resolution=merge-duplicates,return=representation' }),
      body: JSON.stringify(lignes),
    },
    `UPSERT ${table}`,
  ) as Promise<T[]>;
}

/** Met à jour une ligne existante par son id. Ne crée jamais de ligne. */
export function patch(
  table: string,
  id: string,
  champs: Record<string, unknown>,
): Promise<void> {
  return appeler(
    `${table}?id=eq.${id}`,
    { method: 'PATCH', headers: entetes({ Prefer: 'return=minimal' }), body: JSON.stringify(champs) },
    `PATCH ${table}`,
  ).then(() => undefined);
}

/**
 * Suppression. `chemin` inclut la table et le filtre PostgREST — jamais un
 * DELETE sans filtre, PostgREST le refuse de toute façon sans `Prefer:
 * return=minimal` explicite ici, donc une faute de filtre échoue fort plutôt
 * que de vider une table.
 */
export function supprimer(chemin: string): Promise<void> {
  return appeler(
    chemin,
    { method: 'DELETE', headers: entetes({ Prefer: 'return=minimal' }) },
    `DELETE ${chemin}`,
  ).then(() => undefined);
}
