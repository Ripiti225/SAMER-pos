/**
 * Mise à jour à distance, côté SERVEUR (lot L3) : consultation du cloud,
 * téléchargement (reprise, lien expiré), vérification de signature, espace
 * disque, préparation dans ROOT/maj, comptes rendus, bloc `sante.maj`.
 * Le cloud et le stockage sont simulés (fetch injecté) ; les paquets sont de
 * vrais paquets signés avec une clé jetable.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cheminsSite,
  ecrireArchive,
  genererPaire,
  serialiserManifeste,
  signer,
  type Manifeste,
} from '../src/modules/maj/fondations.js';
import { ClientMaj, type CibleMaj, type ReponseConsulter } from '../src/modules/maj/client.js';
import { MoteurMaj } from '../src/modules/maj/moteur.js';
import { REGLAGES_PAR_DEFAUT } from '../src/modules/maj/config.js';

const sha = (t: string | Buffer) => createHash('sha256').update(t).digest('hex');
const EMPREINTE = sha('lock-ancien');
const EMPREINTE2 = sha('lock-nouveau');
const INSTALLEE = { numero: 2026102301, version: '2026.10.23-1', commit: 'abc1234', dev: false };
const { clePublique, clePrivee } = genererPaire();
const TROUSSEAU = { actuelle: clePublique };

const temporaires: string[] = [];
function temp(nom: string): string {
  const d = mkdtempSync(join(tmpdir(), `pos-majsrv-${nom}-`));
  temporaires.push(d);
  return d;
}
afterAll(() => {
  for (const d of temporaires) rmSync(d, { recursive: true, force: true });
});

function ecrire(racine: string, rel: string, contenu: string) {
  const abs = join(racine, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contenu);
}

/** Paquet signé : morceaux dans un dossier, manifeste exact + signature. */
async function paquet(fichiers: Record<string, string>, base: Record<string, unknown>, cle = clePrivee) {
  const source = temp('src');
  for (const [rel, c] of Object.entries(fichiers)) ecrire(source, rel, c);
  const morceaux = temp('morceaux');
  const res = await ecrireArchive({ racine: source, chemins: Object.keys(fichiers), dossierSortie: morceaux, prefixe: 'p', tailleMorceau: 700 });
  const manifeste = { ...base, archive: res.archive, morceaux: res.morceaux, fichiers: res.fichiers } as unknown as Manifeste;
  const texte = serialiserManifeste(manifeste).toString('utf8');
  return { manifeste, texte, signature: signer(texte, cle), morceaux };
}

const BASE_APP = {
  format: 1,
  type: 'APP',
  numero: 2026102401,
  version: '2026.10.24-1',
  commit: 'bbbbbbb2',
  publie_le: '2026-10-24T03:00:00.000Z',
  lanceur_min: 1,
  node_min: '22.0.0',
  dependances: { empreinte: EMPREINTE },
  migrations: { derniere: null, nouvelles: [], retrocompatibles: true },
  notes: '',
};

function fichiersApp(): Record<string, string> {
  // Assez gros pour faire plusieurs morceaux de 700 octets.
  const gros = Array.from({ length: 400 }, (_, i) => `ligne ${i} ${sha(String(i))}`).join('\n');
  return {
    'VERSION.json': JSON.stringify({ numero: 2026102401, version: '2026.10.24-1', commit: 'bbbbbbb2' }),
    'apps/server/src/index.ts': gros,
    'apps/caisse/dist/index.html': '<html>nouveau</html>',
  };
}

/** Stockage simulé : sert les morceaux, gère Range, peut faire expirer un lien. */
class FauxStockage {
  fichiers = new Map<string, string>();
  expires = new Set<string>();
  requetes: { url: string; range: string | null }[] = [];
  coupureApres: number | null = null;

  publier(prefixe: string, dossier: string, noms: string[]) {
    return noms.map((nom) => {
      const url = `https://stockage.test/${prefixe}/${nom}?jeton=${Math.random().toString(36).slice(2)}`;
      this.fichiers.set(url, join(dossier, nom));
      return { nom, url };
    });
  }

