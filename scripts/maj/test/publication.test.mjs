// Tests de l'outil de publication (lot L2) — sans réseau, sans base, sans pnpm.
//   node --test "scripts/maj/test/*.test.mjs"
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClientSiege, lireEnvConsole } from '../lib/cloud.mjs';
import { executablesApp, suspectsGrenam, TAILLE_GRENAM } from '../lib/integrite.mjs';
import { comparerAuxSites, controlerJournal, instructionsDestructives, lireJournal } from '../lib/migrations.mjs';
import { numeroDe, prochaineVersion } from '../lib/numero.mjs';
import {
  dependancesInternes,
  exclusionApp,
  exclusionDependances,
  listerFichiers,
  materialiserPaquetsInternes,
  retirerSansSuivre,
} from '../lib/selection.mjs';

function dossierTemporaire() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pos-publier-test-'));
}
function ecrire(racine, rel, contenu = 'x') {
  const p = path.join(racine, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, contenu);
}

describe('fichiers du paquet APP (plan § 2)', () => {
  test('exclus : secrets, données, outils hors poste', () => {
    for (const c of [
      '.env',
      'apps/server/.env',
      'apps/server/.env.avant-sync',
      '.git/config',
      'node_modules/fastify/package.json',
      'data/pgdata/PG_VERSION',
      'runtime/node/node.exe',
      'apps/siege/src/App.tsx',
      'supabase/functions/maj/index.ts',
      'docs/PLAN_MAJ_A_DISTANCE.md',
      '.claude/worktrees/x',
      'publications/2026102401/manifeste.json',
      'apps/desktop/release/PosSamer.exe',
      'apps/caisse/node_modules/.vite/deps/x.js',
      'apps/server/server.log',
    ]) {
      assert.notEqual(exclusionApp(c), null, c);
    }
  });

  test('inclus : le code des postes et les copies @pos des apps', () => {
    for (const c of [
      'VERSION.json',
      'package.json',
      'pnpm-lock.yaml',
      'apps/server/src/index.ts',
      'apps/server/drizzle/0043_stock_plats_reference.sql',
      'apps/caisse/dist/index.html',
      'apps/desktop/maj/manifeste.cjs',
      'apps/kds/node_modules/@pos/shared/src/index.ts',
      'apps/serveur/node_modules/idb/build/index.js',
      'packages/shared-ui/node_modules/@pos/shared/package.json',
      'sql/schema.sql',
    ]) {
      assert.equal(exclusionApp(c), null, c);
    }
  });

  test('paquet DEPENDANCES : node_modules racine sans electron ni outils de build', () => {
    assert.equal(exclusionDependances('node_modules/fastify/package.json'), null);
    assert.notEqual(exclusionDependances('node_modules/electron/dist/electron.exe'), null);
    assert.notEqual(exclusionDependances('node_modules/app-builder-bin/win/x64/app-builder.exe'), null);
    assert.notEqual(exclusionDependances('node_modules/.bin/tsc.cmd'), null);
    assert.notEqual(exclusionDependances('apps/server/node_modules/x'), null);
  });

  test('parcours : exclusions appliquées, liens refusés', () => {
    const r = dossierTemporaire();
    ecrire(r, 'apps/server/src/a.ts');
    ecrire(r, '.env', 'SECRET');
    ecrire(r, 'docs/x.md');
    ecrire(r, 'VERSION.json', '{}');
    assert.deepEqual(listerFichiers(r, exclusionApp), ['VERSION.json', 'apps/server/src/a.ts']);
    // Une jonction vers un dossier EXCLU (node_modules racine) n'est pas parcourue…
    const cible = dossierTemporaire();
    ecrire(cible, 'fastify/index.js');
    fs.symlinkSync(cible, path.join(r, 'node_modules'), 'junction');
    assert.deepEqual(listerFichiers(r, exclusionApp), ['VERSION.json', 'apps/server/src/a.ts']);
    // …mais une jonction RETENUE est une erreur : sur les sites ce sont des copies.
    fs.symlinkSync(cible, path.join(r, 'apps', 'server', 'lien'), 'junction');
    assert.throws(() => listerFichiers(r, exclusionApp), /Liens symboliques/);
    // Retirer la jonction ne touche pas à sa cible.
    retirerSansSuivre(path.join(r, 'apps', 'server', 'lien'));
    retirerSansSuivre(path.join(r, 'node_modules'));
    assert.ok(fs.existsSync(path.join(cible, 'fastify', 'index.js')));
  });

  test('copies @pos matérialisées depuis packages/ du commit (incident du 22/10)', () => {
    const r = dossierTemporaire();
    ecrire(r, 'packages/shared/package.json', JSON.stringify({ name: '@pos/shared' }));
    ecrire(r, 'packages/shared/src/index.ts', 'export const v = 2;');
    ecrire(r, 'packages/shared/node_modules/zod/index.js');
    ecrire(r, 'packages/shared-ui/package.json', JSON.stringify({ name: '@pos/shared-ui', dependencies: { '@pos/shared': 'workspace:*' } }));
    ecrire(r, 'apps/kds/package.json', JSON.stringify({ dependencies: { '@pos/shared': 'workspace:*', react: '^18' } }));
    // Copie périmée laissée par une ancienne installation.
    ecrire(r, 'apps/kds/node_modules/@pos/shared/src/index.ts', 'export const v = 1;');
    ecrire(r, 'apps/kds/node_modules/@pos/shared/src/supprime.ts', 'vieux');
    const faits = materialiserPaquetsInternes(r);
    assert.deepEqual(faits, ['packages/shared-ui → @pos/shared', 'apps/kds → @pos/shared']);
    assert.equal(fs.readFileSync(path.join(r, 'apps/kds/node_modules/@pos/shared/src/index.ts'), 'utf8'), 'export const v = 2;');
    assert.equal(fs.existsSync(path.join(r, 'apps/kds/node_modules/@pos/shared/src/supprime.ts')), false);
    assert.equal(fs.existsSync(path.join(r, 'apps/kds/node_modules/@pos/shared/node_modules')), false);
    assert.deepEqual(dependancesInternes({ dependencies: { '@pos/b': '1' }, devDependencies: { '@pos/a': '1', x: '1' } }), ['a', 'b']);
  });
});

