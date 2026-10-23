'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ETAPES,
  nouveauJournal,
  marquerEtape,
  deciderReprise,
  peutTenter,
  lireJournal,
  ecrireJournal,
  executerInstallation,
  executerRetour,
  journalPourReprise,
} = require('../installation.cjs');
const { dossierTemp } = require('./aide.cjs');

const T = new Date('2026-10-24T06:00:00Z');
const V = { numero: 42, version: '2026.10.23-1', maintenant: T };

/** Journal arrêté juste après `etape`/`statut` (coupure simulée), à la tentative n. */
function journalCoupe(etape, statut, tentative = 1) {
  let j = { ...nouveauJournal(null, V), tentative };
  for (const e of ETAPES) {
    j = marquerEtape(j, e, 'COMMENCEE', T);
    if (e === etape && statut === 'COMMENCEE') return j;
    j = marquerEtape(j, e, 'FINIE', T);
    if (e === etape) return j;
  }
  throw new Error(`étape inconnue ${etape}`);
}

/** Opérations factices qui enregistrent leur ordre d'appel et peuvent échouer. */
function operationsFactices({ echec } = {}) {
  const appels = [];
  const ops = {};
  for (const nom of [...ETAPES, 'RETOUR_ARRET', 'RETOUR_CODE', 'RETOUR_BASE']) {
    ops[nom] = async () => {
      appels.push(nom);
      if (echec && echec.etape === nom) throw Object.assign(new Error(`échec ${nom}`), echec.erreur || {});
    };
  }
  return { ops, appels };
}

// ---------------------------------------------------------------- table de reprise
const R = (depuis) => ({ action: 'REPRENDRE', depuis, nouvelleTentative: true });
const tableReprise = [
  // [étape, statut, tentative, décision attendue]
  ['VERIFICATION', 'COMMENCEE', 1, R('VERIFICATION')],
  ['VERIFICATION', 'FINIE', 1, R('VERIFICATION')],
  ['ARRET', 'COMMENCEE', 1, R('VERIFICATION')],
  ['SAUVEGARDE_BASE', 'COMMENCEE', 1, R('VERIFICATION')],
  ['SAUVEGARDE_BASE', 'FINIE', 1, R('VERIFICATION')],
  ['ECHANGE_CODE', 'COMMENCEE', 1, { action: 'REVENIR', etapes: ['RETOUR_ARRET', 'RETOUR_CODE'], refuser: false }],
  ['ECHANGE_CODE', 'FINIE', 1, R('MIGRATIONS')],
  ['MIGRATIONS', 'COMMENCEE', 1, R('MIGRATIONS')],
  ['MIGRATIONS', 'FINIE', 1, R('VALIDATION')],
  ['VALIDATION', 'COMMENCEE', 1, R('VALIDATION')],
  ['VALIDATION', 'FINIE', 1, { action: 'REPRENDRE', depuis: 'FINALISATION', nouvelleTentative: false }],
  ['FINALISATION', 'COMMENCEE', 1, { action: 'REPRENDRE', depuis: 'FINALISATION', nouvelleTentative: false }],
  // seconde coupure : garde des 2 tentatives
  ['ARRET', 'COMMENCEE', 2, { action: 'REVENIR', etapes: [], refuser: true }],
  ['SAUVEGARDE_BASE', 'FINIE', 2, { action: 'REVENIR', etapes: [], refuser: true }],
  ['ECHANGE_CODE', 'COMMENCEE', 2, { action: 'REVENIR', etapes: ['RETOUR_ARRET', 'RETOUR_CODE'], refuser: true }],
  ['ECHANGE_CODE', 'FINIE', 2, { action: 'REVENIR', etapes: ['RETOUR_ARRET', 'RETOUR_CODE'], refuser: true }],
  ['MIGRATIONS', 'COMMENCEE', 2, { action: 'REVENIR', etapes: ['RETOUR_ARRET', 'RETOUR_CODE', 'RETOUR_BASE'], refuser: true }],
  ['VALIDATION', 'COMMENCEE', 2, { action: 'REVENIR', etapes: ['RETOUR_ARRET', 'RETOUR_CODE', 'RETOUR_BASE'], refuser: true }],
  // validation passée : on termine, même tentatives épuisées
  ['FINALISATION', 'COMMENCEE', 2, { action: 'REPRENDRE', depuis: 'FINALISATION', nouvelleTentative: false }],
];
for (const [etape, statut, tentative, attendu] of tableReprise) {
  test(`reprise — coupure à ${etape} ${statut}, tentative ${tentative}`, () => {
    assert.deepEqual(deciderReprise(journalCoupe(etape, statut, tentative)), attendu);
  });
}

