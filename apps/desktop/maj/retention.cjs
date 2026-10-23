'use strict';
// Rétention des sauvegardes de base prises avant chaque mise à jour.
//
// Décision du propriétaire (23/10/2026) : garder 7 jours, et TOUJOURS au moins
// les 2 dernières. Les deux règles se cumulent : un site qui n'a pas eu de
// mise à jour depuis un mois garde quand même ses 2 dernières sauvegardes,
// seul moyen de revenir en arrière si un défaut n'apparaît que tard.
//
// Fonction pure : le lanceur liste le dossier, appelle `choisirSauvegardesASupprimer`,
// puis supprime. Dans le doute (date illisible, date dans le futur à cause
// d'une horloge fausse), on GARDE : une sauvegarde de trop coûte de la place,
// une de moins peut coûter les ventes du site.

const PREFIXE = 'pgdata';
const RE_NOM = /^pgdata-(\d+)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;
const JOUR = 24 * 60 * 60 * 1000;

/** Nom de dossier d'une sauvegarde : `pgdata-<numero>-AAAAMMJJ-HHMMSS` (heure UTC = Abidjan). */
function nomSauvegarde(numero, date) {
  const p = (n) => String(n).padStart(2, '0');
  const d = date;
  return `${PREFIXE}-${numero}-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** Inverse de `nomSauvegarde` ; null si le nom ne suit pas le format (dossier étranger : on n'y touche pas). */
function lireNomSauvegarde(nom) {
  const m = RE_NOM.exec(nom);
  if (!m) return null;
  const le = new Date(Date.UTC(+m[2], +m[3] - 1, +m[4], +m[5], +m[6], +m[7]));
  if (Number.isNaN(le.getTime())) return null;
  return { nom, numero: Number(m[1]), le };
}

/**
 * @param {{nom: string, le: Date}[]} sauvegardes
 * @param {Date} maintenant
 * @param {{joursConservation?: number, minimum?: number, proteger?: string[]}} [options]
 *        `proteger` : sauvegardes à ne jamais supprimer (celle d'une installation en cours).
 * @returns {string[]} noms à supprimer
 */
function choisirSauvegardesASupprimer(sauvegardes, maintenant, { joursConservation = 7, minimum = 2, proteger = [] } = {}) {
  const protegees = new Set(proteger);
  const datees = sauvegardes.filter((s) => s.le instanceof Date && !Number.isNaN(s.le.getTime()));
  // Les plus récentes d'abord ; à date égale, ordre stable par nom.
  const triees = [...datees].sort((a, b) => b.le - a.le || (a.nom < b.nom ? 1 : -1));
  const limite = maintenant.getTime() - joursConservation * JOUR;
  return triees
    .slice(minimum)
    .filter((s) => s.le.getTime() < limite && !protegees.has(s.nom))
    .map((s) => s.nom);
}

module.exports = { nomSauvegarde, lireNomSauvegarde, choisirSauvegardesASupprimer };
