'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { deciderCreneau, demanderReport, premiereOccurrence } = require('../creneau.cjs');

// Heures d'Abidjan = UTC.
const h = (texte) => new Date(`${texte}:00.000Z`);

function verifier(entree, attendu) {
  const d = deciderCreneau(entree);
  for (const [cle, valeur] of Object.entries(attendu)) {
    const obtenu = d[cle] instanceof Date ? d[cle].toISOString().slice(0, 16) : d[cle];
    assert.deepEqual(obtenu, valeur, `${cle} : ${JSON.stringify(d)}`);
  }
  return d;
}

test('première occurrence d’une heure locale', () => {
  assert.equal(premiereOccurrence(h('2026-10-23T05:00'), '06:00').toISOString(), '2026-10-23T06:00:00.000Z');
  assert.equal(premiereOccurrence(h('2026-10-23T06:00'), '06:00').toISOString(), '2026-10-23T06:00:00.000Z');
  assert.equal(premiereOccurrence(h('2026-10-23T06:01'), '06:00').toISOString(), '2026-10-24T06:00:00.000Z');
  // fuseau paramétrable (tests) : 06h00 à UTC+1 = 05h00 UTC
  assert.equal(premiereOccurrence(h('2026-10-23T04:00'), '06:00', 60).toISOString(), '2026-10-23T05:00:00.000Z');
});

test('aucun paquet prêt : rien', () => {
  verifier({ maintenant: h('2026-10-23T06:00'), typeSite: 'H24', pretLe: null, auDemarrage: true }, { action: 'RIEN' });
  verifier({ maintenant: h('2026-10-23T06:00'), typeSite: 'FERME_LA_NUIT', pretLe: null, auDemarrage: false }, { action: 'RIEN' });
});

// ---------------------------------------------------------------- 24h/24
const H24 = { typeSite: 'H24', pretLe: h('2026-10-23T14:00'), auDemarrage: false };

const tableH24 = [
  // [libellé, maintenant, attendu]
  ['juste après la préparation : planifiée à 06h00 le lendemain', '2026-10-23T14:05',
    { action: 'ATTENDRE', raison: 'PLANIFIEE', echeance: '2026-10-24T06:00', prochaineVerification: '2026-10-24T05:50', reportPossible: true }],
  ['H-11 min : encore rien', '2026-10-24T05:49', { action: 'ATTENDRE' }],
  ['H-10 min : bandeau avec « Pas maintenant »', '2026-10-24T05:50',
    { action: 'AVERTIR', raison: 'PREAVIS', echeance: '2026-10-24T06:00', reportPossible: true, rappel: false }],
  ['06h00 pile : installation même en service', '2026-10-24T06:00', { action: 'INSTALLER', raison: 'ECHEANCE' }],
  ['06h45 (lanceur occupé, veille) : rattrapage', '2026-10-24T06:45', { action: 'INSTALLER', raison: 'ECHEANCE' }],
  ['08h00 pile : dernière minute du rattrapage de 2 h', '2026-10-24T08:00', { action: 'INSTALLER' }],
  ['08h01 en service : on n’installe plus, prochain créneau', '2026-10-24T08:01',
    { action: 'ATTENDRE', echeance: '2026-10-25T06:00', prochaineVerification: '2026-10-25T05:50' }],
];
for (const [libelle, maintenant, attendu] of tableH24) {
  test(`24h/24 — ${libelle}`, () => verifier({ ...H24, maintenant: h(maintenant) }, attendu));
}

test('24h/24 — heure réglable par site (05h00)', () => {
  verifier({ ...H24, heureInstallation: '05:00', maintenant: h('2026-10-24T04:55') }, { action: 'AVERTIR', echeance: '2026-10-24T05:00' });
  verifier({ ...H24, heureInstallation: '05:00', maintenant: h('2026-10-24T05:00') }, { action: 'INSTALLER' });
});

test('24h/24 — paquet prêt à 05h55 : installé à 06h00 le jour même', () => {
  verifier({ ...H24, pretLe: h('2026-10-24T05:55'), maintenant: h('2026-10-24T05:56') }, { action: 'AVERTIR', echeance: '2026-10-24T06:00' });
});

test('24h/24 — redémarrage en journée avant l’heure prévue : on attend 06h00', () => {
  verifier({ ...H24, auDemarrage: true, maintenant: h('2026-10-23T16:00') }, { action: 'ATTENDRE', echeance: '2026-10-24T06:00', reportPossible: false });
});

test('24h/24 — poste éteint à 06h00, rallumé à 09h00 : installation au rallumage', () => {
  verifier({ ...H24, auDemarrage: true, maintenant: h('2026-10-24T09:00') }, { action: 'INSTALLER', raison: 'ECHEANCE_MANQUEE', reportPossible: false });
  // même trois jours plus tard
  verifier({ ...H24, auDemarrage: true, maintenant: h('2026-10-27T13:00') }, { action: 'INSTALLER', raison: 'ECHEANCE_MANQUEE' });
});