test('reprise — pas de journal, installation terminée ou revenue : rien', () => {
  assert.deepEqual(deciderReprise(null), { action: 'RIEN' });
  assert.deepEqual(deciderReprise({ ...journalCoupe('FINALISATION', 'FINIE'), etat: 'INSTALLEE' }), { action: 'RIEN' });
  assert.deepEqual(deciderReprise({ ...journalCoupe('MIGRATIONS', 'FINIE'), etat: 'REVENUE' }), { action: 'RIEN' });
});

test('reprise — retour arrière interrompu : rejoué, puis bloqué après 3 essais', () => {
  const j = journalCoupe('MIGRATIONS', 'COMMENCEE');
  const retour = { etapes: ['RETOUR_ARRET', 'RETOUR_CODE', 'RETOUR_BASE'], refuser: true };
  assert.deepEqual(deciderReprise({ ...j, etat: 'RETOUR_EN_COURS', retour: { ...retour, tentatives: 1 } }), { action: 'REVENIR', ...retour });
  assert.deepEqual(deciderReprise({ ...j, etat: 'RETOUR_ECHOUE', retour: { ...retour, tentatives: 2 } }), { action: 'REVENIR', ...retour });
  assert.deepEqual(deciderReprise({ ...j, etat: 'RETOUR_ECHOUE', retour: { ...retour, tentatives: 3 } }), {
    action: 'BLOQUE',
    raison: 'RETOUR_IMPOSSIBLE',
  });
});

test('reprise — journal illisible : bloqué (écran d’erreur, support)', () => {
  assert.deepEqual(deciderReprise({ illisible: true, erreur: 'x' }), { action: 'BLOQUE', raison: 'JOURNAL_ILLISIBLE' });
});

// ---------------------------------------------------------------- tentatives et refus
test('garde des tentatives et versions refusées', () => {
  const j1 = nouveauJournal(null, V);
  assert.equal(j1.tentative, 1);
  const j2 = nouveauJournal(j1, V);
  assert.equal(j2.tentative, 2);
  assert.equal(peutTenter(j2, 42), false);
  assert.throws(() => nouveauJournal(j2, V), { code: 'TENTATIVES_EPUISEES' });
  // une autre version repart à 1, la liste des refusées suit
  const refuse = { ...j2, etat: 'REVENUE', refusees: [42] };
  assert.equal(peutTenter(refuse, 42), false);
  assert.throws(() => nouveauJournal(refuse, V), { code: 'VERSION_REFUSEE' });
  const j3 = nouveauJournal(refuse, { ...V, numero: 43 });
  assert.equal(j3.tentative, 1);
  assert.deepEqual(j3.refusees, [42]);
  // une version déjà installée ne se réinstalle pas
  assert.equal(peutTenter({ ...j1, etat: 'INSTALLEE' }, 42), false);
});

