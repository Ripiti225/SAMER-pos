'use strict';
// Machine à états de l'installation et de la reprise après coupure (plan § 2.4
// et § 3 « Coupure de courant pendant l'installation »).
//
// Le principe : chaque étape est inscrite dans `maj/installation.json` AVANT
// d'être lancée (COMMENCEE) et APRÈS avoir réussi (FINIE), par écriture
// atomique. Si le courant saute, le lanceur relit ce journal au démarrage et
// sait exactement ce qui a pu être touché : rien, le code, ou le code ET la
// base. `deciderReprise` en déduit quoi faire — reprendre, revenir en arrière
// ou ne rien faire — sans jamais deviner à partir de l'état des dossiers.
//
// Les opérations disque réelles (arrêt des processus, copie de pgdata,
// échange `app` ↔ `app.precedente`…) arrivent avec le lot L4 : ici, elles sont
// INJECTÉES dans `executerInstallation`, ce qui rend toute la logique testable
// avec des fonctions factices et des coupures simulées.
const fsp = require('node:fs/promises');
const { ErreurMaj } = require('./erreurs.cjs');
const { ecrireJsonAtomique } = require('./disque.cjs');

const FORMAT_JOURNAL = 1;
const FICHIER_JOURNAL = 'installation.json';

/** Étapes de l'installation, dans l'ordre (plan § 3, points 1 à 7). */
const ETAPES = Object.freeze([
  'VERIFICATION', // 1. revérification du paquet (signature, empreintes) et de l'espace disque
  'ARRET', // 2. 503 « Mise à jour en cours », arrêt Vite, serveur, puis PostgreSQL (pg_ctl -w)
  'SAUVEGARDE_BASE', // 3. copie à froid de data/pgdata
  'ECHANGE_CODE', // 4. app → app.precedente, version prête → app, .env et node_modules repris
  'MIGRATIONS', // 5. PostgreSQL + migrations : la base est désormais touchée
  'VALIDATION', // 6. démarrage en mode validation + contrôle de santé
  'FINALISATION', // 7. VERSION.json, caisse rouverte, compte rendu « INSTALLÉ »
]);

/** Étapes du retour arrière, dans l'ordre. */
const ETAPES_RETOUR = Object.freeze([
  'RETOUR_ARRET', // arrêter ce que l'installation a démarré (serveur en validation, PostgreSQL)
  'RETOUR_CODE', // app.precedente → app
  'RETOUR_BASE', // sauvegarde → data/pgdata
]);

const ETATS = Object.freeze({
  EN_COURS: 'EN_COURS',
  RETOUR_EN_COURS: 'RETOUR_EN_COURS',
  INSTALLEE: 'INSTALLEE',
  REVENUE: 'REVENUE',
  RETOUR_ECHOUE: 'RETOUR_ECHOUE',
});

const TENTATIVES_MAX = 2;
const RETOURS_MAX = 3;
const HISTORIQUE_MAX = 200;

function iso(d) {
  return (d instanceof Date ? d : new Date(d)).toISOString();
}

// --------------------------------------------------------------------------
// Transitions pures du journal
// --------------------------------------------------------------------------

function estRefusee(journal, numero) {
  return Boolean(journal && Array.isArray(journal.refusees) && journal.refusees.includes(numero));
}

/** Nombre de tentatives déjà commencées pour `numero` d'après le journal. */
function tentativesPour(journal, numero) {
  return journal && journal.numero === numero ? journal.tentative || 0 : 0;
}

/**
 * Peut-on lancer (ou relancer) l'installation de `numero` ? Garde des
 * 2 tentatives par version : une version qui a coupé deux fois ne retente
 * plus toute seule, le siège la voit en échec.
 */
function peutTenter(journal, numero, { tentativesMax = TENTATIVES_MAX } = {}) {
  if (estRefusee(journal, numero)) return false;
  if (journal && journal.numero === numero && journal.etat === ETATS.INSTALLEE) return false;
  return tentativesPour(journal, numero) < tentativesMax;
}

