'use strict';
// Opérations RÉELLES des étapes d'installation (lot L4), branchées sur
// l'exécuteur générique de installation.cjs (`executerInstallation` /
// `executerRetour`).
//
// Partage des rôles :
// - tout ce qui touche le DISQUE est fait ici, pour de vrai (sauvegarde de
//   pgdata, échange `app` ↔ `app.precedente`, node_modules, `.env`, copies
//   `@pos/*`, restauration, nettoyage) : c'est ce que le banc d'essai doit
//   éprouver ;
// - tout ce qui pilote un PROCESSUS (API, Vite, serveur, PostgreSQL,
//   migrations) est INJECTÉ via `processus` : main.js fournit les vrais
//   spawn/pg_ctl, le banc d'essai des faux.
//
// Chaque opération de RETOUR est idempotente : après une coupure, le lanceur
// rejoue tout le retour arrière, et chaque étape doit retrouver ses petits à
// partir de l'état des dossiers, quel qu'il soit.
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { ErreurMaj } = require('./erreurs.cjs');
const { renommerAvecReprises, ecrireJsonAtomique, attendre } = require('./disque.cjs');
const { ouvrirManifesteSigne, problemesCompatibilite } = require('./manifeste.cjs');
const { verifierArbre } = require('./archive.cjs');
const { lireVersion, deciderMontee } = require('./version.cjs');
const { nomSauvegarde, lireNomSauvegarde, choisirSauvegardesASupprimer } = require('./retention.cjs');
const {
  FICHIER_EMPREINTE_DEPS,
  cheminsSite,
  resoudreDansRacine,
  lireEtat,
  lireEmpreinteDeps,
  tailleDossier,
  espaceLibre,
} = require('./site.cjs');

const MARQUEUR_COMPLET = 'COMPLET';
const MO = 1024 * 1024;
const JOUR = 24 * 60 * 60 * 1000;

/** Délais par défaut (plan § 3 et consignes du 23/10). */
const DELAIS_DEFAUT = Object.freeze({
  santeTotalMs: 90_000, // contrôle de santé complet
  santeVivantApresMs: 20_000, // le serveur doit encore être vivant 20 s après son lancement
  santeIntervalleMs: 1_000,
  // Renommages retentés ~60 s (Defender, indexeur) : 100 ms × (1+2+…+35) ≈ 63 s.
  renommageEssais: 35,
  renommageDelaiMs: 100,
});

const existe = (p) => fsp.lstat(p).then(() => true, () => false);

