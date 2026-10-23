#!/usr/bin/env node
// Outil de publication d'une version des postes (plan docs/PLAN_MAJ_A_DISTANCE.md
// § 2, lot L2). À lancer sur le poste master, par le PROPRIÉTAIRE, avec la clé
// USB « signature » branchée :
//
//   node scripts/maj/publier.mjs --cle E:\signature\cle-signature-maj.pem --simulation
//   node scripts/maj/publier.mjs --cle E:\signature\cle-signature-maj.pem --email proprietaire@…
//
// Ce que fait l'outil, dans l'ordre — il s'arrête au premier refus :
//   1. arbre git PROPRE (rien de modifié, rien de non suivi) ; on publie HEAD ;
//   2. clé privée chiffrée lue sur la clé USB, phrase de passe demandée au
//      clavier (jamais en argument ni en variable d'environnement) ;
//   3. connexion au siège (compte du propriétaire), contrôle que la clé
//      publique du cloud est bien celle de cette clé privée ;
//   4. extraction du commit dans un dossier temporaire NEUF (`git archive`) :
//      ce qui part est exactement le commit, pas l'état du dossier de travail ;
//   5. dépendances (pnpm, ou node_modules existant vérifié contre le lock),
//      copies `@pos/*` matérialisées depuis `packages/` du commit ;
//   6. contrôle des migrations drizzle (journal ↔ fichiers, `when` croissants,
//      migrations livrées intactes, « ajouter d'abord ») et de `apps/desktop` ;
//   7. typecheck, tests (fondations L0 + serveur), build de la caisse ;
//   8. VERSION.json, liste des fichiers, contrôle anti-Grenam, scan Defender ;
//   9. paquet DEPENDANCES si l'empreinte du pnpm-lock.yaml est nouvelle ;
//  10. archive en morceaux, manifeste, signature Ed25519 (vérifiée aussitôt) ;
//  11. envoi via la console du siège : la version arrive en BROUILLON, on la
//      promeut ensuite dans la console (pilote Angré 7E, puis générale).
// `--simulation` fait tout sauf la connexion et l'envoi.
// Trace locale : `publications/<numero>/` (ignoré par git).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ClientSiege, lireEnvConsole } from './lib/cloud.mjs';
import { executablesApp, fichiersCaches, scanDefender, suspectsGrenam } from './lib/integrite.mjs';
import { comparerAuxSites, controlerJournal, instructionsDestructives, lireJournal } from './lib/migrations.mjs';
import { prochaineVersion } from './lib/numero.mjs';
import { demander } from './lib/saisie.mjs';
import {
  copierDependancesLocales,
  exclusionApp,
  exclusionDependances,
  listerFichiers,
  materialiserPaquetsInternes,
  retirerSansSuivre,
} from './lib/selection.mjs';

const require = createRequire(import.meta.url);
const L0 = require('../../apps/desktop/maj/index.cjs');

const RACINE_DEPOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOSSIER_TRACES = path.join(RACINE_DEPOT, 'publications');
/** Node portable des sites (runtime/node) : 22.x. */
const NODE_MIN = '22.0.0';
/** Numéro du lanceur minimal par défaut. Le lot L4 numérote les lanceurs ; ajuster par --lanceur-min. */
const LANCEUR_MIN_DEFAUT = 1;
/** Projets vérifiés par tsc : tout ce qui tourne sur un poste (pas apps/siege). */
const PROJETS_TSC = ['packages/shared', 'packages/shared-ui', 'apps/server', 'apps/caisse', 'apps/kds', 'apps/serveur', 'apps/client'];

class Refus extends Error {}

// ---------------------------------------------------------------- options
const DRAPEAUX = new Set([
  'simulation',
  'migrations-destructives',
  'desktop-modifie',
  'dependances',
  'sans-dependances',
  'sans-tests-serveur',
  'garder-temp',
  'aide',
]);
const VALEURS = new Set(['cle', 'cle-publique', 'email', 'url', 'cle-anon', 'depuis', 'rang', 'notes', 'notes-fichier', 'pnpm', 'node-modules', 'base-test', 'lanceur-min']);

