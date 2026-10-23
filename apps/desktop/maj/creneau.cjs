'use strict';
// Décision du créneau d'installation — fonction PURE : toutes les entrées
// (heure courante, type de site, réglages, report…) sont injectées, rien
// n'est lu sur l'horloge ni sur le disque. Le lanceur l'appelle au démarrage
// et à chaque `prochaineVerification` ; les tests la parcourent en table.
//
// Règles décidées par le propriétaire (21 et 23/10/2026, prioritaires sur le
// texte du plan) :
// - site « ferme la nuit » : installation au DÉMARRAGE suivant du poste, avant
//   d'ouvrir la caisse. Filet : si le poste n'a pas redémarré 24 h après que
//   le paquet est prêt, installation à 05h00 (première 05h00 qui suit ce délai) ;
// - site « 24h/24 » : installation à l'heure définie (06h00 par défaut,
//   réglable par site), MÊME poste en service, shift ouvert ;
// - un seul « Pas maintenant », de 30 min, par installation ; à la fin, rappel
//   à l'écran puis installation, sans nouveau report possible ;
// - poste éteint à l'heure prévue → installation au rallumage, avant
//   d'ouvrir la caisse ;
// - fenêtre de rattrapage (2 h) : un lanceur occupé ou un PC en veille juste à
//   l'heure prévue installe encore dans la foulée ; au-delà, en plein service,
//   on ne coupe plus la caisse à l'improviste et on attend le créneau suivant.
//
// Heure locale : Abidjan est en UTC+0 toute l'année (pas d'heure d'été), d'où
// `fuseauMinutes` = 0 par défaut ; le paramètre existe pour les tests.
const { ErreurMaj } = require('./erreurs.cjs');

const TYPES_SITE = Object.freeze({ FERME_LA_NUIT: 'FERME_LA_NUIT', H24: 'H24' });

const REGLAGES_DEFAUT = Object.freeze({
  heureInstallation: '06:00', // sites 24h/24
  heureFilet: '05:00', // sites fermés la nuit : filet si pas de redémarrage
  delaiFiletHeures: 24,
  rattrapageMinutes: 120,
  preavisMinutes: 10, // bandeau « Mise à jour à 06h00 » sur la caisse
  reportMinutes: 30,
  rappelMinutes: 2, // rappel à l'écran à la fin du report
  fuseauMinutes: 0,
});

const MINUTE = 60 * 1000;
const JOUR = 24 * 60 * MINUTE;
const RE_HEURE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function versDate(valeur, nom) {
  if (valeur === null || valeur === undefined) return null;
  const d = valeur instanceof Date ? valeur : new Date(valeur);
  if (Number.isNaN(d.getTime())) throw new ErreurMaj('ENTREE_INVALIDE', `Date illisible pour « ${nom} ».`);
  return d;
}