/** Journal d'une nouvelle tentative (la liste des versions refusées est conservée). */
function nouveauJournal(precedent, { numero, version, maintenant }, { tentativesMax = TENTATIVES_MAX } = {}) {
  if (estRefusee(precedent, numero)) {
    throw new ErreurMaj('VERSION_REFUSEE', `La version ${version} a déjà été refusée sur ce poste.`);
  }
  if (!peutTenter(precedent, numero, { tentativesMax })) {
    throw new ErreurMaj('TENTATIVES_EPUISEES', `La version ${version} a déjà été tentée ${tentativesMax} fois.`);
  }
  return {
    format: FORMAT_JOURNAL,
    numero,
    version,
    etat: ETATS.EN_COURS,
    tentative: tentativesPour(precedent, numero) + 1,
    etape: null,
    statut: null,
    code_touche: false,
    base_touchee: false,
    retour: null,
    erreur: null,
    refusees: precedent && Array.isArray(precedent.refusees) ? [...precedent.refusees] : [],
    commence_le: iso(maintenant),
    maj_le: iso(maintenant),
    historique: [],
  };
}

function ajouterHistorique(journal, entree) {
  const historique = [...journal.historique, entree];
  return historique.length > HISTORIQUE_MAX ? historique.slice(-HISTORIQUE_MAX) : historique;
}

/** Inscrit le début ou la fin d'une étape (installation ou retour). */
function marquerEtape(journal, etape, statut, maintenant) {
  if (!ETAPES.includes(etape) && !ETAPES_RETOUR.includes(etape)) {
    throw new ErreurMaj('ETAPE_INCONNUE', `Étape inconnue : ${etape}.`);
  }
  const suivant = {
    ...journal,
    etape,
    statut,
    maj_le: iso(maintenant),
    historique: ajouterHistorique(journal, { etape, statut, le: iso(maintenant) }),
  };
  // On note « touché » dès le DÉBUT de l'étape : une coupure au milieu de
  // l'échange de dossiers laisse le code dans un état intermédiaire, donc à
  // restaurer.
  if (statut === 'COMMENCEE' && etape === 'ECHANGE_CODE') suivant.code_touche = true;
  if (statut === 'COMMENCEE' && etape === 'MIGRATIONS') suivant.base_touchee = true;
  return suivant;
}

/** Étapes de retour nécessaires selon ce qui a été touché. */
function etapesRetourPour(journal) {
  if (!journal.code_touche && !journal.base_touchee) return [];
  const etapes = ['RETOUR_ARRET'];
  if (journal.code_touche) etapes.push('RETOUR_CODE');
  if (journal.base_touchee) etapes.push('RETOUR_BASE');
  return etapes;
}

// --------------------------------------------------------------------------
// Décision au démarrage
// --------------------------------------------------------------------------

/**
 * Que faire au démarrage du lanceur, d'après le dernier état journalisé ?
 *
 * Renvoie l'un de :
 * - `{ action: 'RIEN' }` : pas d'installation interrompue ;
 * - `{ action: 'REPRENDRE', depuis, nouvelleTentative }` : relancer à partir
 *   de l'étape `depuis` (si `nouvelleTentative`, le compteur augmente) ;
 * - `{ action: 'REVENIR', etapes, refuser }` : retour arrière (les étapes de
 *   retour à exécuter, liste VIDE si rien n'avait été touché), version marquée
 *   refusée si `refuser`. À passer tel quel à `executerRetour`, puis
 *   démarrage normal ;
 * - `{ action: 'BLOQUE', raison }` : journal illisible ou retour arrière qui
 *   échoue en boucle — écran d'erreur, appeler le support.
 */
