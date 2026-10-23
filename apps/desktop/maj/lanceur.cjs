'use strict';
// Chef d'orchestre de la mise à jour côté LANCEUR (lot L4) : quand installer,
// reprise après coupure, retour arrière. Sans Electron ni processus : main.js
// lui passe les opérations (operations.cjs) et affiche ce qu'il faut ; le banc
// d'essai l'appelle directement.
//
// Deux points d'entrée :
// - `auDemarrage()` : AVANT d'ouvrir la caisse. Termine ou défait une
//   installation interrompue (deciderReprise), puis installe si un paquet est
//   prêt et que la règle du site le veut (« ferme la nuit » : toujours au
//   démarrage ; 24h/24 : si l'heure prévue est passée pendant que le poste
//   était éteint) ;
// - `verifierCreneau()` : toutes les 60 s pendant le service, installe quand
//   `deciderCreneau` répond INSTALLER (06h00 des sites 24h/24, filet 05h00,
//   fin du report, demande du siège).
//
// Le lanceur ne fait confiance à etat.json (écrit par le serveur) que pour
// SAVOIR quoi regarder : les opérations revérifient signature et empreintes
// avec la clé publique embarquée dans PosSamer.exe.
const { ecrireJsonAtomique } = require('./disque.cjs');
const { deciderCreneau, TYPES_SITE } = require('./creneau.cjs');
const { lireVersion, deciderMontee } = require('./version.cjs');
const {
  ETATS,
  TENTATIVES_MAX,
  lireJournal,
  ecrireJournal,
  deciderReprise,
  peutTenter,
  estRefusee,
  nouveauJournal,
  journalPourReprise,
  executerInstallation,
  executerRetour,
} = require('./installation.cjs');
const { cheminsSite, lireEtat, lireMemoireLanceur } = require('./site.cjs');

/** Entrée de `deciderCreneau` d'après les réglages reçus du siège (défauts L0 si absents ou invalides). */
function entreeCreneau(reglages, base) {
  const r = reglages || {};
  const entree = {
    ...base,
    typeSite: TYPES_SITE[r.type_site] ? r.type_site : TYPES_SITE.H24,
    pause: r.pause === true,
  };
  if (typeof r.heure_installation === 'string') entree.heureInstallation = r.heure_installation;
  if (typeof r.heure_filet === 'string') entree.heureFilet = r.heure_filet;
  return entree;
}

/** deciderCreneau, avec repli sur les heures par défaut si le siège a envoyé un réglage illisible. */
function deciderAvecRepli(entree) {
  try {
    return deciderCreneau(entree);
  } catch {
    const { heureInstallation, heureFilet, ...reste } = entree;
    return deciderCreneau(reste);
  }
}

/**
 * Situation d'installation, PURE à partir des fichiers lus : sert au lanceur
 * ET au serveur (bandeau de la caisse, battement), pour que les deux disent
 * exactement la même chose.
 *
 * @returns {{ pret: object|null, decision: object|null, raison: string|null, installerMaintenant: string|null }}
 */
function situationInstallation({ etat, journal, memoire, installee, maintenant, auDemarrage, tentativesMax = TENTATIVES_MAX }) {
  const pret = etat && etat.pret;
  if (!pret || !Number.isSafeInteger(pret.numero)) return { pret: null, decision: null, raison: 'AUCUN_PAQUET', installerMaintenant: null };
  if (deciderMontee(installee, pret) !== 'INSTALLER') return { pret, decision: null, raison: 'DEJA_INSTALLEE', installerMaintenant: null };
  const lisible = journal && !journal.illisible ? journal : null;
  if (journal && journal.illisible) return { pret, decision: null, raison: 'JOURNAL_ILLISIBLE', installerMaintenant: null };
  if (estRefusee(lisible, pret.numero)) return { pret, decision: null, raison: 'REFUSEE', installerMaintenant: null };
  if (!peutTenter(lisible, pret.numero, { tentativesMax })) return { pret, decision: null, raison: 'TENTATIVES_EPUISEES', installerMaintenant: null };
  const reglages = (etat && etat.reglages) || {};
  const jeton = reglages.installer_maintenant || null;
  const traite = memoire && memoire.jetons_traites ? memoire.jetons_traites.installer_maintenant : null;
  const installerMaintenant = jeton && jeton !== traite ? jeton : null;
  const report = etat.report && etat.report.numero === pret.numero && etat.report.demande_le ? { demandeLe: new Date(etat.report.demande_le) } : null;
  const decision = deciderAvecRepli(
    entreeCreneau(reglages, {
      maintenant,
      pretLe: new Date(pret.pret_le),
      auDemarrage,
      report,
      installerMaintenant: Boolean(installerMaintenant),
    }),
  );
  return { pret, decision, raison: null, installerMaintenant };
}

/**
 * @param {object} o
 * @param {string} o.racine
 * @param {object|null} o.trousseau      null = mise à jour désactivée
 * @param {string|null} [o.motifSansCle]
 * @param {object} o.operations          sortie `operations` de creerOperations
 * @param {(o: {numero?: number, proteger?: string[]}) => Promise<void>} [o.nettoyer]
 * @param {() => Date} [o.horloge]
 * @param {(m: string) => void} [o.log]
 * @param {(info: {numero: number, version: string, reprise: boolean}) => void|Promise<void>} [o.avantInstallation]
 *        appelé juste avant de toucher à quoi que ce soit (afficher « Mise à jour en cours »)
 */