function minutesDuJour(heure, nom) {
  const m = RE_HEURE.exec(String(heure));
  if (!m) throw new ErreurMaj('ENTREE_INVALIDE', `Heure invalide pour « ${nom} » (attendu HH:MM) : ${heure}.`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Première occurrence de `heure` (locale) à partir de `instant` inclus. */
function premiereOccurrence(instant, heure, fuseauMinutes = 0) {
  const decalage = fuseauMinutes * MINUTE;
  const local = instant.getTime() + decalage;
  let occ = Math.floor(local / JOUR) * JOUR + minutesDuJour(heure, 'heure') * MINUTE;
  if (occ < local) occ += JOUR;
  return new Date(occ - decalage);
}

function decision(action, raison, extra = {}) {
  return {
    action,
    raison,
    echeance: null,
    reportPossible: false,
    rappel: false,
    prochaineVerification: null,
    ...extra,
  };
}

/**
 * Que faire maintenant ?
 *
 * @param {object} e
 * @param {Date}    e.maintenant
 * @param {'FERME_LA_NUIT'|'H24'} e.typeSite
 * @param {Date|null} e.pretLe        fin de préparation du paquet (null = rien à installer)
 * @param {boolean} e.auDemarrage     appel fait au démarrage du poste, caisse pas encore ouverte
 * @param {{demandeLe: Date}|null} [e.report] le « Pas maintenant » déjà utilisé pour CETTE installation
 * @param {boolean} [e.pause]         rollout suspendu par le siège
 * @param {boolean} [e.installerMaintenant] « installer maintenant » demandé par le siège
 * @param {string}  [e.heureInstallation] HH:MM, sites 24h/24 (défaut 06:00)
 * @param {string}  [e.heureFilet]    HH:MM, filet des sites fermés la nuit (défaut 05:00)
 * @returns {{action: 'RIEN'|'ATTENDRE'|'AVERTIR'|'INSTALLER', raison: string, echeance: Date|null,
 *            reportPossible: boolean, rappel: boolean, prochaineVerification: Date|null}}
 *
 * - ATTENDRE : rien à afficher ; revenir à `prochaineVerification` ;
 * - AVERTIR  : bandeau « Mise à jour à <echeance> (2-3 min) » ; bouton
 *              « Pas maintenant » seulement si `reportPossible` ; `rappel` =
 *              fin du report, plus de bouton ;
 * - INSTALLER : lancer l'installation tout de suite.
 */
function deciderCreneau(e) {
  const r = { ...REGLAGES_DEFAUT, ...Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) };
  const maintenant = versDate(e.maintenant, 'maintenant');
  if (!maintenant) throw new ErreurMaj('ENTREE_INVALIDE', '« maintenant » est obligatoire.');
  if (!TYPES_SITE[e.typeSite]) throw new ErreurMaj('ENTREE_INVALIDE', `Type de site inconnu : ${e.typeSite}.`);
  const pretLe = versDate(e.pretLe, 'pretLe');
  const report = e.report ? { demandeLe: versDate(e.report.demandeLe, 'report.demandeLe') } : null;
  minutesDuJour(r.heureInstallation, 'heureInstallation');
  minutesDuJour(r.heureFilet, 'heureFilet');

  if (!pretLe) return decision('RIEN', 'AUCUN_PAQUET');
  if (e.pause) return decision('ATTENDRE', 'PAUSE_SIEGE');
  // Au démarrage, la caisse n'est pas encore ouverte : personne à prévenir,
  // donc jamais de report proposé.
  const reportPossible = !report && !e.auDemarrage;
  if (e.installerMaintenant) return decision('INSTALLER', 'DEMANDE_SIEGE', { echeance: maintenant, reportPossible });

  const ferme = e.typeSite === TYPES_SITE.FERME_LA_NUIT;
  const heureBase = ferme ? r.heureFilet : r.heureInstallation;
  const debutCalcul = ferme ? new Date(pretLe.getTime() + r.delaiFiletHeures * 60 * MINUTE) : pretLe;
  const echeanceInitiale = premiereOccurrence(debutCalcul, heureBase, r.fuseauMinutes);
  // Le report se compte depuis l'échéance (un clic à H-10 décale bien
  // 06h00 → 06h30, pas 05h50 → 06h20).
  const echeance = report
    ? new Date(Math.max(echeanceInitiale.getTime(), report.demandeLe.getTime()) + r.reportMinutes * MINUTE)
    : echeanceInitiale;

  if (e.auDemarrage) {
    if (ferme) return decision('INSTALLER', 'DEMARRAGE', { echeance: maintenant });
    // 24h/24 : on n'installe au démarrage que si l'heure prévue est passée
    // pendant que le poste était éteint (ou en plein report). Un simple
    // redémarrage en journée ne doit pas rallonger la coupure.
    if (echeance <= maintenant) return decision('INSTALLER', 'ECHEANCE_MANQUEE', { echeance });
  }

  let cible = echeance;
  if (cible <= maintenant) {
    if (maintenant - cible <= r.rattrapageMinutes * MINUTE) {
      return decision('INSTALLER', report ? 'FIN_DU_REPORT' : 'ECHEANCE', { echeance: cible });
    }
    // Créneau manqué en plein service : prochain créneau, pas d'installation
    // surprise au milieu du coup de feu.
    cible = premiereOccurrence(maintenant, heureBase, r.fuseauMinutes);
  }

  const avertissement = (report ? r.rappelMinutes : r.preavisMinutes) * MINUTE;
  if (cible - maintenant <= avertissement) {
    return decision('AVERTIR', report ? 'RAPPEL' : 'PREAVIS', {
      echeance: cible,
      reportPossible,
      rappel: Boolean(report),
      prochaineVerification: cible,
    });
  }
  return decision('ATTENDRE', report ? 'REPORTEE' : 'PLANIFIEE', {
    echeance: cible,
    reportPossible,
    prochaineVerification: new Date(cible.getTime() - avertissement),
  });
}

/**
 * Enregistre un « Pas maintenant ». Refuse s'il a déjà servi pour cette
 * installation ou si la décision courante ne le permet pas.
 */
function demanderReport(decisionCourante, maintenant) {
  if (!decisionCourante || !decisionCourante.reportPossible) {
    throw new ErreurMaj('REPORT_IMPOSSIBLE', 'La mise à jour a déjà été reportée une fois : elle ne peut plus l’être.');
  }
  return { demandeLe: versDate(maintenant, 'maintenant') };
}

module.exports = { TYPES_SITE, REGLAGES_DEFAUT, premiereOccurrence, deciderCreneau, demanderReport };