function horodatage(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** `base` s'il est libre, sinon `base-2`, `base-3`… (deux retours dans la même seconde, horloge figée). */
async function nomLibre(base) {
  if (!(await existe(base))) return base;
  for (let i = 2; ; i++) if (!(await existe(`${base}-${i}`))) return `${base}-${i}`;
}

function erreur(code, message, { definitif = false, details } = {}) {
  const e = new ErreurMaj(code, message, details);
  if (definitif) e.definitif = true;
  return e;
}

/** Sous-dossiers directs (noms) d'un dossier, [] s'il n'existe pas. */
async function sousDossiers(dossier) {
  try {
    return (await fsp.readdir(dossier, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Emplacements des `node_modules` d'un arbre pnpm « hoisted » : la racine, et
 * ceux que pnpm laisse dans chaque app ou paquet (copies `@pos/*`, versions en
 * conflit). Chemins relatifs avec `/`.
 */
async function emplacementsNodeModules(arbre) {
  const liste = ['node_modules'];
  for (const groupe of ['apps', 'packages']) {
    for (const nom of await sousDossiers(path.join(arbre, groupe))) liste.push(`${groupe}/${nom}/node_modules`);
  }
  return liste;
}

const abs = (racine, rel) => path.join(racine, ...rel.split('/'));

/**
 * Recopie chaque paquet du workspace (`packages/<p>`) dans les
 * `apps/<a>/node_modules/@pos/<p>` qui en dépendent.
 *
 * Sur les sites, ces dossiers sont de VRAIES copies (`injectWorkspacePackages`),
 * pas des liens : on l'a payé le 22/10 (copies du 05/09 restées en place après
 * trois reports, serveur qui chargeait un ancien `@pos/shared`). Un paquet APP
 * ne livre pas les node_modules ; on régénère donc ces copies depuis les
 * sources livrées, à chaque installation et à chaque retour arrière.
 */
async function rafraichirCopiesPos(arbre) {
  const paquets = new Map();
  for (const nom of await sousDossiers(path.join(arbre, 'packages'))) {
    try {
      const pj = JSON.parse(await fsp.readFile(path.join(arbre, 'packages', nom, 'package.json'), 'utf8'));
      if (pj.name) paquets.set(pj.name, path.join(arbre, 'packages', nom));
    } catch { /* pas un paquet */ }
  }
  let copies = 0;
  for (const appNom of await sousDossiers(path.join(arbre, 'apps'))) {
    let pj;
    try {
      pj = JSON.parse(await fsp.readFile(path.join(arbre, 'apps', appNom, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const deps = { ...(pj.dependencies || {}), ...(pj.devDependencies || {}) };
    for (const [nom, spec] of Object.entries(deps)) {
      if (!String(spec).startsWith('workspace:') || !paquets.has(nom)) continue;
      const cible = path.join(arbre, 'apps', appNom, 'node_modules', ...nom.split('/'));
      await fsp.rm(cible, { recursive: true, force: true });
      await fsp.mkdir(path.dirname(cible), { recursive: true });
      const source = paquets.get(nom);
      await fsp.cp(source, cible, {
        recursive: true,
        filter: (src) => path.relative(source, src).split(path.sep)[0] !== 'node_modules',
      });
      copies += 1;
    }
  }
  return copies;
}

/** Fichiers propres au site (jamais livrés par un paquet) : les `.env*` de la racine, des apps et des paquets. */
async function fichiersPropresAuSite(arbre) {
  const dossiers = [''];
  for (const groupe of ['apps', 'packages']) {
    for (const nom of await sousDossiers(path.join(arbre, groupe))) dossiers.push(`${groupe}/${nom}`);
  }
  const trouves = [];
  for (const rel of dossiers) {
    let entrees;
    try {
      entrees = await fsp.readdir(rel ? abs(arbre, rel) : arbre, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entrees) if (e.isFile() && /^\.env/.test(e.name)) trouves.push(rel ? `${rel}/${e.name}` : e.name);
  }
  return trouves;
}

/** GET http minimal (contrôle de santé) : { statut, type, corps } ; rejette sur erreur réseau ou délai. */
function obtenir(url, delaiMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const morceaux = [];
      res.on('data', (b) => {
        if (morceaux.length < 64) morceaux.push(b);
      });
      res.on('end', () => resolve({ statut: res.statusCode, type: String(res.headers['content-type'] || ''), corps: Buffer.concat(morceaux).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(delaiMs, () => req.destroy(new Error('délai dépassé')));
    req.on('error', reject);
  });
}

/**
 * Contrôle de santé de la version fraîchement démarrée (plan § 3, point 6) :
 * `/api/sante` (base joignable), `/api/sante/version` = numéro attendu, page
 * de la caisse servie, et serveur toujours vivant `vivantApresMs` après son
 * lancement (un serveur qui répond puis meurt sur une erreur différée doit
 * être refusé). Lève `SANTE_KO` avec la dernière cause connue.
 */
async function controlerSante({
  port,
  hote = '127.0.0.1',
  numero,
  estVivant = () => true,
  totalMs = DELAIS_DEFAUT.santeTotalMs,
  vivantApresMs = DELAIS_DEFAUT.santeVivantApresMs,
  intervalleMs = DELAIS_DEFAUT.santeIntervalleMs,
  maintenant = () => Date.now(),
}) {
  const debut = maintenant();
  const base = `http://${hote}:${port}`;
  let cause = 'le serveur ne répond pas';
  const ok = { sante: false, version: false, caisse: false };
  for (;;) {
    if (!estVivant()) throw erreur('SANTE_KO', 'Contrôle de santé raté : le serveur de la nouvelle version s’est arrêté.');
    try {
      if (!ok.sante) {
        const r = await obtenir(`${base}/api/sante`, 5000);
        if (r.statut === 200) ok.sante = true;
        else cause = `/api/sante répond ${r.statut}`;
      }
      if (ok.sante && !ok.version) {
        const r = await obtenir(`${base}/api/sante/version`, 5000);
        let lu = null;
        try { lu = JSON.parse(r.corps).numero; } catch { /* corps illisible */ }
        if (r.statut === 200 && lu === numero) ok.version = true;
        else cause = `la version qui tourne n’est pas la bonne (attendu ${numero}, lu ${lu})`;
      }
      if (ok.version && !ok.caisse) {
        const r = await obtenir(`${base}/`, 5000);
        if (r.statut === 200 && /html/i.test(r.type) && /<html/i.test(r.corps)) ok.caisse = true;
        else cause = `la page de la caisse n’est pas servie (${r.statut})`;
      }
    } catch (e) {
      cause = `le serveur ne répond pas (${e.message})`;
    }
    const ecoule = maintenant() - debut;
    if (ok.sante && ok.version && ok.caisse && ecoule >= vivantApresMs) {
      if (!estVivant()) continue; // re-testé en tête de boucle
      return;
    }
    if (ecoule >= totalMs) throw erreur('SANTE_KO', `Contrôle de santé raté : ${cause}.`);
    await attendre(intervalleMs);
  }
}

/**
 * Fabrique les opérations d'installation et de retour pour un site.
 *
 * @param {object} o
 * @param {string} o.racine            ROOT (dossier de PosSamer.exe)
 * @param {object|null} o.trousseau    clés publiques DU LANCEUR
 * @param {number} o.numeroLanceur
 * @param {() => Promise<string>} o.versionNode   version du node portable (runtime/node)
 * @param {object} o.processus         arreterApi, arreterVite, arreterServeur, arreterPg, demarrerPg,
 *                                     migrer, demarrerServeur({validation}) → {vivant()}, validerServeur(),
 *                                     serveurActif()
 * @param {number} o.port              port HTTP du serveur (contrôle de santé)
 * @param {object} [o.delais]          voir DELAIS_DEFAUT
 * @param {number} [o.margeEspaceOctets] marge exigée en plus de la sauvegarde
 * @param {() => Date} [o.horloge]
 * @param {(m: string) => void} [o.log]
 * @param {(texte: string) => void} [o.progression]  texte affiché sur la page « Mise à jour en cours »
 * @param {(point: string) => Promise<void>|void} [o.pointCoupure] banc d'essai : coupure simulée
 * @param {(chemin: string) => Promise<number|null>} [o.mesurerEspace]
 */
function creerOperations(o) {
  const chemins = cheminsSite(o.racine);
  const delais = { ...DELAIS_DEFAUT, ...(o.delais || {}) };
  const horloge = o.horloge || (() => new Date());
  const log = o.log || (() => {});
  const progression = o.progression || (() => {});
  const coupure = o.pointCoupure || (() => {});
  const mesurerEspace = o.mesurerEspace || espaceLibre;
  const marge = o.margeEspaceOctets ?? 300 * MO;
  const p = o.processus;

  const renommer = (src, dst) => renommerAvecReprises(src, dst, { essais: delais.renommageEssais, delaiMs: delais.renommageDelaiMs });

  /** Journal persisté avec un champ libre en plus (nom de la sauvegarde…). */
  async function noterDansJournal(journal, champs) {
    Object.assign(journal, champs);
    await ecrireJsonAtomique(chemins.journal, journal);
  }

  /** Paquet prêt d'après etat.json, revérifié avec la clé DU LANCEUR. */
  async function chargerPret(numero) {
    const etat = await lireEtat(chemins.etat);
    const pret = etat.pret;
    if (!pret || pret.numero !== numero) {
      throw erreur('PAQUET_ABSENT', `La version ${numero} n’est plus prête sur ce poste.`);
    }
    if (!o.trousseau) throw erreur('CLE_ABSENTE', 'Aucune clé publique de mise à jour dans ce programme.');
    let ouvert;
    try {
      ouvert = ouvrirManifesteSigne(Buffer.from(String(pret.manifeste || ''), 'utf8'), pret.signature, o.trousseau);
    } catch (e) {
      e.definitif = true; // signature fausse ou manifeste invalide : réessayer ne changera rien
      throw e;
    }
    const m = ouvert.manifeste;
    if (m.type !== 'APP' || m.numero !== numero) {
      throw erreur('MANIFESTE_INVALIDE', 'Le manifeste signé ne correspond pas à la version prête.', { definitif: true });
    }
    const dossier = resoudreDansRacine(chemins.racine, pret.dossier);
    if (!dossier) throw erreur('PAQUET_ABSENT', 'Chemin de la version prête invalide.', { definitif: true });
    let deps = null;
    if (pret.dependances) {
      const d = pret.dependances;
      const dossierNm = resoudreDansRacine(chemins.racine, d.dossier);
      if (!dossierNm || path.basename(dossierNm) !== 'node_modules') {
        throw erreur('PAQUET_ABSENT', 'Chemin des dépendances préparées invalide.', { definitif: true });
      }
      let md;
      try {
        md = ouvrirManifesteSigne(Buffer.from(String(d.manifeste || ''), 'utf8'), d.signature, o.trousseau).manifeste;
      } catch (e) {
        e.definitif = true;
        throw e;
      }
      if (md.type !== 'DEPENDANCES' || md.empreinte !== m.dependances.empreinte || d.empreinte !== md.empreinte) {
        throw erreur('MANIFESTE_INVALIDE', 'Le paquet de dépendances ne correspond pas à cette version.', { definitif: true });
      }
      deps = { manifeste: md, racine: path.dirname(dossierNm), empreinte: md.empreinte };
    }
    return { pret, manifeste: m, dossier, deps };
  }

  // ------------------------------------------------------------ installation

  async function VERIFICATION({ journal }) {
    progression('Vérification du paquet…');
    const { manifeste: m, dossier, deps } = await chargerPret(journal.numero);
    const installee = lireVersion(chemins.app);
    if (deciderMontee(installee, m) !== 'INSTALLER') {
      throw erreur('VERSION_REFUSEE', `La version ${m.version} n’est pas plus récente que celle installée.`, { definitif: true });
    }
    const problemes = problemesCompatibilite(m, { lanceur: o.numeroLanceur, node: await o.versionNode() });
    if (problemes.length) throw erreur('INCOMPATIBLE', problemes.join(' '), { definitif: true });
    if (!(await existe(dossier))) throw erreur('PAQUET_ABSENT', 'Le dossier de la version préparée a disparu.');
    await verifierArbre(dossier, m);
    const locale = lireEmpreinteDeps(chemins.app);
    if (deps) {
      if (!(await existe(path.join(deps.racine, 'node_modules')))) throw erreur('PAQUET_ABSENT', 'Les dépendances préparées ont disparu.');
      await verifierArbre(deps.racine, deps.manifeste);
    } else if (locale && locale !== m.dependances.empreinte) {
      throw erreur('DEPENDANCES_ABSENTES', 'Cette version demande de nouvelles dépendances, pas encore téléchargées.');
    }
    // Espace : la sauvegarde de pgdata est la seule vraie copie (le reste est
    // fait de renommages sur le même disque).
    const libre = await mesurerEspace(chemins.racine);
    const besoin = (await tailleDossier(chemins.pgdata)) + marge;
    if (libre !== null && libre < besoin) {
      throw erreur('ESPACE_INSUFFISANT', `Espace disque insuffisant : ${Math.round(libre / MO)} Mo libres, ${Math.round(besoin / MO)} Mo nécessaires.`);
    }
    // L'ancienne `app.precedente` (version d'avant la dernière installation)
    // laisse la place : on n'en garde qu'une.
    if (await existe(chemins.appPrecedente)) {
      const jeter = `${chemins.appPrecedente}.supprimer-${horodatage(horloge())}`;
      await renommer(chemins.appPrecedente, jeter);
      await fsp.rm(jeter, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function ARRET() {
    progression('Arrêt de la caisse…');
    // Ordre du plan : l'API d'abord (503 « Mise à jour en cours », requêtes
    // en cours terminées), puis les Vite, le serveur, et PostgreSQL en dernier.
    await p.arreterApi().catch((e) => log(`arreterApi : ${e.message || e}`));
    await coupure('ARRET_API');
    await p.arreterVite();
    await p.arreterServeur();
    await coupure('ARRET_SERVEUR');
    await p.arreterPg();
  }

  async function SAUVEGARDE_BASE({ journal }) {
    progression('Sauvegarde de la base…');
    if (!(await existe(chemins.pgdata))) throw erreur('BASE_ABSENTE', 'Dossier de la base introuvable (data/pgdata).');
    const nom = nomSauvegarde(journal.numero, horloge());
    const final = path.join(chemins.sauvegardes, nom);
    const partiel = `${final}.partiel`;
    await fsp.mkdir(chemins.sauvegardes, { recursive: true });
    await fsp.rm(partiel, { recursive: true, force: true });
    await fsp.cp(chemins.pgdata, partiel, { recursive: true });
    await coupure('SAUVEGARDE_COPIEE');
    // Le marqueur n'est posé qu'une fois la copie entière : une sauvegarde sans
    // lui n'est jamais restaurée.
    await fsp.writeFile(path.join(partiel, MARQUEUR_COMPLET), `${new Date(horloge()).toISOString()}\n`);
    await renommer(partiel, final);
    await noterDansJournal(journal, { sauvegarde: nom });
    log(`sauvegarde ${nom} faite`);
  }

  async function ECHANGE_CODE({ journal }) {
    progression('Installation du nouveau code…');
    const { manifeste: m, dossier: nouveau, deps } = await chargerPret(journal.numero);
    if (!(await existe(nouveau))) throw erreur('PAQUET_ABSENT', 'La version préparée a disparu.');

    // 1. Fichiers propres au site (.env…), recopiés (jamais déplacés : l'ancien
    //    arbre doit rester complet pour un retour arrière).
    for (const rel of await fichiersPropresAuSite(chemins.app)) {
      const cible = abs(nouveau, rel);
      if (await existe(path.dirname(cible))) await fsp.copyFile(abs(chemins.app, rel), cible);
    }

    // 2. Dépendances : nouveau paquet si l'empreinte change, sinon on DÉPLACE
    //    les node_modules en place (simple renommage, quelques millisecondes).
    if (deps) {
      for (const rel of await emplacementsNodeModules(deps.racine)) {
        const src = abs(deps.racine, rel);
        if ((await existe(src)) && (await existe(path.dirname(abs(nouveau, rel))))) await renommer(src, abs(nouveau, rel));
      }
      await fsp.writeFile(path.join(nouveau, 'node_modules', FICHIER_EMPREINTE_DEPS), `${m.dependances.empreinte}\n`);
    } else {
      for (const rel of await emplacementsNodeModules(chemins.app)) {
        const src = abs(chemins.app, rel);
        const dst = abs(nouveau, rel);
        if ((await existe(src)) && !(await existe(dst)) && (await existe(path.dirname(dst)))) await renommer(src, dst);
      }
    }
    await coupure('ECHANGE_DEPS');
    await rafraichirCopiesPos(nouveau);

    // 3. L'échange lui-même : deux renommages.
    await coupure('ECHANGE_AVANT_RENOMMAGE');
    await renommer(chemins.app, chemins.appPrecedente);
    await coupure('ECHANGE_ENTRE_RENOMMAGES');
    await renommer(nouveau, chemins.app);
    await coupure('ECHANGE_FIN');
  }

  async function MIGRATIONS() {
    progression('Mise à jour de la base…');
    await p.demarrerPg();
    await coupure('MIGRATIONS_PG');
    try {
      await p.migrer();
    } catch (e) {
      throw erreur('MIGRATION_ECHOUEE', `Mise à jour de la base impossible : ${e.message || e}`);
    }
  }

  async function VALIDATION({ journal }) {
    progression('Contrôle de la nouvelle version…');
    const serveur = await p.demarrerServeur({ validation: true });
    await coupure('VALIDATION_DEMARRE');
    await controlerSante({
      port: o.port,
      numero: journal.numero,
      estVivant: () => serveur.vivant(),
      totalMs: delais.santeTotalMs,
      vivantApresMs: delais.santeVivantApresMs,
      intervalleMs: delais.santeIntervalleMs,
    });
  }

  async function FINALISATION({ journal }) {
    progression('Réouverture de la caisse…');
    // La nouvelle version a passé sa validation : plus rien ici ne doit
    // provoquer de retour arrière. Toute erreur est journalisée et rattrapée.
    try {
      if (p.serveurActif()) {
        await p.validerServeur();
      } else {
        // Reprise après coupure : rien ne tourne, on démarre normalement.
        await p.demarrerPg();
        await p.demarrerServeur({ validation: false });
      }
    } catch (e) {
      log(`finalisation : sortie du mode validation ratée (${e.message || e}), redémarrage normal du serveur`);
      try {
        await p.arreterServeur();
        await p.demarrerServeur({ validation: false });
      } catch (e2) {
        log(`finalisation : redémarrage du serveur raté (${e2.message || e2})`);
      }
    }
    await coupure('FINALISATION_SERVEUR');
    await nettoyer({ numero: journal.numero, proteger: journal.sauvegarde ? [journal.sauvegarde] : [] });
  }

  // ------------------------------------------------------------ retour arrière

  async function RETOUR_ARRET() {
    progression('Retour à la version précédente…');
    await p.arreterVite();
    await p.arreterServeur();
    await p.arreterPg();
  }

  async function RETOUR_CODE({ journal }) {
    const numero = journal.numero;
    let echec = null;
    const appExiste = await existe(chemins.app);
    if (appExiste && lireVersion(chemins.app).numero === numero) {
      // La nouvelle version est en place : on la met de côté.
      if (!(await existe(chemins.appPrecedente))) {
        throw erreur('RETOUR_IMPOSSIBLE', 'Retour arrière impossible : l’ancienne version (app.precedente) a disparu.', { definitif: true });
      }
      echec = await nomLibre(path.join(chemins.racine, `app.echec-${numero}-${horodatage(horloge())}`));
      await renommer(chemins.app, echec);
      await coupure('RETOUR_CODE_ECARTE');
    }
    if (!(await existe(chemins.app))) {
      if (!(await existe(chemins.appPrecedente))) {
        throw erreur('RETOUR_IMPOSSIBLE', 'Retour arrière impossible : ni app ni app.precedente.', { definitif: true });
      }
      await renommer(chemins.appPrecedente, chemins.app);
    }
    await coupure('RETOUR_CODE_REMIS');
    // node_modules déplacés vers la nouvelle version (dépendances inchangées) :
    // on les ramène, où qu'ils soient restés.
    const candidats = [];
    if (echec) candidats.push(echec);
    for (const nom of await sousDossiers(chemins.racine)) {
      if (nom.startsWith(`app.echec-${numero}-`) && path.join(chemins.racine, nom) !== echec) candidats.push(path.join(chemins.racine, nom));
    }
    candidats.push(path.join(chemins.pret, String(numero), 'app'));
    let ramenes = 0;
    for (const rel of await emplacementsNodeModules(chemins.app)) {
      const dst = abs(chemins.app, rel);
      if (await existe(dst)) continue;
      for (const c of candidats) {
        const src = abs(c, rel);
        if (await existe(src)) {
          await renommer(src, dst);
          ramenes += 1;
          break;
        }
      }
    }
    // Les copies @pos/* ont pu être régénérées depuis le NOUVEAU code : on les
    // refait depuis les paquets de la version remise en place.
    if (ramenes > 0) await rafraichirCopiesPos(chemins.app);
  }

  async function RETOUR_BASE({ journal }) {
    progression('Restauration de la base…');
    const nom = journal.sauvegarde;
    const source = nom ? path.join(chemins.sauvegardes, nom) : null;
    if (!source || !(await existe(path.join(source, MARQUEUR_COMPLET)))) {
      throw erreur('SAUVEGARDE_ABSENTE', 'Restauration impossible : la sauvegarde de la base est introuvable ou incomplète.', { definitif: true });
    }
    const restauration = `${chemins.pgdata}.restauration`;
    await fsp.rm(restauration, { recursive: true, force: true });
    await fsp.cp(source, restauration, {
      recursive: true,
      filter: (src) => path.relative(source, src) !== MARQUEUR_COMPLET,
    });
    await coupure('RETOUR_BASE_COPIEE');
    if (await existe(chemins.pgdata)) {
      await renommer(chemins.pgdata, await nomLibre(path.join(chemins.data, `pgdata.echec-${journal.numero}-${horodatage(horloge())}`)));
    }
    await coupure('RETOUR_BASE_ECARTEE');
    await renommer(restauration, chemins.pgdata);
  }

  // ------------------------------------------------------------ nettoyage

  /**
   * Après une installation (ou un retour) : dossiers de préparation de la
   * version traitée, sauvegardes hors rétention (7 jours, au moins 2), restes
   * `*.echec-*` (on garde le plus récent s'il a moins de 7 jours, pour le
   * diagnostic). Ne lève jamais : un nettoyage raté coûte de la place, pas la
   * caisse.
   */
  async function nettoyer({ numero, proteger = [] } = {}) {
    const maintenant = horloge();
    const supprimer = async (p2) => {
      try {
        await fsp.rm(p2, { recursive: true, force: true });
      } catch (e) {
        log(`nettoyage : ${p2} non supprimé (${e.code || e.message})`);
      }
    };
    try {
      if (numero !== undefined) {
        await supprimer(path.join(chemins.pret, String(numero)));
        await supprimer(path.join(chemins.telechargement, String(numero)));
      }
      // Dépendances déplacées dans app/ : le dossier deps-<e> n'est plus qu'une coquille.
      for (const nom of await sousDossiers(chemins.pret)) {
        if (nom.startsWith('deps-') && !(await existe(path.join(chemins.pret, nom, 'node_modules')))) await supprimer(path.join(chemins.pret, nom));
      }
      // Sauvegardes
      const sauvegardes = [];
      for (const nom of await sousDossiers(chemins.sauvegardes)) {
        if (nom.endsWith('.partiel')) {
          await supprimer(path.join(chemins.sauvegardes, nom));
          continue;
        }
        const lu = lireNomSauvegarde(nom);
        if (lu) sauvegardes.push(lu);
      }
      for (const nom of choisirSauvegardesASupprimer(sauvegardes, maintenant, { proteger })) {
        await supprimer(path.join(chemins.sauvegardes, nom));
      }
      // Restes d'échec et anciennes versions
      for (const [dossier, motif] of [
        [chemins.racine, /^app\.echec-/],
        [chemins.data, /^pgdata\.echec-/],
      ]) {
        const noms = (await sousDossiers(dossier)).filter((n) => motif.test(n));
        const dates = await Promise.all(noms.map(async (n) => ({ n, t: (await fsp.stat(path.join(dossier, n))).mtimeMs })));
        dates.sort((a, b) => b.t - a.t);
        for (const [i, { n, t }] of dates.entries()) {
          if (i === 0 && maintenant.getTime() - t < 7 * JOUR) continue;
          await supprimer(path.join(dossier, n));
        }
      }
      for (const nom of await sousDossiers(chemins.racine)) {
        if (nom.startsWith('app.precedente.supprimer-')) await supprimer(path.join(chemins.racine, nom));
      }
    } catch (e) {
      log(`nettoyage interrompu : ${e.message || e}`);
    }
  }

  return {
    operations: { VERIFICATION, ARRET, SAUVEGARDE_BASE, ECHANGE_CODE, MIGRATIONS, VALIDATION, FINALISATION, RETOUR_ARRET, RETOUR_CODE, RETOUR_BASE },
    nettoyer,
  };
}

module.exports = {
  DELAIS_DEFAUT,
  MARQUEUR_COMPLET,
  creerOperations,
  controlerSante,
  rafraichirCopiesPos,
  fichiersPropresAuSite,
  emplacementsNodeModules,
  _existe: existe,
};