  fetch: typeof fetch = async (entree, init) => {
    const url = String(entree);
    const range = (init?.headers as Record<string, string> | undefined)?.range ?? null;
    this.requetes.push({ url, range });
    if (this.expires.has(url)) return new Response('{"error":"InvalidJWT"}', { status: 400 });
    const chemin = this.fichiers.get(url);
    if (!chemin) return new Response('introuvable', { status: 404 });
    let octets = readFileSync(chemin);
    let statut = 200;
    if (range) {
      const debut = Number(/bytes=(\d+)-/.exec(range)![1]);
      octets = octets.subarray(debut);
      statut = 206;
    }
    if (this.coupureApres !== null) {
      // Coupure réseau : on n'envoie qu'un début, puis le flux casse.
      const n = this.coupureApres;
      this.coupureApres = null;
      let envoye = false;
      const flux = new ReadableStream({
        pull(c) {
          if (!envoye) {
            envoye = true;
            c.enqueue(new Uint8Array(octets.subarray(0, n)));
          } else c.error(new Error('connexion perdue'));
        },
      });
      return new Response(flux, { status: statut });
    }
    return new Response(new Uint8Array(octets), { status: statut });
  };
}

/** Cloud simulé : fonction `maj`, actions consulter et rapporter. */
class FauxCloud {
  rapports: { numero: number; evenement: string; detail: Record<string, unknown> }[] = [];
  consultations = 0;
  constructor(public reponse: () => ReponseConsulter) {}
  fetch: typeof fetch = async (_url, init) => {
    const corps = JSON.parse(String(init?.body));
    if (corps.action === 'consulter') {
      this.consultations += 1;
      return Response.json(this.reponse());
    }
    this.rapports.push({ numero: corps.numero, evenement: corps.evenement, detail: corps.detail });
    return Response.json({ ok: true });
  };
  evenements() {
    return this.rapports.map((r) => r.evenement);
  }
}

function site() {
  const racine = temp('site');
  ecrire(racine, 'app/VERSION.json', JSON.stringify({ numero: INSTALLEE.numero, version: INSTALLEE.version, commit: INSTALLEE.commit }));
  ecrire(racine, 'app/node_modules/.empreinte-deps', `${EMPREINTE}\n`);
  ecrire(racine, 'data/pgdata/PG_VERSION', '16\n');
  return { racine, chemins: cheminsSite(racine) };
}

interface OptionsMoteur {
  trousseau?: typeof TROUSSEAU | null;
  espace?: number | null;
  lanceur?: number;
  maintenant?: () => Date;
}

function moteur(s: ReturnType<typeof site>, cloud: FauxCloud, stockage: FauxStockage, o: OptionsMoteur = {}) {
  const diffusions: string[] = [];
  const m = new MoteurMaj({
    chemins: s.chemins,
    client: async () => new ClientMaj('https://cloud.test/functions/v1', 'cle-site', 5000, cloud.fetch),
    trousseau: () => (o.trousseau === null ? { trousseau: null, motif: 'Mise à jour désactivée : aucune clé.' } : { trousseau: o.trousseau ?? TROUSSEAU, motif: null }),
    versionInstallee: INSTALLEE,
    lanceurNumero: o.lanceur ?? 1,
    versionNode: 'v22.23.1',
    debitMax: 0,
    diffuser: (t) => diffusions.push(t),
    horloge: o.maintenant,
    mesurerEspace: async () => (o.espace === undefined ? 50 * 1024 ** 3 : o.espace),
    fetch: stockage.fetch,
    log: () => {},
  });
  return { m, diffusions };
}