function lireOptions(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Refus(`Argument inattendu : ${a}`);
    const nom = a.slice(2);
    if (DRAPEAUX.has(nom)) o[nom] = true;
    else if (VALEURS.has(nom)) {
      if (i + 1 >= argv.length) throw new Refus(`--${nom} attend une valeur`);
      o[nom] = argv[++i];
    } else if (['phrase', 'mot-de-passe', 'password', 'passphrase'].includes(nom)) {
      throw new Refus(`--${nom} : un secret ne se passe jamais en argument, il est demandé au clavier.`);
    } else throw new Refus(`Option inconnue : --${nom} (voir --aide)`);
  }
  if (o['sans-tests-serveur'] && !o.simulation) throw new Refus('--sans-tests-serveur n’est permis qu’en --simulation.');
  if (o['sans-dependances'] && !o.simulation) throw new Refus('--sans-dependances n’est permis qu’en --simulation.');
  return o;
}

const AIDE = `Publication d'une version des postes POS-Samer.

  node scripts/maj/publier.mjs --cle <clé privée .pem> [options]

  --simulation               tout sauf la connexion et l'envoi (trace dans publications/simulation/)
  --email <adresse>          compte siège du propriétaire (mot de passe demandé au clavier)
  --depuis <commit>          version installée sur les sites (défaut : dernière publication locale)
  --rang <n>                 rang de la publication du jour (défaut : suivant)
  --notes "<texte>" | --notes-fichier <fichier>   notes de version (défaut : journal git)
  --pnpm <chemin pnpm.cjs>   installer les dépendances avec pnpm dans le dossier temporaire
  --node-modules <dossier>   sinon : node_modules existant, vérifié contre le pnpm-lock.yaml (défaut : celui du dépôt)
  --base-test <nom>          base PostgreSQL des tests serveur (défaut : pos_test_publication)
  --lanceur-min <n>          numéro minimal de PosSamer.exe requis (défaut : ${LANCEUR_MIN_DEFAUT})
  --dependances              forcer la construction du paquet DEPENDANCES
  --migrations-destructives  accepter DROP / RENAME dans les nouvelles migrations
  --desktop-modifie          accepter un changement de apps/desktop (le lanceur des sites garde l'ancien)
  --url / --cle-anon         cloud (défaut : apps/siege/.env)
  --garder-temp              ne pas effacer le dossier temporaire
  (simulation seulement) --sans-tests-serveur, --sans-dependances
`;

// ---------------------------------------------------------------- outils
const journal = [];
function dire(m = '') {
  process.stdout.write(`${m}\n`);
  journal.push(m);
}
function etape(titre) {
  dire('');
  dire(`── ${titre}`);
}

function git(args, { cwd = RACINE_DEPOT, binaire = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: binaire ? 'buffer' : 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) throw new Refus(`git ${args.join(' ')} a échoué : ${String(r.stderr ?? '').trim()}`);
  return r.stdout;
}

/** Lance node (le même que celui-ci) ; refuse si le code de sortie n'est pas 0. */
function lancerNode(titre, args, { cwd, env = {} }) {
  dire(`  ${titre}…`);
  const r = spawnSync(process.execPath, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env }, windowsHide: true });
  if (r.status !== 0) throw new Refus(`${titre} : échec (code ${r.status}). Rien n'a été publié.`);
}

function estDans(enfant, parent) {
  const rel = path.relative(parent.toLowerCase(), path.resolve(enfant).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const sha256 = (octets) => crypto.createHash('sha256').update(octets).digest('hex');

/** Publications précédentes (traces locales, hors simulations). */
function lireTraces() {
  if (!fs.existsSync(DOSSIER_TRACES)) return [];
  const out = [];
  for (const nom of fs.readdirSync(DOSSIER_TRACES)) {
    const f = path.join(DOSSIER_TRACES, nom, 'publication.json');
    if (!/^\d+$/.test(nom) || !fs.existsSync(f)) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(f, 'utf8')));
    } catch {
      // Trace abîmée : ignorée, le cloud fait foi pour les numéros.
    }
  }
  return out.sort((a, b) => a.numero - b.numero);
}

