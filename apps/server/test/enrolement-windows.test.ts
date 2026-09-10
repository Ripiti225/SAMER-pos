import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('enrôlement Windows', () => {
  it('impose le rôle PostgreSQL local avant de lancer le script Node', async () => {
    const chemin = resolve(process.cwd(), '../../deploy/windows/enroler-ce-poste.bat');
    const bat = await readFile(chemin, 'utf8');
    const connexion = 'set "DATABASE_URL=postgres://postgres@localhost:5432/pos_samer"';
    const lancement = 'node "..\\..\\node_modules\\tsx\\dist\\cli.mjs" "src\\scripts\\enroler-site.ts"';

    expect(bat).toContain(connexion);
    expect(bat.indexOf(connexion)).toBeLessThan(bat.indexOf(lancement));
  });
});
