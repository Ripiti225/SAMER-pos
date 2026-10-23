// Contrôle anti-Grenam et scan Defender avant publication.
//
// Le 16/10/2026, Virus:Win32/Grenam.VA a remplacé 82 exécutables de la clé
// master par lui-même (533 504 octets) et caché chaque original en `g<nom>`
// (Caché + Système) — voir docs/MAJ_CLE_MASTER.md, report du 19/10. Publier
// depuis un poste infecté, c'est le livrer aux huit sites d'un coup, SIGNÉ.
// D'où ce contrôle, en plus de Defender : il ne dépend d'aucune signature
// antivirale à jour.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const TAILLE_GRENAM = 533_504;

/**
 * Fichiers suspects parmi `fichiers` ({ chemin, taille }) :
 * - tout fichier de 533 504 octets (la taille du ver) ;
 * - tout `g<nom>.exe` à côté d'un `<nom>.exe` (l'original caché) ;
 * - tout `g*.exe` présent dans `caches` (fichiers à attribut Caché).
 */
export function suspectsGrenam(fichiers, caches = new Set()) {
  const suspects = [];
  const parDossier = new Map();
  for (const f of fichiers) {
    const dossier = f.chemin.includes('/') ? f.chemin.slice(0, f.chemin.lastIndexOf('/')) : '';
    const nom = f.chemin.slice(f.chemin.lastIndexOf('/') + 1).toLowerCase();
    if (!parDossier.has(dossier)) parDossier.set(dossier, new Set());
    parDossier.get(dossier).add(nom);
  }
  for (const f of fichiers) {
    const nom = f.chemin.slice(f.chemin.lastIndexOf('/') + 1).toLowerCase();
    const dossier = f.chemin.includes('/') ? f.chemin.slice(0, f.chemin.lastIndexOf('/')) : '';
    if (f.taille === TAILLE_GRENAM) suspects.push(`${f.chemin} (533 504 octets)`);
    else if (/^g.+\.exe$/.test(nom) && parDossier.get(dossier).has(nom.slice(1))) suspects.push(`${f.chemin} (copie « g » d'un exécutable)`);
    else if (/^g.*\.exe$/.test(nom) && caches.has(f.chemin.toLowerCase())) suspects.push(`${f.chemin} (exécutable caché)`);
  }
  return suspects;
}

/** Exécutables dans le paquet APP : il n'en contient aucun (sauf le lanceur en phase 3). */
export function executablesApp(chemins) {
  return chemins.filter((c) => /\.(exe|dll|scr|com|bat|cmd|ps1|vbs)$/i.test(c) && c !== '_lanceur/PosSamer.exe');
}

/**
 * Fichiers à attribut Caché sous `dossier`, en chemins relatifs minuscules.
 * Windows seulement (`dir /a:h /s /b`) ; ailleurs, ensemble vide.
 */
export function fichiersCaches(dossier) {
  if (process.platform !== 'win32') return new Set();
  const r = spawnSync('cmd.exe', ['/d', '/c', 'dir', '/a:h-d', '/s', '/b', dossier], { encoding: 'utf8', windowsHide: true });
  const racine = path.resolve(dossier).toLowerCase();
  return new Set(
    String(r.stdout ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.toLowerCase().startsWith(racine))
      .map((l) => path.relative(racine, l.toLowerCase()).split(path.sep).join('/')),
  );
}

/** Chemin de MpCmdRun.exe s'il existe. */
export function trouverDefender() {
  const candidats = [
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Windows Defender', 'MpCmdRun.exe'),
  ];
  const plateforme = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Microsoft', 'Windows Defender', 'Platform');
  try {
    for (const v of fs.readdirSync(plateforme).sort().reverse()) candidats.unshift(path.join(plateforme, v, 'MpCmdRun.exe'));
  } catch {
    // Pas de dossier de plateforme : on garde l'emplacement classique.
  }
  return candidats.find((c) => fs.existsSync(c)) ?? null;
}

/**
 * Analyse Defender d'un dossier, SANS remédiation (on veut savoir, pas que
 * Defender déplace des fichiers pendant qu'on archive). Code 0 = propre,
 * 2 = menace trouvée. `{ disponible: false }` si Defender est absent.
 */
export function scanDefender(dossier) {
  const exe = trouverDefender();
  if (!exe) return { disponible: false, propre: null, sortie: '' };
  const r = spawnSync(exe, ['-Scan', '-ScanType', '3', '-File', dossier, '-DisableRemediation'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60 * 60 * 1000,
  });
  return { disponible: true, propre: r.status === 0, code: r.status, sortie: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}
