// Coquille desktop (Electron) pour la caisse POS Samer : démarre Postgres +
// le serveur Fastify portables, puis affiche la caisse en plein écran
// kiosque (aucune bordure, aucune barre d'adresse). Remplace le trio
// « demarrer-pos.bat + navigateur + fenêtre qu'on peut fermer par erreur ».
const { app, BrowserWindow, globalShortcut, ipcMain, session } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');

const PORT = process.env.PORT || 3001;

// Journal de démarrage (diagnostic) : utile en double-clic normal, où il n'y
// a pas de console attachée pour voir les logs.
const T0 = Date.now();
const LOG_PATH = path.join(require('node:os').tmpdir(), 'possamer-demarrage.log');
function journal(msg) {
  fs.appendFileSync(LOG_PATH, `[+${((Date.now() - T0) / 1000).toFixed(1)}s] ${msg}\n`);
}
journal('=== Nouveau lancement ===');

// Layout du dossier portable (identique à demarrer-pos.bat) :
//   POS-Samer/runtime/node, runtime/pgsql/bin, data/pgdata, app/
// Une fois packagé, le .exe portable s'auto-extrait dans un dossier temporaire :
// __dirname n'y pointe donc plus vers apps/desktop sur le vrai disque.
// electron-builder expose PORTABLE_EXECUTABLE_DIR = dossier réel du .exe
// double-cliqué ; on l'utilise en priorité, sinon (mode dev `electron .`) on
// retombe sur le calcul relatif classique.
const ROOT = process.env.PORTABLE_EXECUTABLE_DIR || path.resolve(__dirname, '..', '..', '..');
const NODE_BIN = path.join(ROOT, 'runtime', 'node');
const PGBIN = path.join(ROOT, 'runtime', 'pgsql', 'bin');
const PGDATA = path.join(ROOT, 'data', 'pgdata');
const APP_DIR = path.join(ROOT, 'app');
const SERVER_DIR = path.join(APP_DIR, 'apps', 'server');

// KDS (cuisine), serveur (tablette) et client (QR table) restent accessibles
// depuis les autres appareils du réseau local via leur propre serveur Vite,
// exactement comme le faisait demarrer-pos.bat (`pnpm dev` sur tout le
// workspace) — seule la caisse est désormais servie par Fastify + affichée
// dans la fenêtre kiosque de cette app.
const AUTRES_APPS = ['kds', 'serveur', 'client'];

let serverProcess = null;
let autresProcess = [];
let fenetre = null;
let arretDejaLance = false;
// Cause la plus précise connue de l'échec de démarrage, affichée telle quelle
// sur l'écran d'erreur (le journal, lui, personne n'ira le lire sur un site).
let dernierEchec = null;
// Évite de recharger l'écran d'erreur en boucle s'il échoue à son tour.
let pageErreurAffichee = false;

// Résolution des CLI embarqués (tsx, vite). Depuis le passage de pnpm en
// `nodeLinker: hoisted` (pnpm-workspace.yaml — pour que la copie sur clé USB
// n'ait plus aucun lien symbolique à recréer), les dépendances ne sont plus
// installées dans apps/<app>/node_modules mais UNIQUEMENT à la racine du
// workspace : seuls les paquets @pos/* y sont encore injectés. Les chemins en
// dur vers apps/<app>/node_modules/... ne résolvaient donc plus rien, le
// serveur sortait aussitôt en code 1 et la caisse s'affichait VIDE (fenêtre
// kiosque correcte, mais aucune API derrière). On cherche aux deux endroits
// pour rester valable quel que soit le linker de l'installation.
function resoudreCli(dossierApp, ...sousChemin) {
  const candidats = [
    path.join(dossierApp, 'node_modules', ...sousChemin),
    path.join(APP_DIR, 'node_modules', ...sousChemin),
  ];
  const trouve = candidats.find((c) => fs.existsSync(c));
  if (!trouve) {
    journal(`CLI introuvable : ${sousChemin.join('/')} (cherché dans ${candidats.join(' | ')})`);
    dernierEchec = `Fichier manquant : ${sousChemin.join('/')}. L'installation est incomplète (dossier node_modules copié partiellement).`;
  }
  return trouve || candidats[1];
}

function envPortable() {
  return { ...process.env, PATH: `${NODE_BIN};${PGBIN};${process.env.PATH}` };
}