async function cible(stockage: FauxStockage, options: { deps?: boolean; signature?: string; fichiers?: Record<string, string> } = {}): Promise<CibleMaj> {
  const base = options.deps ? { ...BASE_APP, dependances: { empreinte: EMPREINTE2 } } : BASE_APP;
  const p = await paquet(options.fichiers ?? fichiersApp(), base);
  let dependances: CibleMaj['dependances'] = null;
  if (options.deps) {
    const d = await paquet({ 'node_modules/fastify/index.js': 'v5', 'apps/server/node_modules/pino/index.js': 'pino' }, {
      format: 1,
      type: 'DEPENDANCES',
      empreinte: EMPREINTE2,
      publie_le: '2026-10-24T03:00:00.000Z',
      node_min: '22.0.0',
    });
    dependances = {
      empreinte: EMPREINTE2,
      manifeste: d.texte,
      signature: d.signature,
      morceaux: stockage.publier('deps', d.morceaux, d.manifeste.morceaux.map((x) => x.nom)),
    };
  }
  return {
    numero: 2026102401,
    version: '2026.10.24-1',
    manifeste: p.texte,
    signature: options.signature ?? p.signature,
    morceaux: stockage.publier('code', p.morceaux, p.manifeste.morceaux.map((x) => x.nom)),
    dependances,
  };
}

const lireEtatJson = (s: ReturnType<typeof site>) => JSON.parse(readFileSync(s.chemins.etat, 'utf8'));

