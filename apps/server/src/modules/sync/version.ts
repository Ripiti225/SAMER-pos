/**
 * Version du code qui tourne sur ce poste — envoyée au siège avec le battement
 * de cœur. Prérequis de la future mise à jour à distance : on ne met pas à jour
 * un site dont on ne sait pas ce qu'il fait tourner.
 *
 * Ordre de lecture :
 *  1. `POS_VERSION` (variable d'environnement) — pour un paquet livré sans
 *     dépôt git, ou un numéro choisi par l'installateur ;
 *  2. `VERSION.json` à la racine de `app/` — posé par chaque paquet de mise à
 *     jour à distance (AAAA.MM.JJ-n), il fait foi sur un site mis à jour ;
 *  3. le commit du dépôt, lu DIRECTEMENT dans `.git` : `git` n'est pas installé
 *     sur les mini-PC (seuls Node et PostgreSQL portables le sont) ;
 *  4. rien : le siège affichera « version inconnue » plutôt qu'un faux numéro.
 *
 * Lue UNE fois puis gardée en mémoire : c'est la version DÉMARRÉE qui compte.
 * Un `git pull` sans redémarrage change `.git` mais pas le code qui tourne.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface VersionCode {
  /** Ce que le siège affiche : commit court, ou POS_VERSION. */
  version_code: string | null;
  /** Commit complet (40 caractères), null si inconnu. */
  commit_git: string | null;
}

const RE_COMMIT = /^[0-9a-f]{40}$/;

function lire(chemin: string): string | null {
  try {
    return readFileSync(chemin, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Dossier git réel. Dans un worktree (ou un sous-module), `.git` est un FICHIER
 * « gitdir: … » ; les refs partagées vivent alors dans le dossier `commondir`.
 */
function dossiersGit(racine: string): { gitdir: string; commun: string } | null {
  const point = join(racine, '.git');
  if (!existsSync(point)) return null;
  let gitdir = point;
  if (statSync(point).isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(lire(point) ?? '');
    if (!m) return null;
    gitdir = isAbsolute(m[1]!.trim()) ? m[1]!.trim() : resolve(racine, m[1]!.trim());
  }
  const commondir = lire(join(gitdir, 'commondir'));
  const commun = commondir ? resolve(gitdir, commondir) : gitdir;
  return { gitdir, commun };
}

/** Commit de HEAD, sans lancer `git`. */
export function lireCommit(racine: string): string | null {
  const dossiers = dossiersGit(racine);
  if (!dossiers) return null;
  const head = lire(join(dossiers.gitdir, 'HEAD'));
  if (!head) return null;
  if (RE_COMMIT.test(head)) return head; // HEAD détachée
  const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim();
  if (!ref) return null;
  for (const base of [dossiers.gitdir, dossiers.commun]) {
    const sha = lire(join(base, ref));
    if (sha && RE_COMMIT.test(sha)) return sha;
  }
  // Ref compactée (`git gc`) : elle n'existe plus qu'en ligne de packed-refs.
  const packed = lire(join(dossiers.commun, 'packed-refs')) ?? '';
  for (const ligne of packed.split('\n')) {
    const [sha, nom] = ligne.trim().split(' ');
    if (nom === ref && sha && RE_COMMIT.test(sha)) return sha;
  }
  return null;
}

/** Remonte depuis `depart` jusqu'au premier dossier qui porte un `.git`. */
export function trouverRacineDepot(depart: string, niveaux = 8): string | null {
  let dossier = resolve(depart);
  for (let i = 0; i < niveaux; i++) {
    if (existsSync(join(dossier, '.git'))) return dossier;
    const parent = dirname(dossier);
    if (parent === dossier) return null;
    dossier = parent;
  }
  return null;
}

/** VERSION.json le plus proche en remontant depuis `depart` (paquet de mise à jour). */
export function lireFichierVersion(depart: string, niveaux = 8): { version: string; commit: string | null } | null {
  let dossier = resolve(depart);
  for (let i = 0; i < niveaux; i++) {
    const brut = lire(join(dossier, 'VERSION.json'));
    if (brut) {
      try {
        const v = JSON.parse(brut.replace(/^﻿/, '')) as { version?: unknown; commit?: unknown };
        if (typeof v.version === 'string' && /^\d{4}\.\d{2}\.\d{2}-\d+$/.test(v.version)) {
          return { version: v.version, commit: typeof v.commit === 'string' ? v.commit : null };
        }
      } catch {
        /* illisible : on continue avec git */
      }
      return null;
    }
    const parent = dirname(dossier);
    if (parent === dossier) return null;
    dossier = parent;
  }
  return null;
}

/** Calcule la version (sans cache) — exposée pour les tests. */
export function calculerVersion(
  depart: string,
  env: Record<string, string | undefined> = process.env,
): VersionCode {
  const racine = trouverRacineDepot(depart);
  const commit = racine ? lireCommit(racine) : null;
  const forcee = env.POS_VERSION?.trim();
  const fichier = lireFichierVersion(depart);
  const commitFichier = fichier?.commit && RE_COMMIT.test(fichier.commit) ? fichier.commit : null;
  return {
    version_code: forcee || fichier?.version || (commit ? commit.slice(0, 7) : null),
    commit_git: commit ?? commitFichier,
  };
}

let enCache: VersionCode | null = null;

/** Version du code démarré (lue au premier appel, puis gardée). */
export function versionCode(): VersionCode {
  if (!enCache) {
    try {
      enCache = calculerVersion(dirname(fileURLToPath(import.meta.url)));
    } catch {
      enCache = { version_code: process.env.POS_VERSION?.trim() || null, commit_git: null };
    }
  }
  return enCache;
}