function pgDejaActif() {
  // pg_ctl status est quasi instantané (pas de -w) : contrairement à
  // `pg_ctl start`, qui — si un serveur tourne déjà sur ce port — attend
  // (jusqu'à ~60s) un signal de démarrage qui ne viendra jamais avant
  // d'abandonner. Vérifier d'abord évite cette attente inutile, qui s'est
  // révélée être LA cause du démarrage perçu comme lent.
  return new Promise((resolve) => {
    const proc = spawn(path.join(PGBIN, 'pg_ctl.exe'), ['-D', PGDATA, 'status'], {
      env: envPortable(),
      windowsHide: true,
    });
    proc.on('exit', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

async function demarrerPostgres() {
  journal('demarrerPostgres() debut');
  if (await pgDejaActif()) {
    journal('demarrerPostgres() deja actif, on ne relance pas');
    return;
  }
  return new Promise((resolve) => {
    const proc = spawn(
      path.join(PGBIN, 'pg_ctl.exe'),
      ['-D', PGDATA, '-l', path.join(ROOT, 'data', 'pg.log'), '-w', 'start'],
      { env: envPortable(), windowsHide: true },
    );
    proc.on('exit', (code) => {
      journal(`demarrerPostgres() fin (code ${code})`);
      resolve();
    });
    proc.on('error', (e) => {
      journal(`demarrerPostgres() erreur : ${e}`);
      resolve();
    });
  });
}

function arreterPostgres() {
  spawn(path.join(PGBIN, 'pg_ctl.exe'), ['-D', PGDATA, 'stop'], { env: envPortable(), windowsHide: true });
}

function demarrerServeur() {
  journal('demarrerServeur() spawn');
  // On invoque node.exe directement sur le point d'entrée réel de tsx
  // (et non le .CMD .bin, dont le shell-wrapping via `shell: true` s'est
  // révélé peu fiable) : plus robuste, aucun souci de quoting Windows.
  const nodeExe = path.join(NODE_BIN, 'node.exe');
  const tsxCli = resoudreCli(SERVER_DIR, 'tsx', 'dist', 'cli.mjs');
  serverProcess = spawn(nodeExe, [tsxCli, 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: envPortable(),
    stdio: 'inherit',
    windowsHide: true,
  });
  serverProcess.on('spawn', () => journal('demarrerServeur() process demarre (spawn event)'));
  serverProcess.on('error', (e) => {
    journal(`Erreur lancement serveur : ${e}`);
    dernierEchec = `Le serveur n'a pas pu être lancé : ${e.message || e}`;
  });
  serverProcess.on('exit', (code) => {
    journal(`Serveur arrêté, code : ${code}`);
    if (code !== 0 && !arretDejaLance) {
      dernierEchec = dernierEchec || `Le serveur s'est arrêté tout seul (code ${code}).`;
    }
  });
}

function demarrerAutresApps() {
  const nodeExe = path.join(NODE_BIN, 'node.exe');
  autresProcess = AUTRES_APPS.map((nom) => {
    const dir = path.join(APP_DIR, 'apps', nom);
    const viteCli = resoudreCli(dir, 'vite', 'bin', 'vite.js');
    const proc = spawn(nodeExe, [viteCli], {
      cwd: dir,
      env: envPortable(),
      stdio: 'inherit',
      windowsHide: true,
    });
    // En double-clic il n'y a aucune console : `console.error` se perdait, et
    // un KDS/serveur qui ne démarre pas restait invisible. Tout va au journal.
    proc.on('error', (e) => journal(`Erreur lancement ${nom} : ${e}`));
    proc.on('exit', (code) => journal(`${nom} arrêté, code : ${code}`));
    return proc;
  });
}

function attendreServeurPret(tentative = 0) {
  return new Promise((resolve, reject) => {
    const requete = http.get(`http://localhost:${PORT}/api/sante`, (res) => {
      res.resume();
      if (res.statusCode === 200) resolve();
      else retenter();
    });
    requete.on('error', retenter);
    function retenter() {
      if (tentative > 90) return reject(new Error('Le serveur POS ne répond pas après 45s'));
      setTimeout(() => attendreServeurPret(tentative + 1).then(resolve, reject), 500);
    }
  });
}

function creerFenetre() {
  fenetre = new BrowserWindow({
    kiosk: true,
    fullscreen: true,
    frame: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    // Pont IPC minimal exposé à la caisse (window.posSamer.fermer) : c'est la
    // caisse elle-même qui affiche un bouton « Fermer l'application » sur son
    // écran de choix du profil (login). Plus de fenêtre-bouton flottante.
    webPreferences: { preload: path.join(__dirname, 'preload-bouton.js') },
  });

  // Dernier filet contre la FENÊTRE BLANCHE. Si la page n'arrive pas à se
  // charger, ou si son processus de rendu meurt, Electron ne montre rien du
  // tout en mode kiosque sans bordure : l'écran reste blanc, sans le moindre
  // indice. On bascule sur l'écran d'erreur, qui dit au moins quoi faire.
  fenetre.webContents.on('did-fail-load', (_e, code, description, url) => {
    if (code === -3) return; // ERR_ABORTED : navigation remplacée, sans intérêt
    journal(`Chargement echoue (${code} ${description}) sur ${url}`);
    dernierEchec = `La caisse n'a pas pu s'afficher (${description || 'erreur ' + code}).`;
    chargerErreur();
  });
  fenetre.webContents.on('render-process-gone', (_e, details) => {
    journal(`Processus de rendu perdu : ${details.reason}`);
    dernierEchec = "L'affichage de la caisse s'est interrompu.";
    chargerErreur();
  });
}

function chargerCaisse() {
  pageErreurAffichee = false;
  fenetre.loadURL(`http://localhost:${PORT}`);
}

// Sans cet écran, un serveur qui ne démarre pas donnait une caisse VIDE : la
// fenêtre kiosque s'ouvrait normalement, sans le moindre message. Sur un site,
// personne ne lit le journal — le symptôme « ça marche pas » a coûté des
// heures de diagnostic à distance. On affiche donc la cause sur place.
function echapper(texte) {
  return String(texte).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

function chargerErreur() {
  // Si l'écran d'erreur lui-même échouait à s'afficher, `did-fail-load` le
  // rechargerait en boucle. Une seule tentative tant qu'on n'est pas reparti
  // sur la caisse.
  if (pageErreurAffichee) return;
  pageErreurAffichee = true;
  let extraitJournal = '';
  try {
    extraitJournal = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').slice(-12).join('\n');
  } catch {
    extraitJournal = '(journal illisible)';
  }
  const raison = dernierEchec || "Le serveur n'a pas répondu dans le temps imparti (45 secondes).";
  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Démarrage impossible</title><style>
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #0f172a; color: #e2e8f0; font-family: Segoe UI, system-ui, sans-serif; padding: 32px; }
  main { max-width: 900px; width: 100%; }
  h1 { color: #EF9F27; font-size: 34px; margin: 0 0 16px; }
  p { font-size: 20px; line-height: 1.5; margin: 0 0 14px; }
  ol { font-size: 20px; line-height: 1.6; padding-left: 24px; }
  .cause { background: #1e293b; border-left: 5px solid #EF9F27; padding: 14px 18px;
           border-radius: 6px; font-size: 19px; margin: 18px 0; }
  details { margin-top: 22px; color: #94a3b8; font-size: 15px; }
  summary { cursor: pointer; padding: 10px 0; font-size: 17px; }
  pre { background: #020617; padding: 14px; border-radius: 6px; overflow: auto;
        max-height: 220px; font-size: 13px; }
  .boutons { display: flex; gap: 14px; margin-top: 26px; flex-wrap: wrap; }
  button { min-height: 56px; padding: 0 28px; font-size: 19px; border: 0; border-radius: 8px;
           cursor: pointer; font-weight: 600; }
  .principal { background: #EF9F27; color: #0f172a; }
  .secondaire { background: #334155; color: #e2e8f0; }
</style></head><body><main>
  <h1>La caisse n'a pas pu démarrer</h1>
  <p>Le matériel n'est pas en cause : c'est le programme interne de la caisse qui
     ne s'est pas lancé. Aucune vente n'est perdue.</p>
  <div class="cause">${echapper(raison)}</div>
  <ol>
    <li>Appuyez sur <strong>Réessayer</strong> — cela suffit souvent quand le poste vient d'être allumé.</li>
    <li>Si l'écran revient, appelez le support et lisez-lui le texte encadré ci-dessus.</li>
  </ol>
  <div class="boutons">
    <button class="principal" onclick="window.posSamer && window.posSamer.reessayer()">Réessayer</button>
    <button class="secondaire" onclick="window.posSamer && window.posSamer.fermer()">Fermer l'application</button>
  </div>
  <details><summary>Détails techniques (pour le support)</summary>
    <p style="font-size:15px">Journal complet : ${echapper(LOG_PATH)}</p>
    <pre>${echapper(extraitJournal)}</pre>
  </details>
</main></body></html>`;
  const chemin = path.join(require('node:os').tmpdir(), 'possamer-erreur.html');
  fs.writeFileSync(chemin, html, 'utf8');
  fenetre.loadFile(chemin);
}

// Séquence commune au démarrage et au bouton « Réessayer ».
async function demarrerEtAfficher() {
  dernierEchec = null;
  await demarrerPostgres();
  if (!serverProcess || serverProcess.exitCode !== null) demarrerServeur();
  try {
    await attendreServeurPret();
    journal('attendreServeurPret() OK, serveur repond');
    chargerCaisse();
    return true;
  } catch (e) {
    journal(`attendreServeurPret() ECHEC : ${e}`);
    chargerErreur();
    return false;
  }
}

async function arreterProprement() {
  // Ceinture : seule l'instance propriétaire du verrou arrête Postgres et les
  // processus enfants. Une instance surnuméraire ne doit RIEN couper.
  if (!verrouInstance) return;
  if (arretDejaLance) return;
  arretDejaLance = true;
  globalShortcut.unregisterAll();
  if (serverProcess) serverProcess.kill();
  autresProcess.forEach((p) => p.kill());
  arreterPostgres();
}

// UNE SEULE INSTANCE. Sans ce verrou, rouvrir par l'icône alors que la caisse
// tournait déjà lançait une deuxième application complète, qui : (1) démarrait
// un second serveur sur le port 3001 déjà pris, lequel mourait aussitôt ;
// (2) purgeait le cache de la session partagée sous les pieds de la première ;
// (3) ré-extrayait l'exe portable par-dessus les fichiers en cours d'usage
// (dossier d'extraction fixe). Résultat observé sur site : une fenêtre BLANCHE,
// sans donnée, alors que PostgreSQL tournait parfaitement.
// Désormais le second lancement rend la main au premier et se termine.
const verrouInstance = app.requestSingleInstanceLock();
if (!verrouInstance) {
  journal('Instance deja en cours : ce lancement rend la main et se termine.');
  // `app.exit` et surtout PAS `app.quit` : quitter passerait par `before-quit`
  // → `arreterProprement()` → `pg_ctl stop`, et ce lancement de trop couperait
  // PostgreSQL sous la caisse qui tourne. On sort sans rien arrêter.
  app.exit(0);
}

app.on('second-instance', () => {
  journal('Second lancement detecte : on ramene la fenetre existante au premier plan.');
  if (!fenetre) return;
  if (fenetre.isMinimized()) fenetre.restore();
  if (!fenetre.isVisible()) fenetre.show();
  fenetre.focus();
});

journal('require electron termine, en attente de app.whenReady()');
app.whenReady().then(async () => {
  if (!verrouInstance) return;
  journal('app.whenReady() declenche');
  // Le serveur de la caisse est LOCAL : le cache offline du service worker de
  // la PWA n'apporte rien au kiosque et faisait persister d'anciens builds après
  // une mise à jour (bouton/couleur manquants tant que le cache n'était pas
  // vidé). On repart d'un shell propre à chaque lancement.
  try {
    await session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
    await session.defaultSession.clearCache();
    journal('cache PWA purge');
  } catch (e) {
    journal(`purge cache PWA echouee : ${e}`);
  }

  creerFenetre();
  journal('fenetre creee');
  const pret = await demarrerEtAfficher();

  // KDS/serveur/client démarrent après coup : évite de faire concurrence en
  // CPU/disque au serveur principal pendant la phase critique (affichage de
  // la caisse), qui rendait le démarrage perçu comme lent. Inutile de les
  // lancer si la caisse elle-même n'a pas démarré.
  if (pret) setTimeout(demarrerAutresApps, 4000);

  // Porte de sortie pour la maintenance : le mode kiosque peut bloquer Alt+F4.
  globalShortcut.register('Control+Alt+Q', () => {
    app.quit();
  });
});

ipcMain.on('fermer-app', () => {
  app.quit();
});

let reessaiEnCours = false;
ipcMain.on('reessayer-demarrage', async () => {
  if (reessaiEnCours || arretDejaLance) return;
  reessaiEnCours = true;
  journal('Reessai demande depuis l ecran d erreur');
  try {
    if (await demarrerEtAfficher()) setTimeout(demarrerAutresApps, 4000);
  } finally {
    reessaiEnCours = false;
  }
});

app.on('before-quit', (e) => {
  if (!arretDejaLance) {
    e.preventDefault();
    arreterProprement().then(() => app.exit(0));
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
