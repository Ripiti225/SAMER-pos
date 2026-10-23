// Ce qui part dans un paquet, et ce qui n'y part jamais (plan § 2).
//
// Paquet APP = l'arbre complet de `app/` (un site qui a sauté une version
// installe directement la dernière), MOINS :
//   - les secrets et données du site : `.env*`, `data/`, `.git` ;
//   - ce qui ne tourne pas sur un poste : `apps/siege` (servi par Vercel),
//     `supabase/` (cloud), `docs/`, `.claude/`, les traces de publication ;
//   - `runtime/` (node et PostgreSQL portables) et le `node_modules` RACINE,
//     qui voyagent dans le paquet DEPENDANCES, rare.
// MAIS AVEC les `node_modules` LOCAUX des apps (`apps/<app>/node_modules/…`) :
// les copies `@pos/*` y sont de VRAIES copies sur les sites
// (`injectWorkspacePackages`, voir docs/MAJ_CLE_MASTER.md, report du 22/10) et
// changent à chaque modification de `packages/` ; le paquet les rematérialise
// depuis `packages/` du commit publié. Les rares dépendances propres à une app
// (`idb` pour apps/serveur) suivent le même chemin : quelques Ko.
import fs from 'node:fs';
import path from 'node:path';

/** Premiers segments jamais publiés. */
const RACINES_EXCLUES = new Set([
  '.git',
  '.github',
  '.claude',
  '.superpowers',
  '.vscode',
  '.worktrees',
  'node_modules',
  'data',
  'runtime',
  'supabase',
  'docs',
  'publications',
  'graphify-out',
]);

/** Préfixes jamais publiés (chemins relatifs, séparateur « / »). */
const PREFIXES_EXCLUS = [
  'apps/siege/',
  'apps/desktop/release/',
  // Sauvegarde d'une ancienne compilation de la caisse : la vraie est `dist/`.
  'apps/caisse/dist.avant-optimisation/',
];

/** Caches d'outils dans un node_modules local : régénérés, jamais utiles sur un site. */
const CACHES_NODE_MODULES = new Set(['.vite', '.vite-temp', '.cache', '.bin']);

const FICHIERS_EXCLUS = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

/**
 * Raison d'exclure ce chemin du paquet APP, ou null s'il en fait partie.
 * Chemin relatif à la racine de `app/`, séparateur « / ».
 */
export function exclusionApp(chemin) {
  const segments = chemin.split('/');
  const nom = segments[segments.length - 1].toLowerCase();
  if (RACINES_EXCLUES.has(segments[0])) return `dossier ${segments[0]}/`;
  for (const p of PREFIXES_EXCLUS) if (chemin.startsWith(p) || `${chemin}/` === p) return p;
  // `.env`, `.env.local`, `.env.avant-sync`… : secrets du poste, jamais publiés.
  if (segments.some((s) => s.toLowerCase().startsWith('.env'))) return 'fichier .env';
  if (FICHIERS_EXCLUS.has(nom) || nom.endsWith('.log')) return 'fichier système ou journal';
  const i = segments.indexOf('node_modules');
  if (i !== -1) {
    // Seuls apps/<app>/node_modules et packages/<p>/node_modules sont publiés.
    if (i !== 2 || (segments[0] !== 'apps' && segments[0] !== 'packages')) return 'node_modules hors app';
    if (CACHES_NODE_MODULES.has(segments[3])) return 'cache d’outil';
    // Un node_modules imbriqué dans une copie @pos/* serait redondant.
    if (segments.indexOf('node_modules', i + 1) !== -1 && segments[3] === '@pos') return 'node_modules imbriqué';
  }
  return null;
}

/** Paquets exclus du paquet DEPENDANCES : outils de fabrication de l'exe, inutiles sur un site. */
export const DEPENDANCES_EXCLUES = new Set([
  'electron',
  'electron-builder',
  'electron-builder-squirrel-windows',
  'electron-publish',
  'electron-winstaller',
  'app-builder-bin',
  'app-builder-lib',
  '7zip-bin',
  'dmg-builder',
  'builder-util',
  'builder-util-runtime',
  '@electron',
  '.bin',
  '.cache',
  '.vite',
  '.vite-temp',
]);

/**
 * Raison d'exclure ce chemin du paquet DEPENDANCES (chemins `node_modules/…`),
 * ou null. On n'y met que le node_modules RACINE : `PosSamer.exe` embarque
 * déjà Electron, et electron-builder ne sert qu'à fabriquer l'exe sur le poste
 * master (≈ 500 Mo de moins à descendre sur chaque site).
 */
export function exclusionDependances(chemin) {
  const segments = chemin.split('/');
  if (segments[0] !== 'node_modules') return 'hors node_modules';
  if (DEPENDANCES_EXCLUES.has(segments[1])) return `paquet ${segments[1]}`;
  const nom = segments[segments.length - 1].toLowerCase();
  if (FICHIERS_EXCLUS.has(nom)) return 'fichier système';
  return null;
}