// ---------------------------------------------------------------- journal sur disque
test('journal : écriture atomique, relecture, absent, illisible', async (t) => {
  const d = dossierTemp(t);
  const chemin = path.join(d, 'installation.json');
  assert.equal(await lireJournal(chemin), null);
  const j = journalCoupe('MIGRATIONS', 'COMMENCEE');
  await ecrireJournal(chemin, j);
  assert.deepEqual(await lireJournal(chemin), j);
  assert.deepEqual(fs.readdirSync(d), ['installation.json'], 'aucun fichier temporaire laissé');
  fs.writeFileSync(chemin, '{"format":1,"etat":"EN_CO');
  assert.equal((await lireJournal(chemin)).illisible, true);
  fs.writeFileSync(chemin, '{"format":9}');
  assert.equal((await lireJournal(chemin)).illisible, true);
});

// ---------------------------------------------------------------- exécuteur
test('exécuteur — installation complète, journal à jour à chaque étape', async (t) => {
  const chemin = path.join(dossierTemp(t), 'installation.json');
  const { ops, appels } = operationsFactices();
  const ecrits = [];
  const ecrire = async (c, j) => {
    ecrits.push(`${j.etape}:${j.statut}`);
    await ecrireJournal(c, j);
  };
  const { resultat, journal } = await executerInstallation({ chemin, journal: nouveauJournal(null, V), operations: ops, ecrire, horloge: () => T });
  assert.equal(resultat, 'INSTALLEE');
  assert.deepEqual(appels, ETAPES);
  assert.equal(ecrits[0], 'VERIFICATION:COMMENCEE');
  assert.equal(ecrits.length, ETAPES.length * 2 + 1);
  assert.equal((await lireJournal(chemin)).etat, 'INSTALLEE');
  assert.equal(journal.code_touche && journal.base_touchee, true);
});

test('exécuteur — échec du contrôle de santé : retour arrière complet, version refusée', async (t) => {
  const chemin = path.join(dossierTemp(t), 'installation.json');
  const { ops, appels } = operationsFactices({ echec: { etape: 'VALIDATION' } });
  const { resultat, journal } = await executerInstallation({ chemin, journal: nouveauJournal(null, V), operations: ops });
  assert.equal(resultat, 'REVENUE');
  assert.deepEqual(appels.slice(-3), ['RETOUR_ARRET', 'RETOUR_CODE', 'RETOUR_BASE']);
  assert.deepEqual(journal.refusees, [42]);
  assert.equal(journal.erreur.etape, 'VALIDATION');
  assert.deepEqual(await lireJournal(chemin), journal);
});

test('exécuteur — échec passager avant l’échange : rien à restaurer, seconde chance', async (t) => {
  const chemin = path.join(dossierTemp(t), 'installation.json');
  const { ops, appels } = operationsFactices({ echec: { etape: 'SAUVEGARDE_BASE', erreur: { code: 'ENOSPC' } } });
  const { resultat, journal } = await executerInstallation({ chemin, journal: nouveauJournal(null, V), operations: ops });
  assert.equal(resultat, 'REVENUE');
  assert.deepEqual(appels, ['VERIFICATION', 'ARRET', 'SAUVEGARDE_BASE']);
  assert.deepEqual(journal.refusees, []);
  assert.equal(journal.erreur.code, 'ENOSPC');
  assert.equal(peutTenter(journal, 42), true);
  // seconde tentative qui échoue aussi : refusée
  const second = await executerInstallation({ chemin, journal: nouveauJournal(journal, V), operations: ops });
  assert.deepEqual(second.journal.refusees, [42]);
});

test('exécuteur — erreur marquée « definitif » : refus immédiat', async (t) => {
  const chemin = path.join(dossierTemp(t), 'installation.json');
  const { ops } = operationsFactices({ echec: { etape: 'VERIFICATION', erreur: { code: 'SIGNATURE_INVALIDE', definitif: true } } });
  const { journal } = await executerInstallation({ chemin, journal: nouveauJournal(null, V), operations: ops });
  assert.deepEqual(journal.refusees, [42]);
});

