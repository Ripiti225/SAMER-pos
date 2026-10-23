// Contrôle des migrations drizzle avant publication.
//
// Deux pièges réels, tous deux silencieux sur un site :
//   1. Drizzle n'applique une migration que si son `when` (journal) est
//      SUPÉRIEUR à celui de la dernière migration appliquée. Une migration
//      ajoutée avec un `when` plus petit — renumérotation 0034→0039, fusion de
//      branches — n'est JAMAIS jouée, sans la moindre erreur.
//   2. Une migration déjà livrée qu'on modifie ne sera pas rejouée : les sites
//      divergent de ce que dit le dépôt.
// Et la règle « ajouter d'abord, supprimer une version plus tard » (décision
// du 23/10/2026) : le retour arrière automatique remet l'ANCIEN code sur une
// base sauvegardée, mais une version publiée doit toujours fonctionner avec la
// base de la version d'avant (et inversement) le temps du pilote. Une colonne
// supprimée ou renommée casse l'ancien code : refus, sauf
// `--migrations-destructives`.

/** Lit `apps/server/drizzle/meta/_journal.json`. */
export function lireJournal(texte) {
  const j = JSON.parse(texte);
  if (!j || !Array.isArray(j.entries)) throw new Error('Journal drizzle illisible (entries manquant)');
  return j.entries.map((e) => ({ idx: e.idx, tag: e.tag, when: e.when }));
}

/**
 * Cohérence interne du journal et des fichiers : index continus, tag préfixé
 * par son index sur 4 chiffres, `when` strictement croissants, un fichier SQL
 * par entrée et une entrée par fichier. Renvoie la liste des problèmes.
 */
export function controlerJournal(entrees, fichiersSql) {
  const problemes = [];
  const sql = new Set(fichiersSql.map((f) => f.replace(/\.sql$/, '')));
  let precedent = null;
  entrees.forEach((e, i) => {
    if (e.idx !== i) problemes.push(`entrée ${i} : idx ${e.idx} (les index doivent se suivre)`);
    if (typeof e.tag !== 'string' || !e.tag.startsWith(`${String(e.idx).padStart(4, '0')}_`)) {
      problemes.push(`entrée ${i} : le tag « ${e.tag} » ne commence pas par ${String(e.idx).padStart(4, '0')}_`);
    }
    if (!/^\d{4}_[a-z0-9_]+$/.test(String(e.tag))) problemes.push(`entrée ${i} : tag « ${e.tag} » invalide (0043_nom attendu)`);
    if (!Number.isSafeInteger(e.when)) problemes.push(`entrée ${i} : when invalide`);
    else if (precedent !== null && e.when <= precedent) {
      problemes.push(`« ${e.tag} » : when ${e.when} ≤ ${precedent} — drizzle ne l'appliquerait JAMAIS sur un site déjà migré`);
    }
    precedent = Number.isSafeInteger(e.when) ? e.when : precedent;
    if (!sql.has(e.tag)) problemes.push(`« ${e.tag} » : fichier ${e.tag}.sql absent`);
  });
  const tags = new Set(entrees.map((e) => e.tag));
  for (const f of sql) if (!tags.has(f)) problemes.push(`${f}.sql n'est pas dans le journal (jamais appliqué)`);
  return problemes;
}

/**
 * Compare au journal de la version de référence (celle des sites). Renvoie
 * les migrations nouvelles et les problèmes : migration livrée modifiée ou
 * disparue, nouvelle migration qui ne vient pas APRÈS la dernière livrée.
 * `contenuRef(tag)` / `contenuCourant(tag)` rendent le texte SQL.
 */
export function comparerAuxSites(ref, courant, contenuRef, contenuCourant) {
  const problemes = [];
  const parTag = new Map(courant.map((e) => [e.tag, e]));
  for (const e of ref) {
    const c = parTag.get(e.tag);
    if (!c) {
      problemes.push(`migration livrée « ${e.tag} » disparue ou renommée`);
      continue;
    }
    if (c.when !== e.when) problemes.push(`migration livrée « ${e.tag} » : when changé (${e.when} → ${c.when})`);
    if (normaliser(contenuRef(e.tag)) !== normaliser(contenuCourant(e.tag))) {
      problemes.push(`migration livrée « ${e.tag} » modifiée : les sites ne la rejoueront pas`);
    }
  }
  const tagsRef = new Set(ref.map((e) => e.tag));
  const derniereRef = ref.length ? ref[ref.length - 1].when : -Infinity;
  const nouvelles = courant.filter((e) => !tagsRef.has(e.tag));
  for (const e of nouvelles) {
    if (e.when <= derniereRef) problemes.push(`nouvelle migration « ${e.tag} » : when ${e.when} ≤ ${derniereRef} (dernière livrée) — jamais appliquée`);
  }
  return { nouvelles: nouvelles.map((e) => e.tag), problemes };
}

/** Les fins de ligne ne comptent pas (core.autocrlf), le reste si. */
function normaliser(texte) {
  return String(texte ?? '').replace(/\r\n/g, '\n');
}

/** Retire commentaires et chaînes pour ne chercher les mots-clés que dans le code SQL. */
function sansCommentaires(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

/**
 * Les instructions qui cassent l'ancien code : DROP (sauf contrainte, index,
 * déclencheur, fonction, politique, valeur par défaut, NOT NULL — remplacés
 * aussitôt, aucune donnée perdue) et tout RENAME. Renvoie les extraits trouvés.
 */
export function instructionsDestructives(sql) {
  const code = sansCommentaires(sql);
  const trouves = [];
  const reDrop = /\bDROP\s+(?!CONSTRAINT\b|INDEX\b|TRIGGER\b|FUNCTION\b|POLICY\b|DEFAULT\b|NOT\s+NULL\b|IDENTITY\b|EXPRESSION\b)[^;\n]*/gi;
  const reRename = /\bRENAME\b[^;\n]*/gi;
  for (const re of [reDrop, reRename]) {
    for (const m of code.matchAll(re)) trouves.push(m[0].trim().replace(/\s+/g, ' ').slice(0, 120));
  }
  return trouves;
}