function deciderReprise(journal, { tentativesMax = TENTATIVES_MAX, retoursMax = RETOURS_MAX } = {}) {
  if (!journal) return { action: 'RIEN' };
  if (journal.illisible) return { action: 'BLOQUE', raison: 'JOURNAL_ILLISIBLE' };
  const { etat } = journal;
  if (etat === ETATS.INSTALLEE || etat === ETATS.REVENUE) return { action: 'RIEN' };

  if (etat === ETATS.RETOUR_EN_COURS || etat === ETATS.RETOUR_ECHOUE) {
    const retour = journal.retour || { etapes: etapesRetourPour(journal), tentatives: 0, refuser: true };
    if ((retour.tentatives || 0) >= retoursMax) return { action: 'BLOQUE', raison: 'RETOUR_IMPOSSIBLE' };
    // Le retour arrière est rejoué en entier : chaque opération de retour est
    // idempotente (renommer un dossier déjà en place ne fait rien).
    return { action: 'REVENIR', etapes: retour.etapes, refuser: retour.refuser !== false };
  }

  if (etat !== ETATS.EN_COURS) return { action: 'BLOQUE', raison: 'ETAT_INCONNU' };

  const reste = journal.tentative < tentativesMax;
  const indice = ETAPES.indexOf(journal.etape);

  // La validation est passée : la nouvelle version tourne. Couper pendant la
  // finalisation ne justifie pas de revenir en arrière ; on la termine, sans
  // compter de tentative.
  if (journal.etape === 'FINALISATION' || (journal.etape === 'VALIDATION' && journal.statut === 'FINIE')) {
    return { action: 'REPRENDRE', depuis: 'FINALISATION', nouvelleTentative: false };
  }

  // Rien n'a encore changé dans app/ ni dans la base (au pire une sauvegarde
  // partielle, que la nouvelle tentative refait de zéro).
  if (!journal.code_touche) {
    return reste
      ? { action: 'REPRENDRE', depuis: 'VERIFICATION', nouvelleTentative: true }
      : { action: 'REVENIR', etapes: [], refuser: true };
  }

  // Coupure au milieu de l'échange de dossiers : état intermédiaire, on
  // restaure le code. La version n'est refusée que si les tentatives sont
  // épuisées ; sinon le créneau la reprogrammera.
  if (journal.etape === 'ECHANGE_CODE' && journal.statut === 'COMMENCEE') {
    return { action: 'REVENIR', etapes: etapesRetourPour(journal), refuser: !reste };
  }

  // Code en place (et peut-être base en cours de migration) : on reprend en
  // avant — les migrations Drizzle déjà passées ne sont pas rejouées.
  if (reste && indice >= ETAPES.indexOf('ECHANGE_CODE')) {
    const depuis = journal.statut === 'FINIE' ? ETAPES[indice + 1] : journal.etape;
    return { action: 'REPRENDRE', depuis, nouvelleTentative: true };
  }
  return { action: 'REVENIR', etapes: etapesRetourPour(journal), refuser: true };
}

// --------------------------------------------------------------------------
// Lecture / écriture du journal
// --------------------------------------------------------------------------

/**
 * Lit le journal. Absent → null. Illisible → `{ illisible: true, erreur }`
 * (ne devrait jamais arriver grâce à l'écriture atomique, mais un disque
 * abîmé ou une main humaine ne préviennent pas).
 */