/** Paquet à envoyer : manifeste, signature, morceaux, lus depuis la trace. */
function fichiersPaquet(dossier, morceaux) {
  return [
    { nom: L0.FICHIER_MANIFESTE, lire: () => fs.readFileSync(path.join(dossier, L0.FICHIER_MANIFESTE)) },
    { nom: L0.FICHIER_SIGNATURE, lire: () => fs.readFileSync(path.join(dossier, L0.FICHIER_SIGNATURE)) },
    ...morceaux.map((m) => ({ nom: m.nom, lire: () => fs.readFileSync(path.join(dossier, 'morceaux', m.nom)) })),
  ];
}

/** Signe, vérifie aussitôt avec la clé publique dérivée, écrit manifeste + signature. */
function signerEtEcrire(manifeste, dossier, clePrivee, clePublique) {
  const octets = L0.serialiserManifeste(manifeste);
  const signature = L0.signer(octets, clePrivee);
  // Le même contrôle que le lanceur : signature PUIS validation complète.
  L0.ouvrirManifesteSigne(octets, signature, { actuelle: clePublique });
  fs.writeFileSync(path.join(dossier, L0.FICHIER_MANIFESTE), octets);
  fs.writeFileSync(path.join(dossier, L0.FICHIER_SIGNATURE), `${signature}\n`);
  return { octets, signature };
}

function controlerIntegrite(racine, chemins, libelle) {
  const fichiers = chemins.map((c) => ({ chemin: c, taille: fs.statSync(path.join(racine, ...c.split('/'))).size }));
  const suspects = suspectsGrenam(fichiers, fichiersCaches(racine));
  if (suspects.length) {
    throw new Refus(`ALERTE GRENAM dans ${libelle} : ${suspects.slice(0, 10).join(' ; ')}. Ne rien publier, faire analyser ce poste.`);
  }
  return fichiers.reduce((t, f) => t + f.taille, 0);
}

function defender(dossier, libelle) {
  const r = scanDefender(dossier);
  if (!r.disponible) {
    dire(`  ⚠ Defender introuvable : ${libelle} non analysé (le contrôle anti-Grenam a eu lieu).`);
    return 'indisponible';
  }
  if (!r.propre) throw new Refus(`Defender signale une menace dans ${libelle} (code ${r.code}) :\n${r.sortie.slice(-1500)}`);
  dire(`  Defender : ${libelle} propre.`);
  return 'propre';
}

