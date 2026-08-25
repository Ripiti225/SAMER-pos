/**
 * GARDE-FOU — API réservées au contexte sécurisé, interdites dans les PWA.
 *
 * `crypto.randomUUID()` et `crypto.subtle` n'existent QUE dans une page servie
 * en https ou depuis localhost. Les terminaux (caisse, tablette serveur,
 * téléphone client via QR, KDS) ouvrent l'app en `http://IP-LAN` : ces API y
 * sont ABSENTES, et l'appel lève une TypeError. Placé dans un updater React,
 * l'appel est rejoué pendant le rendu — l'arbre est démonté, écran BLANC en
 * plein service. Le piège s'est déjà refermé trois fois.
 *
 * Le remplaçant est `uuidLocal()` (@pos/shared), qui s'appuie sur
 * `crypto.getRandomValues()`, disponible partout.
 *
 * apps/server est exclu : il tourne sous Node, où ces API sont toujours là.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PWA = ['caisse', 'serveur', 'client', 'kds'];
const INTERDITS = ['crypto.randomUUID', 'crypto.subtle'];

function sources(dossier: string): string[] {
  let out: string[] = [];
  for (const e of readdirSync(dossier)) {
    const p = path.join(dossier, e);
    if (statSync(p).isDirectory()) out = out.concat(sources(p));
    else if (/\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

/** Les commentaires ont le droit de NOMMER le piège : seul le code compte. */
function sansCommentaires(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('Contexte non sécurisé (http://IP-LAN)', () => {
  it('aucune PWA n’appelle une API réservée au contexte sécurisé', () => {
    const fautes: string[] = [];
    for (const app of PWA) {
      const src = path.join(RACINE, 'apps', app, 'src');
      for (const fichier of sources(src)) {
        const code = sansCommentaires(readFileSync(fichier, 'utf8'));
        code.split('\n').forEach((ligne, i) => {
          for (const interdit of INTERDITS) {
            if (ligne.includes(interdit)) {
              fautes.push(
                `${path.relative(RACINE, fichier)}:${i + 1} → ${interdit} ` +
                  `(absent en http://IP-LAN ; utiliser uuidLocal() de @pos/shared)`,
              );
            }
          }
        });
      }
    }
    expect(fautes, `\n${fautes.join('\n')}\n`).toEqual([]);
  });

  it('uuidLocal() produit un UUID v4 accepté par z.string().uuid()', async () => {
    const { uuidLocal } = await import('@pos/shared');
    const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const tirages = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const u = uuidLocal();
      expect(u).toMatch(v4);
      tirages.add(u);
    }
    expect(tirages.size, 'collision sur 1000 tirages').toBe(1000);
  });
});
