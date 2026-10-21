/**
 * Battement de cœur (2026-10-21) — ce que le site dit de lui-même au siège
 * pour l'écran « Santé des sites » : version du code, ventes en attente,
 * dernière descente (règle des 24 h des points), dernière erreur.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, fermerDb } from '../src/db/client.js';
import { syncEtat, syncOutbox } from '../src/db/schema/index.js';
import { construireBattement, derniereDescente } from '../src/modules/sync/battement.js';
import { ClientCloud } from '../src/modules/sync/cloud-client.js';
import { tirerCatalogue } from '../src/modules/sync/descente.js';
import { etatSync } from '../src/modules/sync/etat.js';
import { calculerVersion, lireCommit } from '../src/modules/sync/version.js';
import { resetDonnees } from './aide.js';

const SHA = '3ff10db0123456789abcdef0123456789abcdef0';
const SHA2 = 'b325e12aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const temporaires: string[] = [];
function dossierTemp(): string {
  const d = mkdtempSync(join(tmpdir(), 'pos-version-'));
  temporaires.push(d);
  return d;
}

describe('version du code, lue sans lancer git', () => {
  afterAll(() => {
    for (const d of temporaires) rmSync(d, { recursive: true, force: true });
  });

  it('suit la branche de HEAD jusqu’à son commit', () => {
    const racine = dossierTemp();
    mkdirSync(join(racine, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(racine, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(racine, '.git', 'refs', 'heads', 'main'), `${SHA}\n`);
    expect(lireCommit(racine)).toBe(SHA);
  });

  it('lit une ref compactée dans packed-refs', () => {
    const racine = dossierTemp();
    mkdirSync(join(racine, '.git'), { recursive: true });
    writeFileSync(join(racine, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(racine, '.git', 'packed-refs'), `# pack-refs with: peeled\n${SHA2} refs/heads/main\n`);
    expect(lireCommit(racine)).toBe(SHA2);
  });

  it('suit un worktree (.git est un fichier gitdir)', () => {
    const principal = dossierTemp();
    const gitdir = join(principal, '.git', 'worktrees', 'wt');
    mkdirSync(join(principal, '.git', 'refs', 'heads'), { recursive: true });
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/branche\n');
    writeFileSync(join(gitdir, 'commondir'), '../..\n');
    writeFileSync(join(principal, '.git', 'refs', 'heads', 'branche'), `${SHA}\n`);
    const wt = dossierTemp();
    writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`);
    expect(lireCommit(wt)).toBe(SHA);
  });

  it('remonte depuis un sous-dossier ; POS_VERSION prime pour l’affichage', () => {
    const racine = dossierTemp();
    mkdirSync(join(racine, '.git'), { recursive: true });
    writeFileSync(join(racine, '.git', 'HEAD'), `${SHA}\n`); // HEAD détachée
    const profond = join(racine, 'apps', 'server', 'src');
    mkdirSync(profond, { recursive: true });

    expect(calculerVersion(profond, {})).toEqual({ version_code: '3ff10db', commit_git: SHA });
    expect(calculerVersion(profond, { POS_VERSION: '2026.10.21' })).toEqual({
      version_code: '2026.10.21',
      commit_git: SHA,
    });
  });

  it('sans dépôt ou ref cassée : version inconnue plutôt qu’un faux numéro', () => {
    expect(lireCommit(dossierTemp())).toBeNull();

    // Branche jamais commitée (ref absente) : rien d'inventé non plus.
    const casse = dossierTemp();
    mkdirSync(join(casse, '.git'), { recursive: true });
    writeFileSync(join(casse, '.git', 'HEAD'), 'ref: refs/heads/nulle-part\n');
    expect(lireCommit(casse)).toBeNull();
    expect(calculerVersion(casse, {})).toEqual({ version_code: null, commit_git: null });
  });
});

describe('battement de cœur du site', () => {
  let serveur: Server;
  let url = '';
  let dernierCorps: Record<string, unknown> | null = null;

  beforeAll(async () => {
    await resetDonnees();
    serveur = createServer((req, res) => {
      let corps = '';
      req.on('data', (c) => (corps += c));
      req.on('end', () => {
        dernierCorps = JSON.parse(corps || '{}');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}'); // aucune ligne à descendre
      });
    });
    await new Promise<void>((r) => serveur.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => serveur.close(() => r()));
    await fermerDb();
  });

  afterEach(async () => {
    await db.delete(syncOutbox);
    await db.delete(syncEtat);
    Object.assign(etatSync, { derniere_erreur: null, erreur_descente: null, dernier_acquittement: null });
    dernierCorps = null;
  });

  it('compte les ventes en attente et date la plus ancienne', async () => {
    const ancienne = new Date('2026-10-20T07:00:00Z');
    await db.insert(syncOutbox).values([
      { table_name: 'commandes', record_id: randomUUID(), operation: 'INSERT', payload: {}, created_at: ancienne },
      { table_name: 'commandes', record_id: randomUUID(), operation: 'INSERT', payload: {} },
      // Déjà acquittée : ne compte pas.
      { table_name: 'commandes', record_id: randomUUID(), operation: 'INSERT', payload: {}, synced_at: new Date() },
    ]);

    const b = await construireBattement();
    expect(b.lignes_en_attente).toBe(2);
    expect(b.plus_ancienne_en_attente).toBe(ancienne.toISOString());
    expect(b.derniere_descente).toBeNull(); // jamais descendu : points bloqués sur le site
    expect(b.heure_site).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('rapporte la même dernière descente que la règle des 24 h des points', async () => {
    const t1 = new Date('2026-10-21T08:00:00Z');
    const t2 = new Date('2026-10-21T08:05:00Z');
    await db.insert(syncEtat).values([
      { flux: 'CATALOGUE', version: 3, synced_at: t1 },
      { flux: 'PROMOTIONS', version: 1, synced_at: t2 },
      { flux: 'NOTES', version: 0, synced_at: null },
    ]);
    expect((await derniereDescente())?.toISOString()).toBe(t2.toISOString());
    expect((await construireBattement()).derniere_descente).toBe(t2.toISOString());
  });

  it('erreur de montée d’abord, sinon celle de la descente', async () => {
    etatSync.echecDescente('Cloud injoignable (sync-pull)');
    expect((await construireBattement()).derniere_erreur).toBe('Descente du catalogue : Cloud injoignable (sync-pull)');
    etatSync.derniere_erreur = 'Le cloud a refusé commandes (seq 4) : contrainte';
    expect((await construireBattement()).derniere_erreur).toBe('Le cloud a refusé commandes (seq 4) : contrainte');
    etatSync.succesDescente();
    expect(etatSync.erreur_descente).toBeNull();
  });

  it('voyage avec la descente, et seulement s’il existe', async () => {
    const client = new ClientCloud(url, 'cle-de-test-1234567890');

    const b = await construireBattement();
    await tirerCatalogue(client, b);
    expect(dernierCorps?.sante).toEqual(JSON.parse(JSON.stringify(b)));
    expect(dernierCorps?.versions).toBeTypeOf('object');

    // Battement impossible à construire : la descente part sans lui.
    await tirerCatalogue(client);
    expect(dernierCorps).not.toHaveProperty('sante');
  });
});