// ---------------------------------------------------------------- report unique
test('report « Pas maintenant » : un seul, de 30 min, compté depuis l’échéance', () => {
  const bandeau = verifier({ ...H24, maintenant: h('2026-10-24T05:52') }, { action: 'AVERTIR', reportPossible: true });
  const report = demanderReport(bandeau, h('2026-10-24T05:52'));
  const avecReport = { ...H24, report };
  verifier({ ...avecReport, maintenant: h('2026-10-24T05:53') },
    { action: 'ATTENDRE', raison: 'REPORTEE', echeance: '2026-10-24T06:30', reportPossible: false, prochaineVerification: '2026-10-24T06:28' });
  verifier({ ...avecReport, maintenant: h('2026-10-24T06:00') }, { action: 'ATTENDRE', echeance: '2026-10-24T06:30' });
  // fin du report : rappel à l'écran, sans bouton
  const rappel = verifier({ ...avecReport, maintenant: h('2026-10-24T06:28') },
    { action: 'AVERTIR', raison: 'RAPPEL', rappel: true, reportPossible: false, echeance: '2026-10-24T06:30' });
  assert.throws(() => demanderReport(rappel, h('2026-10-24T06:28')), { code: 'REPORT_IMPOSSIBLE' });
  verifier({ ...avecReport, maintenant: h('2026-10-24T06:30') }, { action: 'INSTALLER', raison: 'FIN_DU_REPORT', reportPossible: false });
});

test('report demandé à l’échéance même : 30 min à partir de ce moment', () => {
  verifier({ ...H24, report: { demandeLe: h('2026-10-24T06:01') }, maintenant: h('2026-10-24T06:02') },
    { action: 'ATTENDRE', echeance: '2026-10-24T06:31' });
});

test('report : jamais proposé au démarrage', () => {
  const d = verifier({ ...H24, auDemarrage: true, maintenant: h('2026-10-24T05:55') }, { action: 'AVERTIR', reportPossible: false });
  assert.throws(() => demanderReport(d, h('2026-10-24T05:55')), { code: 'REPORT_IMPOSSIBLE' });
});

test('report puis créneau manqué en service : jour suivant, toujours sans report', () => {
  verifier({ ...H24, report: { demandeLe: h('2026-10-24T05:52') }, maintenant: h('2026-10-24T09:00') },
    { action: 'ATTENDRE', echeance: '2026-10-25T06:00', reportPossible: false });
});

// ---------------------------------------------------------------- ferme la nuit
const NUIT = { typeSite: 'FERME_LA_NUIT', pretLe: h('2026-10-23T14:00'), auDemarrage: false };

const tableNuit = [
  ['prête en plein service : on attend le démarrage suivant (filet planifié)', '2026-10-23T14:05', false,
    { action: 'ATTENDRE', raison: 'PLANIFIEE', echeance: '2026-10-25T05:00' }],
  ['le soir même, poste toujours allumé : pas d’installation', '2026-10-23T22:30', false, { action: 'ATTENDRE' }],
  ['démarrage du lendemain matin : installation avant la caisse', '2026-10-24T08:00', true,
    { action: 'INSTALLER', raison: 'DEMARRAGE', reportPossible: false }],
  ['démarrage une heure après la préparation : installation aussi', '2026-10-23T15:00', true, { action: 'INSTALLER', raison: 'DEMARRAGE' }],
  ['05h00 du lendemain (< 24 h) : pas encore le filet', '2026-10-24T05:00', false, { action: 'ATTENDRE', echeance: '2026-10-25T05:00' }],
  ['filet : H-10 avant 05h00 (> 24 h)', '2026-10-25T04:50', false, { action: 'AVERTIR', echeance: '2026-10-25T05:00', reportPossible: true }],
  ['filet : 05h00, poste jamais redémarré', '2026-10-25T05:00', false, { action: 'INSTALLER', raison: 'ECHEANCE' }],
  ['filet manqué, poste éteint à 05h00, rallumé à 10h : installation', '2026-10-25T10:00', true, { action: 'INSTALLER', raison: 'DEMARRAGE' }],
  ['filet manqué en service (veille) : 05h00 suivant', '2026-10-25T08:00', false, { action: 'ATTENDRE', echeance: '2026-10-26T05:00' }],
];
for (const [libelle, maintenant, auDemarrage, attendu] of tableNuit) {
  test(`ferme la nuit — ${libelle}`, () => verifier({ ...NUIT, auDemarrage, maintenant: h(maintenant) }, attendu));
}

test('ferme la nuit — paquet prêt à 04h00 : filet à 05h00 le lendemain', () => {
  verifier({ ...NUIT, pretLe: h('2026-10-23T04:00'), maintenant: h('2026-10-23T04:05') }, { action: 'ATTENDRE', echeance: '2026-10-24T05:00' });
});

test('ferme la nuit — report du filet : 05h30', () => {
  verifier({ ...NUIT, report: { demandeLe: h('2026-10-25T04:55') }, maintenant: h('2026-10-25T05:10') },
    { action: 'ATTENDRE', echeance: '2026-10-25T05:30' });
  verifier({ ...NUIT, report: { demandeLe: h('2026-10-25T04:55') }, maintenant: h('2026-10-25T05:30') }, { action: 'INSTALLER' });
});

// ---------------------------------------------------------------- siège
test('pause du siège : rien ne s’installe, même au démarrage', () => {
  verifier({ ...NUIT, pause: true, auDemarrage: true, maintenant: h('2026-10-24T08:00') }, { action: 'ATTENDRE', raison: 'PAUSE_SIEGE' });
});

test('« installer maintenant » du siège', () => {
  verifier({ ...H24, installerMaintenant: true, maintenant: h('2026-10-23T15:00') }, { action: 'INSTALLER', raison: 'DEMANDE_SIEGE' });
});

test('entrées invalides : erreur explicite', () => {
  assert.throws(() => deciderCreneau({ ...H24, typeSite: 'NUIT', maintenant: h('2026-10-23T15:00') }), { code: 'ENTREE_INVALIDE' });
  assert.throws(() => deciderCreneau({ ...H24, heureInstallation: '6h', maintenant: h('2026-10-23T15:00') }), { code: 'ENTREE_INVALIDE' });
  assert.throws(() => deciderCreneau({ ...H24, maintenant: 'pas une date' }), { code: 'ENTREE_INVALIDE' });
});