describe('moteur de mise à jour — préparation', () => {
  it('télécharge, vérifie, extrait et annonce la version prête', async () => {
    const s = site();
    const stockage = new FauxStockage();
    const c = await cible(stockage);
    const cloud = new FauxCloud(() => ({ cible: c, reglages: { ...REGLAGES_PAR_DEFAUT, type_site: 'H24' } }));
    const { m, diffusions } = moteur(s, cloud, stockage);
    await m.cycle();
    const etat = lireEtatJson(s);
    expect(etat.pret).toMatchObject({ numero: 2026102401, version: '2026.10.24-1', dossier: 'maj/pret/2026102401/app', dependances: null });
    expect(etat.pret.manifeste).toBe(c.manifeste);
    expect(etat.reglages.type_site).toBe('H24');
    expect(readFileSync(join(s.racine, 'maj/pret/2026102401/app/apps/caisse/dist/index.html'), 'utf8')).toBe('<html>nouveau</html>');
    expect(existsSync(join(s.racine, 'maj/telechargement/2026102401'))).toBe(false);
    expect(cloud.evenements()).toEqual(['TELECHARGEMENT', 'PRET']);
    expect(diffusions).toContain('maj');
    expect(m.phase).toBe('PRETE');
    // Second cycle : rien n'est retéléchargé ni re-rapporté.
    const avant = stockage.requetes.length;
    await m.cycle();
    expect(stockage.requetes.length).toBe(avant);
    expect(cloud.evenements()).toEqual(['TELECHARGEMENT', 'PRET']);
    const sante = await m.blocSante();
    expect(sante).toMatchObject({ etat: 'PRETE', numero_installe: INSTALLEE.numero, numero_prete: 2026102401 });
    expect(sante.installation_prevue).not.toBeNull();
    expect(sante.espace_libre_mo).toBeGreaterThan(0);
  });

  it('reprend un téléchargement coupé (Range) sans retélécharger les morceaux complets', async () => {
    const s = site();
    const stockage = new FauxStockage();
    const c = await cible(stockage);
    const cloud = new FauxCloud(() => ({ cible: c, reglages: REGLAGES_PAR_DEFAUT }));
    // Premier morceau complet, deuxième coupé après 100 octets.
    let n = 0;
    const origine = stockage.fetch;
    stockage.fetch = async (u, i) => {
      n += 1;
      if (n === 2) stockage.coupureApres = 100;
      return origine(u, i);
    };
    const { m } = moteur(s, cloud, stockage);
    await m.cycle();
    expect(m.phase).toBe('TELECHARGEMENT');
    expect(m.derniereErreur).toMatch(/Téléchargement/);
    expect(lireEtatJson(s).pret).toBeNull();
    stockage.requetes = [];
    await m.cycle();
    expect(m.phase).toBe('PRETE');
    const deuxieme = c.morceaux[1]!.url;
    expect(stockage.requetes.find((r) => r.url === deuxieme)?.range).toBe('bytes=100-');
    expect(stockage.requetes.some((r) => r.url === c.morceaux[0]!.url)).toBe(false);
  });

  it('lien signé expiré : redemande des liens au cloud et continue', async () => {
    const s = site();
    const stockage = new FauxStockage();
    const c1 = await cible(stockage);
    for (const x of c1.morceaux) stockage.expires.add(x.url);
    const c2: CibleMaj = { ...c1, morceaux: stockage.publier('code', dirname(stockage.fichiers.get(c1.morceaux[0]!.url)!), c1.morceaux.map((x) => x.nom)) };
    let appel = 0;
    const cloud = new FauxCloud(() => ({ cible: appel++ === 0 ? c1 : c2, reglages: REGLAGES_PAR_DEFAUT }));
    const { m } = moteur(s, cloud, stockage);
    await m.cycle();
    expect(cloud.consultations).toBe(2);
    expect(m.phase).toBe('PRETE');
  });

  it('signature invalide : rien n’est téléchargé, compte rendu SIGNATURE_INVALIDE une seule fois', async () => {
    const s = site();
    const stockage = new FauxStockage();
    const autre = genererPaire();
    const c = await cible(stockage);
    c.signature = signer(c.manifeste, autre.clePrivee);
    const cloud = new FauxCloud(() => ({ cible: c, reglages: REGLAGES_PAR_DEFAUT }));
    const { m } = moteur(s, cloud, stockage);
    await m.cycle();
    await m.cycle();
    expect(stockage.requetes).toEqual([]);
    expect(cloud.evenements()).toEqual(['SIGNATURE_INVALIDE']);
    expect(m.phase).toBe('ECHEC');
    expect((await m.blocSante()).etat).toBe('ECHEC');
  });

  it('sans clé publique : mise à jour désactivée, le siège est prévenu', async () => {
    const s = site();
    const stockage = new FauxStockage();
    const c = await cible(stockage);
    const cloud = new FauxCloud(() => ({ cible: c, reglages: REGLAGES_PAR_DEFAUT }));
    const { m } = moteur(s, cloud, stockage, { trousseau: null });
    await m.cycle();
    expect(stockage.requetes).toEqual([]);
    expect(cloud.rapports[0]).toMatchObject({ evenement: 'ERREUR', detail: { cause: 'CLE_PUBLIQUE_ABSENTE' } });
    expect(m.derniereErreur).toMatch(/aucune clé/);
    expect((await m.vue()).actif).toBe(false);
  });

  it('disque plein : ESPACE_INSUFFISANT, rien téléchargé', async () => {
    const s = site();
    const stockage = new FauxStockage();
    const c = await cible(stockage);
    const cloud = new FauxCloud(() => ({ cible: c, reglages: REGLAGES_PAR_DEFAUT }));
    const { m } = moteur(s, cloud, stockage, { espace: 1024 });
    await m.cycle();
    expect(stockage.requetes).toEqual([]);
    expect(cloud.evenements()).toEqual(['ESPACE_INSUFFISANT']);
    expect(m.derniereErreur).toMatch(/Espace disque insuffisant/);
  });

  it('lanceur trop ancien : LANCEUR_TROP_ANCIEN', async () => {
    const s = site();
    const stockage = new FauxStockage();
    const c = await cible(stockage);
    const cloud = new FauxCloud(() => ({ cible: c, reglages: REGLAGES_PAR_DEFAUT }));
    const { m } = moteur(s, cloud, stockage, { lanceur: 0 });
    await m.cycle();
    expect(cloud.evenements()).toEqual(['LANCEUR_TROP_ANCIEN']);
    expect(stockage.requetes).toEqual([]);
  });

  it('dépendances nouvelles : paquet DEPENDANCES téléchargé et extrait à côté', async () => {
    const s = site();
    const stockage = new FauxStockage();
    const c = await cible(stockage, { deps: true });
    const cloud = new FauxCloud(() => ({ cible: c, reglages: REGLAGES_PAR_DEFAUT }));
    const { m } = moteur(s, cloud, stockage);
    await m.cycle();
    const etat = lireEtatJson(s);
    expect(etat.pret.dependances).toMatchObject({ empreinte: EMPREINTE2, dossier: `maj/pret/deps-${EMPREINTE2}/node_modules` });
    expect(readFileSync(join(s.racine, `maj/pret/deps-${EMPREINTE2}/node_modules/fastify/index.js`), 'utf8')).toBe('v5');
    expect(readFileSync(join(s.racine, `maj/pret/deps-${EMPREINTE2}/apps/server/node_modules/pino/index.js`), 'utf8')).toBe('pino');
  });

  it('dépendances inchangées : le paquet de dépendances n’est pas téléchargé', async () => {
    const s = site();
    const stockage = new FauxStockage();
    const c = await cible(stockage, { deps: true });
    ecrire(s.racine, 'app/node_modules/.empreinte-deps', `${EMPREINTE2}\n`);
    const cloud = new FauxCloud(() => ({ cible: c, reglages: REGLAGES_PAR_DEFAUT }));
    const { m } = moteur(s, cloud, stockage);
    await m.cycle();
    expect(lireEtatJson(s).pret.dependances).toBeNull();
    expect(stockage.requetes.some((r) => r.url.includes('/deps/'))).toBe(false);
  });

  it('seule la cible est gardée ; plus de cible → version prête abandonnée', async () => {
    const s = site();
    ecrire(s.racine, 'maj/pret/2026102399/app/x', 'ancienne préparation');
    ecrire(s.racine, 'maj/telechargement/2026102398/p.000', 'vieux morceau');
    const stockage = new FauxStockage();
    const c = await cible(stockage);
    let actuelle: CibleMaj | null = c;
    const cloud = new FauxCloud(() => ({ cible: actuelle, reglages: REGLAGES_PAR_DEFAUT }));
    const { m } = moteur(s, cloud, stockage);
    await m.cycle();
    expect(readdirSync(join(s.racine, 'maj/pret'))).toEqual(['2026102401']);
    expect(readdirSync(join(s.racine, 'maj/telechargement'))).toEqual([]);
    actuelle = null;
    await m.cycle();
    expect(lireEtatJson(s).pret).toBeNull();
    expect(readdirSync(join(s.racine, 'maj/pret'))).toEqual([]);
    expect(m.phase).toBe('A_JOUR');
  });

  it('version refusée localement : pas de nouvelle préparation, sauf « réessayer » du siège', async () => {
    const s = site();
    ecrire(s.racine, 'maj/installation.json', JSON.stringify({
      format: 1, numero: 2026102401, version: '2026.10.24-1', etat: 'REVENUE', tentative: 1, etape: 'RETOUR_BASE', statut: 'FINIE',
      code_touche: true, base_touchee: true, retour: { etapes: [], tentatives: 1, refuser: true },
      erreur: { code: 'MIGRATION_ECHOUEE', message: 'relation déjà existante', etape: 'MIGRATIONS' },
      refusees: [2026102401], commence_le: '2026-10-24T06:00:00.000Z', maj_le: '2026-10-24T06:02:00.000Z', historique: [],
    }));
    const stockage = new FauxStockage();
    const c = await cible(stockage);
    let reglages = REGLAGES_PAR_DEFAUT;
    const cloud = new FauxCloud(() => ({ cible: c, reglages }));
    const { m } = moteur(s, cloud, stockage);
    await m.cycle();
    expect(m.phase).toBe('REFUSEE');
    expect(stockage.requetes).toEqual([]);
    // Le journal du lanceur est remonté au siège : échec + refus, une fois.
    expect(cloud.evenements()).toEqual(['ECHEC_RETOUR_ARRIERE', 'REFUSEE']);
    expect((await m.blocSante()).etat).toBe('REFUSEE');
    reglages = { ...REGLAGES_PAR_DEFAUT, reessayer: 'jeton-r' };
    await m.cycle();
    expect(m.phase).toBe('PRETE');
    expect(cloud.evenements()).toEqual(['ECHEC_RETOUR_ARRIERE', 'REFUSEE', 'TELECHARGEMENT', 'PRET']);
  });

  it('installation réussie rapportée une seule fois (journal + validation)', async () => {
    const s = site();
    ecrire(s.racine, 'maj/installation.json', JSON.stringify({
      format: 1, numero: INSTALLEE.numero, version: INSTALLEE.version, etat: 'INSTALLEE', tentative: 1, etape: 'FINALISATION', statut: 'FINIE',
      code_touche: true, base_touchee: true, retour: null, erreur: null, refusees: [],
      commence_le: '2026-10-24T06:00:00.000Z', maj_le: '2026-10-24T06:02:30.000Z', historique: [],
    }));
    const cloud = new FauxCloud(() => ({ cible: null, reglages: REGLAGES_PAR_DEFAUT }));
    const { m } = moteur(s, cloud, new FauxStockage());
    await m.surValidation();
    await m.cycle();
    expect(cloud.evenements()).toEqual(['INSTALLE']);
    expect(cloud.rapports[0]!.detail).toMatchObject({ version: INSTALLEE.version, tentative: 1 });
  });

  it('bandeau : préavis à H-10, un seul report de 30 min', async () => {
    const s = site();
    const stockage = new FauxStockage();
    const c = await cible(stockage);
    const cloud = new FauxCloud(() => ({ cible: c, reglages: { ...REGLAGES_PAR_DEFAUT, heure_installation: '06:00' } }));
    let maintenant = new Date('2026-10-24T03:00:00Z');
    const { m, diffusions } = moteur(s, cloud, stockage, { maintenant: () => maintenant });
    await m.cycle();
    expect((await m.vue()).decision).toMatchObject({ action: 'ATTENDRE' });
    await expect(m.reporter({ nom: 'Gérant', id: null })).rejects.toThrow(/10 minutes/);
    maintenant = new Date('2026-10-24T05:52:00Z');
    diffusions.length = 0;
    await m.tickCreneau();
    expect(diffusions).toEqual(['maj']);
    expect(cloud.evenements()).toContain('AVERTI');
    const vue = await m.reporter({ nom: 'Gérant', id: null });
    expect(vue.etat).toBe('REPORTEE');
    expect(vue.decision).toMatchObject({ echeance: '2026-10-24T06:30:00.000Z', report_possible: false });
    expect(lireEtatJson(s).report).toMatchObject({ par: 'Gérant', numero: 2026102401 });
    await expect(m.reporter({ nom: 'Gérant', id: null })).rejects.toThrow(/déjà été reportée/);
    maintenant = new Date('2026-10-24T06:29:00Z');
    expect((await m.vue()).decision).toMatchObject({ action: 'AVERTIR', rappel: true, report_possible: false });
    expect((await m.blocSante()).report_jusqua).toBe('2026-10-24T06:30:00.000Z');
    await new Promise((r) => setTimeout(r, 20));
    expect(cloud.evenements()).toContain('REPORTE');
  });

  it('sentinelle Grenam : .exe de 533 504 octets et paire g<nom>.exe', async () => {
    const s = site();
    writeFileSync(join(s.racine, 'PosSamer.exe'), Buffer.alloc(533504));
    ecrire(s.racine, 'runtime/node/node.exe', 'faux');
    ecrire(s.racine, 'runtime/node/gnode.exe', 'original caché');
    ecrire(s.racine, 'runtime/pgsql/bin/pg_ctl.exe', 'sain');
    const { m } = moteur(s, new FauxCloud(() => ({ cible: null, reglages: REGLAGES_PAR_DEFAUT })), new FauxStockage());
    expect(await m.analyserIntegrite()).toBe(2);
    expect((await m.blocSante()).integrite.suspects_grenam).toBe(2);
  });
});