function creerLanceurMaj(o) {
  const chemins = cheminsSite(o.racine);
  const horloge = o.horloge || (() => new Date());
  const log = o.log || (() => {});
  const avant = o.avantInstallation || (() => {});
  const nettoyer = o.nettoyer || (async () => {});
  let enCours = false;

  async function ecrireMemoire(memoire) {
    await ecrireJsonAtomique(chemins.lanceur, memoire);
  }

  /**
   * « Réessayer » demandé par le siège : on lève les refus locaux et on remet
   * le compteur de tentatives à zéro, une seule fois par jeton.
   */
  async function traiterReessayer(etat, journal, memoire) {
    const jeton = etat.reglages && etat.reglages.reessayer;
    if (!jeton || jeton === memoire.jetons_traites.reessayer) return journal;
    if (journal && !journal.illisible && (journal.etat === ETATS.INSTALLEE || journal.etat === ETATS.REVENUE)) {
      journal = { ...journal, refusees: [], tentative: 0, maj_le: horloge().toISOString() };
      await ecrireJournal(chemins.journal, journal);
      log(`réessai demandé par le siège : refus levés (jeton ${jeton})`);
    }
    memoire.jetons_traites.reessayer = jeton;
    await ecrireMemoire(memoire);
    return journal;
  }

  /** Ce qu'il faudrait faire maintenant (sans rien faire). */
  async function examiner({ auDemarrage }) {
    if (!o.trousseau) return { pret: null, decision: null, raison: 'CLE_ABSENTE', motif: o.motifSansCle || null };
    const etat = await lireEtat(chemins.etat);
    const memoire = await lireMemoireLanceur(chemins.lanceur);
    let journal = await lireJournal(chemins.journal);
    journal = await traiterReessayer(etat, journal, memoire);
    const s = situationInstallation({ etat, journal, memoire, installee: lireVersion(chemins.app), maintenant: horloge(), auDemarrage });
    return { ...s, journal, memoire };
  }

  async function installer({ pret, journal, memoire, installerMaintenant }, { auDemarrage }) {
    if (installerMaintenant) {
      // Marqué AVANT : un échec ne doit pas relancer l'installation en boucle
      // sur le même « installer maintenant ».
      memoire.jetons_traites.installer_maintenant = installerMaintenant;
      await ecrireMemoire(memoire);
    }
    await avant({ numero: pret.numero, version: pret.version, reprise: false, auDemarrage });
    const j = nouveauJournal(journal && !journal.illisible ? journal : null, { numero: pret.numero, version: pret.version, maintenant: horloge() });
    await ecrireJournal(chemins.journal, j);
    log(`installation de ${pret.version} (n° ${pret.numero}), tentative ${j.tentative}`);
    const r = await executerInstallation({ chemin: chemins.journal, journal: j, operations: o.operations, horloge });
    log(`installation de ${pret.version} : ${r.resultat}${r.journal.erreur ? ` (${r.journal.erreur.etape} : ${r.journal.erreur.message})` : ''}`);
    if (r.resultat !== ETATS.INSTALLEE) await nettoyer({});
    return { action: 'INSTALLATION', resultat: r.resultat, journal: r.journal };
  }

  async function garde(fn) {
    if (enCours) return { action: 'OCCUPE' };
    enCours = true;
    try {
      return await fn();
    } finally {
      enCours = false;
    }
  }

  /**
   * Au démarrage du poste, AVANT d'ouvrir la caisse.
   * Renvoie `{ action: 'RIEN' | 'REPRISE' | 'RETOUR' | 'INSTALLATION' | 'BLOQUE', resultat?, raison?, journal? }`.
   */
  function auDemarrage() {
    return garde(async () => {
      const journal = await lireJournal(chemins.journal);
      const d = deciderReprise(journal);
      if (d.action === 'BLOQUE') {
        log(`mise à jour bloquée : ${d.raison}`);
        return { action: 'BLOQUE', raison: d.raison, journal };
      }
      if (d.action === 'REPRENDRE') {
        await avant({ numero: journal.numero, version: journal.version, reprise: true, auDemarrage: true });
        log(`reprise de l'installation ${journal.version} depuis ${d.depuis}`);
        const j = journalPourReprise(journal, d, horloge());
        await ecrireJournal(chemins.journal, j);
        const r = await executerInstallation({ chemin: chemins.journal, journal: j, depuis: d.depuis, operations: o.operations, horloge });
        log(`reprise : ${r.resultat}`);
        if (r.resultat !== ETATS.INSTALLEE) await nettoyer({});
        return { action: 'REPRISE', resultat: r.resultat, journal: r.journal };
      }
      if (d.action === 'REVENIR') {
        await avant({ numero: journal.numero, version: journal.version, reprise: true, auDemarrage: true });
        log(`retour arrière de ${journal.version} après coupure (${d.etapes.join(', ') || 'rien à défaire'})`);
        const j = await executerRetour({ chemin: chemins.journal, journal, operations: o.operations, etapes: d.etapes, refuser: d.refuser, horloge });
        await nettoyer({});
        return { action: 'RETOUR', resultat: j.etat, journal: j };
      }
      const s = await examiner({ auDemarrage: true });
      if (s.decision && s.decision.action === 'INSTALLER') return installer(s, { auDemarrage: true });
      return { action: 'RIEN', raison: s.raison || (s.decision && s.decision.raison) || null, decision: s.decision || null };
    });
  }

  /** Toutes les 60 s pendant le service. */
  function verifierCreneau() {
    return garde(async () => {
      const s = await examiner({ auDemarrage: false });
      if (s.decision && s.decision.action === 'INSTALLER') return installer(s, { auDemarrage: false });
      return { action: 'RIEN', raison: s.raison || (s.decision && s.decision.raison) || null, decision: s.decision || null };
    });
  }

  return {
    auDemarrage,
    verifierCreneau,
    examiner,
    get enCours() {
      return enCours;
    },
  };
}

module.exports = { creerLanceurMaj, situationInstallation };