describe('migrations drizzle', () => {
  const j = (...e) => e.map(([idx, tag, when]) => ({ idx, tag, when }));
  const base = j([0, '0000_init', 100], [1, '0001_ajout', 200]);

  test('journal cohérent', () => {
    assert.deepEqual(controlerJournal(base, ['0000_init.sql', '0001_ajout.sql']), []);
    assert.deepEqual(lireJournal(JSON.stringify({ entries: [{ idx: 0, tag: '0000_init', when: 1, breakpoints: true }] })), j([0, '0000_init', 1]));
  });

  test('piège de renumérotation : when non croissant, tag mal préfixé, fichier orphelin', () => {
    const p = controlerJournal(j([0, '0000_init', 100], [1, '0039_renumerote', 50]), ['0000_init.sql', '0039_renumerote.sql', '0002_oubli.sql']);
    assert.ok(p.some((x) => /0039_renumerote.*when 50/.test(x)));
    assert.ok(p.some((x) => /ne commence pas par 0001_/.test(x)));
    assert.ok(p.some((x) => /0002_oubli\.sql n'est pas dans le journal/.test(x)));
  });

  test('comparaison à la version des sites', () => {
    const courant = [...base, ...j([2, '0002_nouvelle', 300])];
    const sql = (t) => `-- ${t}`;
    const ok = comparerAuxSites(base, courant, sql, sql);
    assert.deepEqual(ok, { nouvelles: ['0002_nouvelle'], problemes: [] });
    const modifiee = comparerAuxSites(base, courant, sql, (t) => (t === '0001_ajout' ? 'ALTER …' : sql(t)));
    assert.match(modifiee.problemes[0], /0001_ajout.*modifiée/);
    // CRLF ↔ LF : pas une modification.
    assert.deepEqual(comparerAuxSites(base, courant, (t) => `a\nb${t}`, (t) => `a\r\nb${t}`).problemes, []);
    const avant = comparerAuxSites(base, [...base, ...j([2, '0002_tard', 150])], sql, sql);
    assert.match(avant.problemes[0], /jamais appliquée/);
    assert.match(comparerAuxSites(base, j([0, '0000_init', 100]), sql, sql).problemes[0], /disparue/);
  });

  test('« ajouter d’abord » : DROP de table/colonne et RENAME repérés, le reste toléré', () => {
    const sql = `
      -- DROP TABLE dans un commentaire : ignoré
      ALTER TABLE "paiements" DROP CONSTRAINT IF EXISTS "x";
      DROP TRIGGER IF EXISTS t ON a;
      DROP INDEX IF EXISTS i;
      ALTER TABLE a ALTER COLUMN b DROP DEFAULT;
      ALTER TABLE a ALTER COLUMN b DROP NOT NULL;
      COMMENT ON TABLE a IS 'on ne DROP rien ici';
    `;
    assert.deepEqual(instructionsDestructives(sql), []);
    const d = instructionsDestructives('ALTER TABLE a DROP COLUMN b;\nDROP TABLE "vieille";\nALTER TABLE a RENAME COLUMN c TO d;\nALTER TABLE a DROP e;');
    assert.equal(d.length, 4);
  });
});

describe('anti-Grenam', () => {
  test('taille du ver, copie « g » d’un exécutable, exécutable caché', () => {
    const s = suspectsGrenam(
      [
        { chemin: 'node_modules/esbuild/esbuild.exe', taille: TAILLE_GRENAM },
        { chemin: 'node_modules/x/node.exe', taille: 10 },
        { chemin: 'node_modules/x/gnode.exe', taille: 10 },
        { chemin: 'node_modules/y/gros.exe', taille: 10 },
        { chemin: 'node_modules/z/gentil.js', taille: 10 },
      ],
      new Set(['node_modules/y/gros.exe']),
    );
    assert.equal(s.length, 3);
    assert.deepEqual(suspectsGrenam([{ chemin: 'apps/a.js', taille: 12 }]), []);
  });

  test('aucun exécutable dans le paquet APP', () => {
    assert.deepEqual(executablesApp(['apps/a.js', 'scripts/x.ps1', 'deploy/a.bat', 'b.exe', 'c.DLL', '_lanceur/PosSamer.exe']), ['b.exe', 'c.DLL']);
  });
});

describe('numéro de version', () => {
  const d = new Date('2026-10-24T09:00:00Z');
  test('AAAAMMJJnn et rang suivant du jour', () => {
    assert.equal(numeroDe(d, 1), 2026102401);
    assert.deepEqual(prochaineVersion(d, []), { numero: 2026102401, version: '2026.10.24-1', rang: 1 });
    assert.deepEqual(prochaineVersion(d, [2026102301, 2026102402]), { numero: 2026102403, version: '2026.10.24-3', rang: 3 });
  });
  test('refuse de ne pas dépasser le dernier publié', () => {
    assert.throws(() => prochaineVersion(d, [2026102501]), /ne dépasse pas/);
    assert.throws(() => prochaineVersion(d, [2026102402], 2), /ne dépasse pas/);
    assert.throws(() => numeroDe(d, 100), /Rang/);
  });
});

describe('envoi par la console du siège', () => {
  test('lit l’adresse et la clé anon dans le .env de la console', () => {
    assert.deepEqual(lireEnvConsole('VITE_SUPABASE_URL=https://x.supabase.co\nVITE_SUPABASE_ANON_KEY="abc"\n'), {
      url: 'https://x.supabase.co',
      cleAnon: 'abc',
    });
  });

  test('connexion, préparation, dépôt (manifeste en dernier), enregistrement', async () => {
    const appels = [];
    const faux = async (url, init) => {
      appels.push({ url, methode: init.method, corps: init.body && typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
      const rep = (obj, status = 200) => ({ ok: status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) });
      if (url.includes('/auth/v1/token')) return rep({ access_token: 'jeton', refresh_token: 'r', expires_in: 3600 });
      if (url.endsWith('/functions/v1/siege')) {
        const corps = JSON.parse(init.body);
        if (corps.action === 'maj_preparer_envoi') return rep({ fichiers: corps.fichiers.map((nom) => ({ nom, url: `https://depot/${nom}` })) });
        if (corps.action === 'maj_enregistrer') return rep({ ok: true, cle: 'actuelle' });
        return rep({ erreur: 'Action réservée au propriétaire' }, 403);
      }
      return rep({});
    };
    const c = new ClientSiege({ url: 'https://x.supabase.co/', cleAnon: 'anon', fetch: faux });
    await c.connecter('a@b.c', 'mdp');
    const r = await c.envoyerPaquet({ type: 'APP', numero: 2026102401 }, [
      { nom: 'manifeste.json', lire: () => Buffer.from('m') },
      { nom: 'manifeste.json.sig', lire: () => Buffer.from('s') },
      { nom: 'code.tar.gz.000', lire: () => Buffer.from('0') },
    ]);
    assert.deepEqual(r, { ok: true, cle: 'actuelle' });
    const depots = appels.filter((a) => a.methode === 'PUT').map((a) => a.url);
    assert.deepEqual(depots, ['https://depot/code.tar.gz.000', 'https://depot/manifeste.json', 'https://depot/manifeste.json.sig']);
    assert.equal(appels[0].corps.password, 'mdp');
    await assert.rejects(c.siege('autre'), /propriétaire/);
  });
});