// ---------------------------------------------------------------- publication
async function publier(o) {
  const simulation = !!o.simulation;
  const maintenant = new Date();
  dire(`Publication POS-Samer ${simulation ? '(SIMULATION : rien ne sera envoyé)' : ''}`);

  etape('1. Dépôt git');
  const sale = git(['status', '--porcelain', '--untracked-files=all']).trim();
  if (sale) throw new Refus(`L'arbre git n'est pas propre : committez ou retirez d'abord ces changements.\n${sale.split('\n').slice(0, 15).join('\n')}`);
  const commit = git(['rev-parse', 'HEAD']).trim();
  const traces = lireTraces();
  const envoyees = traces.filter((t) => t.envoye);
  const ref = o.depuis ?? envoyees.at(-1)?.commit ?? null;
  if (!ref) {
    throw new Refus(
      'Première publication : indiquez --depuis <commit>, le commit installé aujourd’hui sur les sites ' +
        '(celui du dernier report sur la clé master, voir docs/MAJ_CLE_MASTER.md).',
    );
  }
  const commitRef = git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  dire(`  commit publié : ${commit}`);
  dire(`  sites actuels : ${commitRef}${o.depuis ? '' : ' (dernière publication locale)'}`);

  etape('2. Clé de signature');
  if (!o.cle) throw new Refus('--cle <fichier .pem de la clé USB « signature »> est obligatoire (même en simulation : on signe).');
  const cheminCle = path.resolve(o.cle);
  if (estDans(cheminCle, RACINE_DEPOT)) throw new Refus('La clé privée ne doit JAMAIS être dans le dépôt (il est public). Elle reste sur la clé USB « signature ».');
  const pem = fs.readFileSync(cheminCle, 'utf8');
  if (!pem.includes('ENCRYPTED PRIVATE KEY')) throw new Refus('Cette clé privée n’est pas chiffrée par une phrase de passe : refus (voir scripts/maj/generer-cle.mjs).');
  const phrase = await demander('Phrase de passe de la clé de signature : ', { masque: true });
  let clePrivee;
  try {
    clePrivee = crypto.createPrivateKey({ key: pem, passphrase: phrase });
  } catch {
    throw new Refus('Phrase de passe incorrecte ou clé illisible.');
  }
  if (clePrivee.asymmetricKeyType !== 'ed25519') throw new Refus('La clé de signature doit être une clé Ed25519.');
  const clePublique = crypto.createPublicKey(clePrivee);
  const empreinteCle = L0.empreinteCle(clePublique);
  dire(`  empreinte de la clé : ${empreinteCle}`);
  if (o['cle-publique'] && L0.empreinteCle(o['cle-publique']) !== empreinteCle) {
    throw new Refus('Cette clé privée ne correspond pas à la clé publique attendue (--cle-publique).');
  }

  etape('3. Cloud');
  let client = null;
  let historique = null;
  if (simulation) {
    dire('  simulation : pas de connexion.');
  } else {
    const fichierEnv = path.join(RACINE_DEPOT, 'apps', 'siege', '.env');
    const env = fs.existsSync(fichierEnv) ? lireEnvConsole(fs.readFileSync(fichierEnv, 'utf8')) : { url: null, cleAnon: null };
    client = new ClientSiege({ url: o.url ?? env.url, cleAnon: o['cle-anon'] ?? env.cleAnon });
    const email = o.email ?? (await demander('E-mail du compte siège : '));
    const mdp = await demander('Mot de passe : ', { masque: true });
    await client.connecter(email, mdp);
    const moi = await client.siege('moi');
    if (!moi.proprietaire) throw new Refus(`Le compte ${moi.nomComplet} n’est pas le propriétaire : publication refusée.`);
    historique = await client.siege('maj_historique');
    if (historique.migration_absente) throw new Refus('Migration cloud 20261023000000_maj_postes pas encore appliquée.');
    if (historique.cle_publique_empreinte !== empreinteCle) {
      throw new Refus(
        `La clé publique configurée dans le cloud (${historique.cle_publique_empreinte ?? 'aucune'}) n’est pas celle de cette clé privée (${empreinteCle}).`,
      );
    }
    dire(`  connecté : ${moi.nomComplet} (propriétaire).`);
  }

  const { numero, version } = prochaineVersion(
    maintenant,
    [...traces.map((t) => t.numero), ...(historique?.versions ?? []).map((v) => Number(v.numero))],
    o.rang ? Number(o.rang) : null,
  );
  dire(`  version : ${version} (n° ${numero})`);
  const dossierTrace = simulation ? path.join(DOSSIER_TRACES, 'simulation', String(numero)) : path.join(DOSSIER_TRACES, String(numero));
  if (simulation) fs.rmSync(dossierTrace, { recursive: true, force: true });
  else if (fs.existsSync(dossierTrace)) throw new Refus(`${dossierTrace} existe déjà : numéro déjà utilisé localement.`);
  fs.mkdirSync(path.join(dossierTrace, 'morceaux'), { recursive: true });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `pos-publication-${numero}-`));
  const arbre = path.join(tmp, 'app');
  const rapport = { numero, version, commit, depuis: commitRef, simulation, publie_le: maintenant.toISOString(), cle: empreinteCle, envoye: false };
  try {
    etape('4. Extraction du commit');
    fs.mkdirSync(arbre);
    git(['archive', '--format=tar', '-o', path.join(tmp, 'source.tar'), commit]);
    // tar lancé DANS le dossier avec un chemin relatif : le tar GNU de Git
    // prendrait « C: » d'un chemin absolu pour un hôte distant.
    const x = spawnSync('tar', ['-xf', path.join('..', 'source.tar')], { cwd: arbre, encoding: 'utf8', windowsHide: true });
    if (x.status !== 0) throw new Refus(`Extraction impossible : ${x.stderr}`);
    fs.rmSync(path.join(tmp, 'source.tar'));
    dire(`  ${arbre}`);

    etape('5. Dépendances');
    const lock = fs.readFileSync(path.join(arbre, 'pnpm-lock.yaml'));
    const empreinteDeps = sha256(lock);
    dire(`  empreinte du pnpm-lock.yaml : ${empreinteDeps}`);
    let racineDeps;
    if (o.pnpm) {
      lancerNode('pnpm install --frozen-lockfile', [path.resolve(o.pnpm), 'install', '--frozen-lockfile'], { cwd: arbre });
      racineDeps = arbre;
    } else {
      const nm = path.resolve(o['node-modules'] ?? path.join(RACINE_DEPOT, 'node_modules'));
      const lockInstalle = path.join(nm, '.pnpm', 'lock.yaml');
      if (!fs.existsSync(lockInstalle) || sha256(fs.readFileSync(lockInstalle)) !== empreinteDeps) {
        throw new Refus(`${nm} n’a pas été installé avec le pnpm-lock.yaml du commit publié : lancez pnpm install, ou passez --pnpm.`);
      }
      // Jonction : la vérification lit ce node_modules sans le recopier (≈ 900 Mo).
      fs.symlinkSync(nm, path.join(arbre, 'node_modules'), 'junction');
      for (const f of copierDependancesLocales(RACINE_DEPOT, arbre)) dire(`  copie locale : ${f}`);
      racineDeps = path.dirname(nm);
    }
    for (const f of materialiserPaquetsInternes(arbre)) dire(`  copie ${f}`);

    etape('6. Migrations et lanceur');
    const dossierDrizzle = path.join(arbre, 'apps', 'server', 'drizzle');
    const courant = lireJournal(fs.readFileSync(path.join(dossierDrizzle, 'meta', '_journal.json'), 'utf8'));
    const problemesJournal = controlerJournal(courant, fs.readdirSync(dossierDrizzle).filter((f) => f.endsWith('.sql')));
    if (problemesJournal.length) throw new Refus(`Migrations incohérentes :\n  ${problemesJournal.join('\n  ')}`);
    let journalRef = [];
    try {
      journalRef = lireJournal(git(['show', `${commitRef}:apps/server/drizzle/meta/_journal.json`]));
    } catch {
      dire('  ⚠ pas de journal drizzle dans la version des sites : toutes les migrations comptent comme nouvelles.');
    }
    const comparaison = comparerAuxSites(
      journalRef,
      courant,
      (tag) => git(['show', `${commitRef}:apps/server/drizzle/${tag}.sql`]),
      (tag) => fs.readFileSync(path.join(dossierDrizzle, `${tag}.sql`), 'utf8'),
    );
    if (comparaison.problemes.length) throw new Refus(`Migrations refusées :\n  ${comparaison.problemes.join('\n  ')}`);
    const destructives = comparaison.nouvelles.flatMap((tag) =>
      instructionsDestructives(fs.readFileSync(path.join(dossierDrizzle, `${tag}.sql`), 'utf8')).map((i) => `${tag} : ${i}`),
    );
    if (destructives.length && !o['migrations-destructives']) {
      throw new Refus(
        `Règle « ajouter d'abord, supprimer une version plus tard » : ces instructions casseraient la version précédente :\n  ${destructives.join('\n  ')}\n` +
          'Si c’est voulu (la version précédente n’utilise plus ces objets), relancez avec --migrations-destructives.',
      );
    }
    dire(`  ${courant.length} migrations, ${comparaison.nouvelles.length} nouvelle(s) : ${comparaison.nouvelles.join(', ') || 'aucune'}`);
    // PosSamer.exe ne se met pas à jour à distance avant la phase 3 : un
    // changement du lanceur publié ici n'atteindrait pas les sites (son asar
    // garde l'ancien main.js). Les tests des fondations ne comptent pas.
    const desktop = git(['diff', '--name-only', commitRef, commit, '--', 'apps/desktop'])
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('apps/desktop/maj/test/'));
    if (desktop.length && !o['desktop-modifie']) {
      throw new Refus(
        `apps/desktop a changé depuis la version des sites :\n  ${desktop.join('\n  ')}\n` +
          'Le lanceur PosSamer.exe des sites ne sera PAS mis à jour par ce paquet (phase 3). ' +
          'Si ce changement ne concerne que le serveur, relancez avec --desktop-modifie ; sinon, refaire l’exe et passer par clé USB.',
      );
    }

    etape('7. Vérifications');
    const tsc = path.join(arbre, 'node_modules', 'typescript', 'bin', 'tsc');
    for (const p of PROJETS_TSC) {
      if (fs.existsSync(path.join(arbre, p, 'tsconfig.json'))) lancerNode(`typecheck ${p}`, [tsc, '--noEmit', '-p', p], { cwd: arbre });
    }
    lancerNode('tests des fondations de mise à jour', ['--test', 'apps/desktop/maj/test/*.test.cjs'], { cwd: arbre });
    if (o['sans-tests-serveur']) {
      dire('  ⚠ tests serveur sautés (simulation).');
    } else {
      const base = o['base-test'] ?? 'pos_test_publication';
      if (base === 'pos_samer') throw new Refus('Jamais la base pos_samer pour les tests.');
      lancerNode(`tests serveur (base ${base})`, [path.join(arbre, 'node_modules', 'vitest', 'vitest.mjs'), 'run'], {
        cwd: path.join(arbre, 'apps', 'server'),
        env: { POS_TEST_DB: base },
      });
    }
    lancerNode('build de la caisse', [path.join(arbre, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: path.join(arbre, 'apps', 'caisse') });

    etape('8. Contenu et intégrité');
    fs.writeFileSync(
      path.join(arbre, L0.FICHIER_VERSION),
      `${JSON.stringify(L0.contenuVersion({ numero, version, commit, publie_le: maintenant.toISOString() }), null, 2)}\n`,
    );
    const chemins = listerFichiers(arbre, exclusionApp);
    const exes = executablesApp(chemins);
    if (exes.length) throw new Refus(`Exécutables dans le paquet APP (interdit) : ${exes.join(', ')}`);
    const tailleApp = controlerIntegrite(arbre, chemins, 'le paquet APP');
    dire(`  ${chemins.length} fichiers, ${(tailleApp / 1048576).toFixed(1)} Mo avant compression ; aucun suspect Grenam.`);
    rapport.defender_app = fs
      .readdirSync(arbre)
      .filter((n) => n !== 'node_modules')
      .map((n) => defender(path.join(arbre, n), `app/${n}`))
      .includes('indisponible')
      ? 'indisponible'
      : 'propre';

    etape('9. Paquet DEPENDANCES');
    const depsConnues = historique
      ? historique.dependances.some((d) => d.empreinte === empreinteDeps && !d.fichiers_purges_le)
      : traces.some((t) => t.empreinte_deps === empreinteDeps && t.dependances_publiees);
    let paquetDeps = null;
    if (o['sans-dependances']) {
      dire('  sauté (--sans-dependances).');
    } else if (depsConnues && !o.dependances) {
      dire('  inchangé : les sites réutilisent leur node_modules.');
    } else {
      const cheminsDeps = listerFichiers(racineDeps, exclusionDependances, { depart: 'node_modules' });
      const mauvais = cheminsDeps.map((c) => [c, L0.problemeChemin(c)]).filter(([, p]) => p);
      if (mauvais.length) throw new Refus(`Chemins refusés dans node_modules : ${mauvais.slice(0, 10).map(([c, p]) => `${c} (${p})`).join(' ; ')}`);
      const tailleDeps = controlerIntegrite(racineDeps, cheminsDeps, 'node_modules');
      rapport.defender_deps = defender(path.join(racineDeps, 'node_modules'), 'node_modules');
      const dossierDeps = simulation ? path.join(DOSSIER_TRACES, 'simulation', `deps-${empreinteDeps}`) : path.join(DOSSIER_TRACES, `deps-${empreinteDeps}`);
      fs.rmSync(dossierDeps, { recursive: true, force: true });
      fs.mkdirSync(path.join(dossierDeps, 'morceaux'), { recursive: true });
      dire(`  archive de ${cheminsDeps.length} fichiers (${(tailleDeps / 1048576).toFixed(0)} Mo)…`);
      const a = await L0.ecrireArchive({ racine: racineDeps, chemins: cheminsDeps, dossierSortie: path.join(dossierDeps, 'morceaux'), prefixe: 'deps' });
      const manifesteDeps = {
        format: L0.FORMAT_MANIFESTE,
        type: 'DEPENDANCES',
        publie_le: maintenant.toISOString(),
        node_min: NODE_MIN,
        empreinte: empreinteDeps,
        notes: `node_modules du pnpm-lock.yaml ${empreinteDeps.slice(0, 12)} (commit ${commit.slice(0, 7)}), sans electron ni electron-builder.`,
        archive: a.archive,
        morceaux: a.morceaux,
        fichiers: a.fichiers,
      };
      signerEtEcrire(manifesteDeps, dossierDeps, clePrivee, clePublique);
      paquetDeps = { dossier: dossierDeps, morceaux: a.morceaux };
      dire(`  ${a.morceaux.length} morceau(x), ${(a.archive.taille / 1048576).toFixed(1)} Mo compressés, signé.`);
    }

    etape('10. Archive et signature');
    const notes = (o.notes ?? (o['notes-fichier'] ? fs.readFileSync(o['notes-fichier'], 'utf8') : git(['log', '--format=- %s', `${commitRef}..${commit}`])))
      .trim()
      .slice(0, L0.LIMITES.notes);
    const a = await L0.ecrireArchive({ racine: arbre, chemins, dossierSortie: path.join(dossierTrace, 'morceaux'), prefixe: 'code' });
    const manifeste = {
      format: L0.FORMAT_MANIFESTE,
      type: 'APP',
      numero,
      version,
      commit,
      publie_le: maintenant.toISOString(),
      node_min: NODE_MIN,
      lanceur_min: o['lanceur-min'] ? Number(o['lanceur-min']) : LANCEUR_MIN_DEFAUT,
      dependances: { empreinte: empreinteDeps },
      migrations: {
        derniere: courant.length ? courant[courant.length - 1].tag : null,
        nouvelles: comparaison.nouvelles,
        retrocompatibles: destructives.length === 0,
      },
      notes,
      archive: a.archive,
      morceaux: a.morceaux,
      fichiers: a.fichiers,
    };
    signerEtEcrire(manifeste, dossierTrace, clePrivee, clePublique);
    dire(`  ${a.morceaux.length} morceau(x), ${(a.archive.taille / 1048576).toFixed(1)} Mo compressés, signé et revérifié.`);
    Object.assign(rapport, {
      empreinte_deps: empreinteDeps,
      dependances_publiees: !!paquetDeps,
      migrations: manifeste.migrations,
      fichiers: chemins.length,
      taille_archive: a.archive.taille,
    });

    etape('11. Envoi');
    if (simulation) {
      dire(`  simulation : rien n'est envoyé. Paquet prêt dans ${dossierTrace}`);
    } else {
      if (paquetDeps) {
        dire('  paquet DEPENDANCES…');
        await client.envoyerPaquet({ type: 'DEPENDANCES', empreinte: empreinteDeps }, fichiersPaquet(paquetDeps.dossier, paquetDeps.morceaux), dire);
      }
      dire('  paquet APP…');
      const r = await client.envoyerPaquet({ type: 'APP', numero }, fichiersPaquet(dossierTrace, a.morceaux), dire);
      rapport.envoye = true;
      dire(`  ${version} enregistrée en BROUILLON (clé ${r.cle}).`);
      if (r.avertissement) dire(`  ⚠ ${r.avertissement}`);
      dire('  Suite : console du siège → Mises à jour → « Envoyer au pilote » (Angré 7E), puis après 48 h « Envoyer à tous ».');
    }
  } finally {
    fs.writeFileSync(path.join(dossierTrace, 'publication.json'), `${JSON.stringify(rapport, null, 2)}\n`);
    fs.writeFileSync(path.join(dossierTrace, 'journal.txt'), `${journal.join('\n')}\n`);
    if (o['garder-temp']) {
      dire(`Dossier temporaire conservé : ${tmp}`);
    } else {
      // La jonction d'abord : un effacement récursif qui la suivrait viderait
      // le node_modules du dépôt.
      retirerSansSuivre(path.join(arbre, 'node_modules'));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

try {
  const o = lireOptions(process.argv.slice(2));
  if (o.aide) {
    process.stdout.write(AIDE);
  } else {
    await publier(o);
  }
} catch (e) {
  process.stderr.write(`\nPUBLICATION ARRÊTÉE : ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
}
