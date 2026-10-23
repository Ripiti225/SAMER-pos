'use strict';
// Erreur unique de la mise à jour à distance. Le `code` est stable (il part
// dans les comptes rendus au siège et dans le journal d'installation) ; le
// message est en français courant, lisible tel quel sur l'écran du lanceur.

class ErreurMaj extends Error {
  /**
   * @param {string} code    identifiant stable, ex. 'SIGNATURE_INVALIDE'
   * @param {string} message explication en français
   * @param {object} [details] contexte technique (chemin, attendu, obtenu…)
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'ErreurMaj';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

module.exports = { ErreurMaj };
