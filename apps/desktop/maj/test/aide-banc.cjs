'use strict';
// Banc d'essai du lanceur (début du lot L6) : un FAUX dossier portable dans un
// répertoire temporaire — `app/` avec node_modules, `.env` et copies `@pos/*`,
// `data/pgdata`, une version prête dans `maj/pret/<n>/app` signée avec une clé
// jetable — et de faux processus (PostgreSQL, migrations, serveur HTTP) qui
// lisent l'état RÉEL du disque. Les opérations disque testées sont les vraies
// (operations.cjs) ; seuls les processus sont simulés.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { dossierTemp } = require('./aide.cjs');
const {
  genererPaire,
  signer,
  serialiserManifeste,
  ecrireArchive,
  extraireArchive,
  ecrireJsonAtomique,
  creerOperations,
  creerLanceurMaj,
} = require('../index.cjs');

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const EMPREINTE = sha('pnpm-lock-ancien');
const EMPREINTE2 = sha('pnpm-lock-nouveau');
const ANCIEN = { numero: 2026102301, version: '2026.10.23-1', commit: 'aaaaaaa1' };
const NOUVEAU = { numero: 2026102401, version: '2026.10.24-1', commit: 'bbbbbbb2' };

function ecrire(racine, rel, contenu) {
  const abs = path.join(racine, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contenu);
}
const lire = (racine, rel) => {
  try {
    return fs.readFileSync(path.join(racine, ...rel.split('/')), 'utf8');
  } catch {
    return null;
  }
};
const existe = (racine, rel) => fs.existsSync(path.join(racine, ...rel.split('/')));

/** Code (sans node_modules) d'une version : ce que livre un paquet APP. */
function arbreCode(racine, v, marque) {
  ecrire(racine, 'VERSION.json', JSON.stringify({ numero: v.numero, version: v.version, commit: v.commit }));
  ecrire(racine, 'apps/server/src/index.ts', `// serveur ${marque}\n`);
  ecrire(racine, 'apps/server/package.json', JSON.stringify({ name: '@pos/server', dependencies: { '@pos/shared': 'workspace:*' } }));
  ecrire(racine, 'apps/caisse/package.json', JSON.stringify({ name: '@pos/caisse', dependencies: { '@pos/shared': 'workspace:*' } }));
  ecrire(racine, 'apps/caisse/dist/index.html', `<!doctype html><html><body>caisse ${marque}</body></html>`);
  ecrire(racine, 'packages/shared/package.json', JSON.stringify({ name: '@pos/shared' }));
  ecrire(racine, 'packages/shared/index.js', `export const marque = '${marque}';\n`);
}

function listerFichiers(racine, rel = '') {
  const liste = [];
  for (const e of fs.readdirSync(rel ? path.join(racine, rel) : racine, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) liste.push(...listerFichiers(racine, r));
    else liste.push(r);
  }
  return liste;
}

function portLibre() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Publie un arbre comme le ferait l'outil L2 : archive, manifeste signé. */
async function publier(t, source, manifesteBase, clePrivee) {
  const morceaux = dossierTemp(t, 'morceaux');
  const res = await ecrireArchive({ racine: source, chemins: listerFichiers(source), dossierSortie: morceaux, prefixe: 'paquet', tailleMorceau: 4096 });
  const manifeste = { ...manifesteBase, archive: res.archive, morceaux: res.morceaux, fichiers: res.fichiers };
  const texte = serialiserManifeste(manifeste).toString('utf8');
  return { manifeste, texte, signature: signer(texte, clePrivee), morceaux };
}

/**
 * Fabrique un site complet.
 * options : depsNouvelles (paquet de dépendances à installer), typeSite, pretLe,
 * heureInstallation.
 */