async function lireJournal(chemin) {
  let brut;
  try {
    brut = await fsp.readFile(chemin, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    return { illisible: true, erreur: String(e.message || e) };
  }
  try {
    const j = JSON.parse(brut);
    if (!j || j.format !== FORMAT_JOURNAL || !Object.values(ETATS).includes(j.etat) || !Number.isSafeInteger(j.numero)) {
      return { illisible: true, erreur: 'structure inattendue' };
    }
    return j;
  } catch (e) {
    return { illisible: true, erreur: String(e.message || e) };
  }
}

// --------------------------------------------------------------------------
// Exécuteur générique
// --------------------------------------------------------------------------

function exigerOperations(operations, etapes) {
  for (const etape of etapes) {
    if (typeof operations[etape] !== 'function') {
      throw new ErreurMaj('OPERATION_MANQUANTE', `Aucune opération fournie pour l'étape ${etape}.`);
    }
  }
}

/**
 * Exécute un retour arrière, en journalisant chaque étape. Renvoie le journal
 * final (état REVENUE, ou RETOUR_ECHOUE si une opération de retour échoue —
 * le prochain démarrage la rejouera, dans la limite de `RETOURS_MAX`).
 */
async function executerRetour({ chemin, journal, operations, etapes, refuser, horloge = () => new Date(), ecrire = ecrireJsonAtomique }) {
  const liste = etapes || etapesRetourPour(journal);
  exigerOperations(operations, liste);
  const tentatives = ((journal.retour && journal.retour.tentatives) || 0) + 1;
  let j = { ...journal, etat: ETATS.RETOUR_EN_COURS, retour: { etapes: liste, tentatives, refuser: Boolean(refuser) }, maj_le: iso(horloge()) };
  await ecrire(chemin, j);
  try {
    for (const etape of liste) {
      j = marquerEtape(j, etape, 'COMMENCEE', horloge());
      await ecrire(chemin, j);
      await operations[etape]({ journal: j });
      j = marquerEtape(j, etape, 'FINIE', horloge());
      await ecrire(chemin, j);
    }
  } catch (e) {
    j = { ...j, etat: ETATS.RETOUR_ECHOUE, erreur: { code: e.code || 'ERREUR', message: String(e.message || e) }, maj_le: iso(horloge()) };
    await ecrire(chemin, j);
    return j;
  }
  const refusees = refuser && !j.refusees.includes(j.numero) ? [...j.refusees, j.numero] : j.refusees;
  j = { ...j, etat: ETATS.REVENUE, refusees, maj_le: iso(horloge()) };
  await ecrire(chemin, j);
  return j;
}

/**
 * Exécute l'installation à partir de `depuis` avec les opérations injectées
 * (une fonction async par étape de ETAPES et de ETAPES_RETOUR, recevant
 * `{ journal }`). Sur erreur, retour arrière automatique.
 *
 * La version est refusée après un échec si les tentatives sont épuisées, si
 * l'échec vient des migrations ou du contrôle de santé (rejouer donnerait le
 * même résultat), ou si l'opération a levé une erreur marquée `definitif`.
 * Un échec passager (antivirus qui bloque un renommage, disque plein…) laisse
 * au contraire une seconde chance au créneau suivant.
 *
 * Renvoie `{ resultat: 'INSTALLEE' | 'REVENUE' | 'RETOUR_ECHOUE', journal }`.
 */
async function executerInstallation({
  chemin,
  journal,
  depuis = 'VERIFICATION',
  operations,
  horloge = () => new Date(),
  ecrire = ecrireJsonAtomique,
  tentativesMax = TENTATIVES_MAX,
}) {
  exigerOperations(operations, [...ETAPES, ...ETAPES_RETOUR]);
  const debut = ETAPES.indexOf(depuis);
  if (debut === -1) throw new ErreurMaj('ETAPE_INCONNUE', `Étape inconnue : ${depuis}.`);
  let j = { ...journal, etat: ETATS.EN_COURS, erreur: null };
  for (const etape of ETAPES.slice(debut)) {
    try {
      j = marquerEtape(j, etape, 'COMMENCEE', horloge());
      await ecrire(chemin, j);
      await operations[etape]({ journal: j });
      j = marquerEtape(j, etape, 'FINIE', horloge());
      await ecrire(chemin, j);
    } catch (e) {
      j = {
        ...j,
        erreur: { code: e.code || 'ERREUR', message: String(e.message || e), etape },
        historique: ajouterHistorique(j, { etape, statut: 'ECHEC', le: iso(horloge()) }),
      };
      const refuser = j.tentative >= tentativesMax || etape === 'MIGRATIONS' || etape === 'VALIDATION' || e.definitif === true;
      const final = await executerRetour({ chemin, journal: j, operations, refuser, horloge, ecrire });
      return { resultat: final.etat, journal: final };
    }
  }
  j = { ...j, etat: ETATS.INSTALLEE, maj_le: iso(horloge()) };
  await ecrire(chemin, j);
  return { resultat: ETATS.INSTALLEE, journal: j };
}

/** Journal prêt pour une reprise décidée par `deciderReprise` (compte la tentative si besoin). */
function journalPourReprise(journal, decisionReprise, maintenant) {
  const j = { ...journal, maj_le: iso(maintenant) };
  if (decisionReprise.nouvelleTentative) j.tentative = (journal.tentative || 0) + 1;
  return j;
}

module.exports = {
  FICHIER_JOURNAL,
  ETAPES,
  ETAPES_RETOUR,
  ETATS,
  TENTATIVES_MAX,
  RETOURS_MAX,
  estRefusee,
  peutTenter,
  nouveauJournal,
  marquerEtape,
  etapesRetourPour,
  deciderReprise,
  lireJournal,
  ecrireJournal: ecrireJsonAtomique,
  executerInstallation,
  executerRetour,
  journalPourReprise,
};