test('exécuteur — retour arrière qui échoue : RETOUR_ECHOUE, rejoué au démarrage suivant', async (t) => {
  const chemin = path.join(dossierTemp(t), 'installation.json');
  const { ops } = operationsFactices({ echec: { etape: 'MIGRATIONS' } });
  ops.RETOUR_BASE = async () => {
    throw new Error('copie impossible');
  };
  const { resultat } = await executerInstallation({ chemin, journal: nouveauJournal(null, V), operations: ops });
  assert.equal(resultat, 'RETOUR_ECHOUE');
  const lu = await lireJournal(chemin);
  const decision = deciderReprise(lu);
  assert.deepEqual(decision, { action: 'REVENIR', etapes: ['RETOUR_ARRET', 'RETOUR_CODE', 'RETOUR_BASE'], refuser: true });
  const { ops: opsOk } = operationsFactices();
  const final = await executerRetour({ chemin, journal: lu, operations: opsOk, etapes: decision.etapes, refuser: decision.refuser });
  assert.equal(final.etat, 'REVENUE');
  assert.equal(final.retour.tentatives, 2);
});

test('opération manquante : refus avant de toucher quoi que ce soit', async (t) => {
  const chemin = path.join(dossierTemp(t), 'installation.json');
  const { ops } = operationsFactices();
  delete ops.RETOUR_BASE;
  await assert.rejects(executerInstallation({ chemin, journal: nouveauJournal(null, V), operations: ops }), { code: 'OPERATION_MANQUANTE' });
  assert.equal(await lireJournal(chemin), null);
});

// ---------------------------------------------------------------- coupures simulées de bout en bout
/**
 * Coupure de courant : l'écriture n° `n` du journal « tue » le processus
 * (exception non rattrapable par l'exécuteur, comme une coupure réelle).
 * Le journal sur disque est celui de l'écriture précédente.
 */
class Coupure extends Error {}
function ecrireAvecCoupure(n) {
  let i = 0;
  return async (c, j) => {
    i += 1;
    if (i === n) throw new Coupure();
    await ecrireJournal(c, j);
  };
}

test('coupure à chaque écriture du journal : le démarrage suivant reprend ou revient proprement', async (t) => {
  const total = ETAPES.length * 2 + 1;
  for (let n = 2; n <= total; n++) {
    const chemin = path.join(dossierTemp(t, `coupure${n}`), 'installation.json');
    const { ops } = operationsFactices();
    // l'exécuteur rattrape les erreurs d'étape pour revenir en arrière ; une
    // vraie coupure arrête tout : on simule en levant aussi dans le retour.
    const ecrire = ecrireAvecCoupure(n);
    let coupe = false;
    const ecrireFatal = async (c, j) => {
      if (coupe) throw new Coupure();
      try {
        await ecrire(c, j);
      } catch (e) {
        coupe = true;
        throw e;
      }
    };
    await executerInstallation({ chemin, journal: nouveauJournal(null, V), operations: ops, ecrire: ecrireFatal }).catch((e) => {
      if (!(e instanceof Coupure)) throw e;
    });

    const lu = await lireJournal(chemin);
    assert.ok(lu && !lu.illisible, `écriture ${n} : journal lisible`);
    const d = deciderReprise(lu);
    let fin;
    if (d.action === 'REPRENDRE') {
      fin = await executerInstallation({ chemin, journal: journalPourReprise(lu, d, T), depuis: d.depuis, operations: ops });
      assert.equal(fin.resultat, 'INSTALLEE', `écriture ${n} : reprise depuis ${d.depuis}`);
    } else if (d.action === 'REVENIR') {
      const j = await executerRetour({ chemin, journal: lu, operations: ops, etapes: d.etapes, refuser: d.refuser });
      assert.equal(j.etat, 'REVENUE', `écriture ${n}`);
    } else {
      assert.fail(`écriture ${n} : décision inattendue ${JSON.stringify(d)}`);
    }
  }
});