async function creerSite(t, options = {}) {
  const racine = dossierTemp(t, 'site');
  const { clePublique, clePrivee } = genererPaire();
  // --- version en service
  const app = path.join(racine, 'app');
  arbreCode(app, ANCIEN, 'ancien');
  ecrire(app, 'apps/server/.env', 'CLE_SITE=secrete-du-site\n');
  ecrire(app, '.env.local', 'RACINE=1\n');
  ecrire(app, 'node_modules/.empreinte-deps', `${EMPREINTE}\n`);
  ecrire(app, 'node_modules/fastify/index.js', 'fastify v4\n');
  ecrire(app, 'apps/server/node_modules/@pos/shared/index.js', "export const marque = 'ancien';\n");
  ecrire(app, 'apps/server/node_modules/@pos/shared/package.json', JSON.stringify({ name: '@pos/shared' }));
  // --- base
  ecrire(racine, 'data/pgdata/PG_VERSION', '16\n');
  ecrire(racine, 'data/pgdata/base/1/donnees', 'ventes-avant\n');
  // --- version prête
  const source = dossierTemp(t, 'source');
  arbreCode(source, NOUVEAU, 'nouveau');
  const empreinteCible = options.depsNouvelles ? EMPREINTE2 : EMPREINTE;
  const base = {
    format: 1,
    type: 'APP',
    numero: NOUVEAU.numero,
    version: NOUVEAU.version,
    commit: NOUVEAU.commit,
    publie_le: '2026-10-24T03:00:00.000Z',
    lanceur_min: 1,
    node_min: '22.0.0',
    dependances: { empreinte: empreinteCible },
    migrations: { derniere: '0044_test', nouvelles: ['0044_test'], retrocompatibles: true },
    notes: 'Version de test.',
  };
  const pub = await publier(t, source, base, clePrivee);
  const dossierPret = `maj/pret/${NOUVEAU.numero}/app`;
  await extraireArchive({ dossierMorceaux: pub.morceaux, manifeste: pub.manifeste, destination: path.join(racine, ...dossierPret.split('/')) });
  let dependances = null;
  if (options.depsNouvelles) {
    const srcDeps = dossierTemp(t, 'deps');
    ecrire(srcDeps, 'node_modules/fastify/index.js', 'fastify v5\n');
    ecrire(srcDeps, 'apps/server/node_modules/pino/index.js', 'pino\n');
    const pubDeps = await publier(t, srcDeps, { format: 1, type: 'DEPENDANCES', empreinte: EMPREINTE2, publie_le: '2026-10-24T03:00:00.000Z', node_min: '22.0.0' }, clePrivee);
    await extraireArchive({ dossierMorceaux: pubDeps.morceaux, manifeste: pubDeps.manifeste, destination: path.join(racine, 'maj', 'pret', `deps-${EMPREINTE2}`) });
    dependances = { empreinte: EMPREINTE2, dossier: `maj/pret/deps-${EMPREINTE2}/node_modules`, manifeste: pubDeps.texte, signature: pubDeps.signature };
  }
  const etat = {
    format: 1,
    pret: {
      numero: NOUVEAU.numero,
      version: NOUVEAU.version,
      dossier: dossierPret,
      pret_le: options.pretLe || '2026-10-23T12:00:00.000Z',
      manifeste: pub.texte,
      signature: pub.signature,
      dependances,
    },
    reglages: {
      type_site: options.typeSite || 'H24',
      heure_installation: options.heureInstallation || '06:00',
      heure_filet: '05:00',
      pause: false,
      installer_maintenant: options.installerMaintenant || null,
      reessayer: options.reessayer || null,
    },
    report: null,
    jetons_traites: { installer_maintenant: null, reessayer: null },
  };
  await ecrireJsonAtomique(path.join(racine, 'maj', 'etat.json'), etat);
  return { racine, app, trousseau: { actuelle: clePublique }, clePrivee, etat, port: await portLibre() };
}

/**
 * Faux processus. Ils lisent le disque : le « serveur » répond la version de
 * `app/VERSION.json` et sert `app/apps/caisse/dist/index.html` ; les
 * « migrations » écrivent dans `data/pgdata`.
 */