/**
 * Parcourt `racine` et renvoie les fichiers retenus par `exclusion`, triés.
 * Un lien symbolique ou une jonction RETENU est une erreur : l'archive les
 * refuse, et sur les sites ce sont de vraies copies. Les dossiers exclus ne
 * sont pas parcourus (la jonction `node_modules` du dossier temporaire non plus).
 */
export function listerFichiers(racine, exclusion, { depart = '' } = {}) {
  const fichiers = [];
  const liens = [];
  const pile = [depart];
  while (pile.length) {
    const rel = pile.pop();
    const abs = rel ? path.join(racine, ...rel.split('/')) : racine;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const enfant = rel ? `${rel}/${e.name}` : e.name;
      if (exclusion(enfant) !== null) continue;
      if (e.isSymbolicLink()) {
        liens.push(enfant);
        continue;
      }
      if (e.isDirectory()) pile.push(enfant);
      else if (e.isFile()) fichiers.push(enfant);
    }
  }
  if (liens.length) {
    throw new Error(`Liens symboliques ou jonctions dans l'arbre à publier (doivent être de vraies copies) : ${liens.slice(0, 10).join(', ')}`);
  }
  return fichiers.sort();
}

/** Les paquets internes `@pos/*` dont dépend un package.json (dependencies + devDependencies). */
export function dependancesInternes(packageJson) {
  const noms = new Set();
  for (const champ of ['dependencies', 'devDependencies']) {
    for (const nom of Object.keys(packageJson[champ] ?? {})) if (nom.startsWith('@pos/')) noms.add(nom.slice(5));
  }
  return [...noms].sort();
}

/** Supprime un lien/jonction SANS toucher à sa cible, ou un vrai dossier. */
export function retirerSansSuivre(chemin) {
  let st;
  try {
    st = fs.lstatSync(chemin);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    // Jonction Windows : rmdir retire le lien seul. rmSync récursif pourrait
    // suivre la jonction et vider la cible (le node_modules du dépôt).
    try {
      fs.rmdirSync(chemin);
    } catch {
      fs.unlinkSync(chemin);
    }
    return;
  }
  fs.rmSync(chemin, { recursive: true, force: true });
}

function copierDossier(source, cible, ignorer) {
  fs.mkdirSync(cible, { recursive: true });
  for (const e of fs.readdirSync(source, { withFileTypes: true })) {
    if (ignorer.has(e.name)) continue;
    const s = path.join(source, e.name);
    const c = path.join(cible, e.name);
    if (e.isSymbolicLink()) throw new Error(`Lien symbolique inattendu : ${s}`);
    if (e.isDirectory()) copierDossier(s, c, ignorer);
    else if (e.isFile()) fs.copyFileSync(s, c);
  }
}

/**
 * Recopie `packages/<p>` dans chaque `apps/*\/node_modules/@pos/<p>` et
 * `packages/*\/node_modules/@pos/<p>` qui en dépend — l'équivalent de
 * scripts/propager-paquets.ps1, mais depuis le COMMIT publié : c'est ce qui
 * garantit que les copies des sites ne restent jamais périmées (incident du
 * 22/10). Renvoie la liste « app → @pos/p ».
 */
export function materialiserPaquetsInternes(racine) {
  const faits = [];
  for (const groupe of ['packages', 'apps']) {
    const dossierGroupe = path.join(racine, groupe);
    if (!fs.existsSync(dossierGroupe)) continue;
    for (const nom of fs.readdirSync(dossierGroupe).sort()) {
      const pj = path.join(dossierGroupe, nom, 'package.json');
      if (!fs.existsSync(pj)) continue;
      for (const dep of dependancesInternes(JSON.parse(fs.readFileSync(pj, 'utf8')))) {
        const source = path.join(racine, 'packages', dep);
        if (!fs.existsSync(source)) throw new Error(`@pos/${dep} introuvable dans packages/ (requis par ${groupe}/${nom})`);
        const cible = path.join(dossierGroupe, nom, 'node_modules', '@pos', dep);
        retirerSansSuivre(cible);
        copierDossier(source, cible, new Set(['node_modules']));
        faits.push(`${groupe}/${nom} → @pos/${dep}`);
      }
    }
  }
  return faits;
}

/**
 * Mode « node_modules existant » : recopie les dépendances PROPRES à une app
 * (hors `@pos`, hors caches) depuis le dépôt de développement vers l'arbre
 * temporaire. Le node_modules racine, lui, est relié par jonction.
 */
export function copierDependancesLocales(depot, racine) {
  const faits = [];
  for (const groupe of ['apps', 'packages']) {
    const dossierGroupe = path.join(racine, groupe);
    if (!fs.existsSync(dossierGroupe)) continue;
    for (const nom of fs.readdirSync(dossierGroupe).sort()) {
      const source = path.join(depot, groupe, nom, 'node_modules');
      if (!fs.existsSync(source)) continue;
      for (const e of fs.readdirSync(source, { withFileTypes: true })) {
        if (e.name === '@pos' || CACHES_NODE_MODULES.has(e.name) || !e.isDirectory()) continue;
        copierDossier(path.join(source, e.name), path.join(dossierGroupe, nom, 'node_modules', e.name), new Set());
        faits.push(`${groupe}/${nom}/node_modules/${e.name}`);
      }
    }
  }
  return faits;
}
