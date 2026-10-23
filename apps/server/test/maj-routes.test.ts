/**
 * Routes de la mise à jour à distance (contrat § 5) : jeton du lanceur,
 * mode arrêt / validation (503 sauf /api/sante* et /api/maj/*), attente des
 * requêtes en cours, version qui tourne, bandeau et « Pas maintenant ».
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { auditLog } from '../src/db/schema/index.js';
import { etatMode } from '../src/modules/maj/mode.js';
import { moteurMajDuSite } from '../src/modules/maj/moteur.js';
import { PIN_CAISSIER, PIN_MANAGER, resetDonnees, seConnecter, type Donnees } from './aide.js';

const JETON = 'jeton-de-test-du-lanceur-0123456789';
const racine = mkdtempSync(join(tmpdir(), 'pos-majroutes-'));
let app: FastifyInstance;
let donnees: Donnees;
const diffusions: string[] = [];

const p2 = (n: number) => String(n).padStart(2, '0');

/** Version prête dont l'heure d'installation tombe dans 5 minutes : bandeau affiché. */
function preparerVersionDans5Minutes(): void {
  const maintenant = new Date();
  const heure = new Date(maintenant.getTime() + 5 * 60_000);
  mkdirSync(join(racine, 'maj'), { recursive: true });
  writeFileSync(
    join(racine, 'maj', 'etat.json'),
    JSON.stringify({
      format: 1,
      pret: {
        numero: 2026102401,
        version: '2026.10.24-1',
        dossier: 'maj/pret/2026102401/app',
        pret_le: new Date(maintenant.getTime() - 3600_000).toISOString(),
        manifeste: '{}',
        signature: 'x',
        dependances: null,
      },
      reglages: {
        type_site: 'H24',
        heure_installation: `${p2(heure.getUTCHours())}:${p2(heure.getUTCMinutes())}`,
        heure_filet: '05:00',
        pause: false,
        installer_maintenant: null,
        reessayer: null,
      },
      report: null,
      jetons_traites: { installer_maintenant: null, reessayer: null },
    }),
  );
}

beforeAll(async () => {
  process.env.POS_RACINE = racine;
  process.env.POS_JETON_LANCEUR = JETON;
  donnees = await resetDonnees();
  app = await construireApp();
  await moteurMajDuSite((t) => diffusions.push(t));
});

afterEach(() => {
  etatMode.mode = 'NORMAL';
});

afterAll(async () => {
  delete process.env.POS_RACINE;
  delete process.env.POS_JETON_LANCEUR;
  await app.close();
  await fermerDb();
  rmSync(racine, { recursive: true, force: true });
});

describe('routes du lanceur', () => {
  it('version qui tourne', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/sante/version' });
    expect(rep.statusCode).toBe(200);
    expect(rep.json()).toMatchObject({ numero: expect.any(Number), version: expect.any(String) });
  });

  it('sans le bon jeton, les routes du lanceur n’existent pas', async () => {
    for (const headers of [{}, { 'x-jeton-lanceur': 'mauvais' }]) {
      const rep = await app.inject({ method: 'POST', url: '/api/maj/lanceur/arret', headers });
      expect(rep.statusCode).toBe(404);
    }
    expect(etatMode.mode).toBe('NORMAL');
  });

  it('arrêt : 503 « Mise à jour en cours » sur l’API, santé et maj toujours servies', async () => {
    const rep = await app.inject({ method: 'POST', url: '/api/maj/lanceur/arret', headers: { 'x-jeton-lanceur': JETON } });
    expect(rep.statusCode).toBe(200);
    expect(etatMode.mode).toBe('ARRET');
    const api = await app.inject({ method: 'GET', url: '/api/auth/moi' });
    expect(api.statusCode).toBe(503);
    expect(api.json().erreur).toMatch(/Mise à jour en cours/);
    expect((await app.inject({ method: 'GET', url: '/api/sante' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/maj/etat' })).json()).toMatchObject({ mode: 'ARRET' });
  });

  it('arrêt : attend la fin des requêtes déjà commencées', async () => {
    etatMode.entrer(); // un paiement en cours
    let fini = false;
    setTimeout(() => {
      fini = true;
      etatMode.sortir();
    }, 150);
    const rep = await app.inject({ method: 'POST', url: '/api/maj/lanceur/arret', headers: { 'x-jeton-lanceur': JETON } });
    expect(fini).toBe(true);
    expect(rep.json()).toMatchObject({ ok: true, requetes_terminees: true });
  });

  it('mode validation : aucune vente possible, puis sortie par le lanceur', async () => {
    etatMode.mode = 'VALIDATION';
    let demarrees = 0;
    etatMode.quandNormal(() => (demarrees += 1));
    expect(demarrees).toBe(0);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { utilisateur_id: donnees.caissier_id, pin: PIN_CAISSIER } });
    expect(login.statusCode).toBe(503);
    diffusions.length = 0;
    const rep = await app.inject({ method: 'POST', url: '/api/maj/lanceur/valider', headers: { 'x-jeton-lanceur': JETON } });
    expect(rep.json()).toMatchObject({ ok: true, mode: 'NORMAL' });
    expect(demarrees).toBe(1);
    // Rejouer la validation ne relance rien.
    await app.inject({ method: 'POST', url: '/api/maj/lanceur/valider', headers: { 'x-jeton-lanceur': JETON } });
    expect(demarrees).toBe(1);
  });
});

describe('bandeau de la caisse et « Pas maintenant »', () => {
  it('rien de prévu : pas de décision', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/maj/etat' });
    expect(rep.statusCode).toBe(200);
    expect(rep.json()).toMatchObject({ etat: 'A_JOUR', prete: null, decision: null });
  });

  it('report : PIN gérant obligatoire, une seule fois, tracé dans l’audit', async () => {
    preparerVersionDans5Minutes();
    const etat = (await app.inject({ method: 'GET', url: '/api/maj/etat' })).json();
    expect(etat.decision).toMatchObject({ action: 'AVERTIR', report_possible: true });

    const anonyme = await app.inject({ method: 'POST', url: '/api/maj/reporter', payload: { pin_manager: PIN_MANAGER } });
    expect(anonyme.statusCode).toBe(401);

    const cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
    const mauvais = await app.inject({ method: 'POST', url: '/api/maj/reporter', cookies, payload: { pin_manager: PIN_CAISSIER } });
    expect(mauvais.statusCode).toBe(403);

    const rep = await app.inject({ method: 'POST', url: '/api/maj/reporter', cookies, payload: { pin_manager: PIN_MANAGER } });
    expect(rep.statusCode).toBe(200);
    expect(rep.json()).toMatchObject({ etat: 'REPORTEE', decision: { report_possible: false } });
    expect(diffusions).toContain('maj');

    const encore = await app.inject({ method: 'POST', url: '/api/maj/reporter', cookies, payload: { pin_manager: PIN_MANAGER } });
    expect(encore.statusCode).toBe(409);
    expect(encore.json().erreur).toMatch(/déjà été reportée/);

    const audit = await db.select().from(auditLog).where(eq(auditLog.action, 'REPORT_MAJ'));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.user_id).toBe(donnees.manager_id);
    expect(audit[0]!.meta).toMatchObject({ version: '2026.10.24-1' });
  });
});