function fauxProcessus(site, options = {}) {
  const appels = [];
  const etat = { pg: false, serveur: null, validation: false };
  const sockets = new Set();
  function fermerServeur() {
    if (!etat.serveur) return Promise.resolve();
    const s = etat.serveur;
    etat.serveur = null;
    for (const so of sockets) so.destroy();
    return new Promise((r) => s.close(() => r()));
  }
  const p = {
    appels,
    etat,
    async arreterApi() {
      appels.push('arreterApi');
    },
    async arreterVite() {
      appels.push('arreterVite');
    },
    async arreterServeur() {
      appels.push('arreterServeur');
      await fermerServeur();
    },
    async arreterPg() {
      appels.push('arreterPg');
      etat.pg = false;
    },
    async demarrerPg() {
      appels.push('demarrerPg');
      etat.pg = true;
    },
    async migrer() {
      appels.push('migrer');
      if (!etat.pg) throw new Error('PostgreSQL arrêté');
      const v = JSON.parse(lire(site.app, 'VERSION.json'));
      if (options.migrationEchoue) {
        ecrire(site.racine, 'data/pgdata/base/1/donnees', 'migration-a-moitie\n');
        throw new Error('relation « x » déjà existante');
      }
      ecrire(site.racine, 'data/pgdata/base/1/donnees', `migree-${v.numero}\n`);
    },
    async demarrerServeur({ validation }) {
      appels.push(validation ? 'demarrerServeur(validation)' : 'demarrerServeur');
      await fermerServeur();
      etat.validation = validation;
      const serveur = http.createServer((req, res) => {
        const v = JSON.parse(lire(site.app, 'VERSION.json') || '{}');
        const casse = options.santeKo && v.numero === NOUVEAU.numero;
        if (req.url === '/api/sante') {
          res.writeHead(casse ? 500 : 200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: !casse }));
        }
        if (req.url === '/api/sante/version') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ numero: v.numero, version: v.version, commit: v.commit }));
        }
        const html = lire(site.app, 'apps/caisse/dist/index.html');
        if (req.url === '/' && html) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(html);
        }
        res.writeHead(404);
        res.end();
      });
      serveur.on('connection', (so) => {
        sockets.add(so);
        so.on('close', () => sockets.delete(so));
      });
      await new Promise((r) => serveur.listen(site.port, '127.0.0.1', r));
      etat.serveur = serveur;
      const moi = serveur;
      return { vivant: () => etat.serveur === moi && !options.serveurMeurt };
    },
    async validerServeur() {
      appels.push('validerServeur');
      etat.validation = false;
    },
    serveurActif() {
      return etat.serveur !== null;
    },
    /** Coupure de courant : tout s'arrête net. */
    async couper() {
      etat.pg = false;
      await fermerServeur();
    },
  };
  return p;
}

/**
 * Coupure simulée : à l'arrivée sur le point demandé, la promesse ne se
 * résout plus jamais (le « courant » est coupé) et `coupee` se résout.
 */
function coupure(point) {
  let signaler;
  const coupee = new Promise((r) => (signaler = r));
  return {
    coupee,
    pointCoupure: async (nom) => {
      if (nom === point) {
        signaler(nom);
        await new Promise(() => {});
      }
    },
  };
}

/** Lanceur complet sur un site : opérations réelles + faux processus. */
function lanceurPour(site, processus, options = {}) {
  const pointCoupure = options.pointCoupure || (() => {});
  const { operations, nettoyer } = creerOperations({
    racine: site.racine,
    trousseau: options.trousseau === undefined ? site.trousseau : options.trousseau,
    numeroLanceur: options.numeroLanceur ?? 1,
    versionNode: async () => 'v22.23.1',
    processus,
    port: site.port,
    delais: { santeTotalMs: 1500, santeVivantApresMs: 100, santeIntervalleMs: 30, renommageEssais: options.renommageEssais ?? 4, renommageDelaiMs: 5 },
    margeEspaceOctets: 1024,
    mesurerEspace: options.mesurerEspace,
    horloge: options.horloge,
    pointCoupure,
  });
  // Points de coupure au début et à la fin de CHAQUE étape, en plus des
  // points internes des opérations.
  const enveloppees = Object.fromEntries(
    Object.entries(operations).map(([etape, f]) => [
      etape,
      async (ctx) => {
        await pointCoupure(`${etape}:debut`);
        await f(ctx);
        await pointCoupure(`${etape}:fin`);
      },
    ]),
  );
  return creerLanceurMaj({
    racine: site.racine,
    trousseau: options.trousseau === undefined ? site.trousseau : options.trousseau,
    operations: enveloppees,
    nettoyer,
    horloge: options.horloge,
  });
}

/** Contrôle qu'un site est COHÉRENT : soit tout ancien, soit tout nouveau. */
function etatDuSite(site) {
  const v = JSON.parse(lire(site.app, 'VERSION.json'));
  return {
    numero: v.numero,
    serveur: lire(site.app, 'apps/server/src/index.ts'),
    env: lire(site.app, 'apps/server/.env'),
    envRacine: lire(site.app, '.env.local'),
    fastify: lire(site.app, 'node_modules/fastify/index.js'),
    empreinte: (lire(site.app, 'node_modules/.empreinte-deps') || '').trim(),
    copiePos: lire(site.app, 'apps/server/node_modules/@pos/shared/index.js'),
    base: lire(site.racine, 'data/pgdata/base/1/donnees'),
  };
}

module.exports = {
  ANCIEN,
  NOUVEAU,
  EMPREINTE,
  EMPREINTE2,
  ecrire,
  lire,
  existe,
  creerSite,
  fauxProcessus,
  coupure,
  lanceurPour,
  etatDuSite,
};
