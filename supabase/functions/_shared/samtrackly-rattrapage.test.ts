// ──────────────────────────────────────────────────────────────────────────────
// Tests de samtrackly-rattrapage.ts — rattrapage automatique des présences
// écartées faute de fiche RH.
//
// Cas visé : un employé créé directement sur la caisse (`externe_id` vide côté
// POS) n'a pas de fiche RH. Sa présence est écrite nulle part, et le service
// est marqué transféré quand même — sinon on perdrait toute la recette pour
// une présence manquante. `presences_ignorees` garde la trace de qui a été
// écarté. Dès que le siège crée sa fiche, ce module décide quels services
// rouvrir — sans intervention humaine, avec une trace au journal.
// ──────────────────────────────────────────────────────────────────────────────
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  servicesARattraper,
  construireJournalRattrapage,
  doitAlerterEchec,
  construireAlerteEchec,
  type TransfertPresencesIgnorees,
} from './samtrackly-rattrapage.ts';

describe('servicesARattraper — qui rejouer maintenant que des fiches RH sont apparues', () => {

  test('un service dont la personne ignorée est maintenant résolue est repris', () => {
    const transferts: TransfertPresencesIgnorees[] = [
      { service_id: 's1', restaurant_id: 'r1', point_id: 'p1', journee: '2026-08-17', presences_ignorees: ['pos-michael'] },
    ];
    const resolues = new Set(['pos-michael']);
    assert.deepEqual(servicesARattraper(transferts, resolues).map(t => t.service_id), ['s1']);
  });

  test('un service dont personne n’est encore résolu n’est pas repris', () => {
    const transferts: TransfertPresencesIgnorees[] = [
      { service_id: 's1', restaurant_id: 'r1', point_id: 'p1', journee: '2026-08-17', presences_ignorees: ['pos-inconnu'] },
    ];
    assert.deepEqual(servicesARattraper(transferts, new Set()), []);
  });

  test('presences_ignorees vide ou nul n’est jamais repris', () => {
    const transferts: TransfertPresencesIgnorees[] = [
      { service_id: 's1', restaurant_id: 'r1', point_id: 'p1', journee: '2026-08-17', presences_ignorees: [] },
      { service_id: 's2', restaurant_id: 'r1', point_id: 'p1', journee: '2026-08-17', presences_ignorees: null },
    ];
    assert.deepEqual(servicesARattraper(transferts, new Set(['x'])), []);
  });

  test('un service avec plusieurs personnes ignorées est repris dès qu’une seule est résolue', () => {
    const transferts: TransfertPresencesIgnorees[] = [
      { service_id: 's1', restaurant_id: 'r1', point_id: 'p1', journee: '2026-08-17', presences_ignorees: ['pos-a', 'pos-b'] },
    ];
    assert.equal(servicesARattraper(transferts, new Set(['pos-b'])).length, 1);
  });

  test('une liste de transferts vide ne casse rien', () => {
    assert.deepEqual(servicesARattraper([], new Set()), []);
    assert.deepEqual(servicesARattraper(null, new Set()), []);
  });

  test('plusieurs services : seuls les éligibles sont retenus, dans l’ordre', () => {
    const transferts: TransfertPresencesIgnorees[] = [
      { service_id: 's1', restaurant_id: 'r1', point_id: 'p1', journee: '2026-08-17', presences_ignorees: ['pos-a'] },
      { service_id: 's2', restaurant_id: 'r1', point_id: 'p2', journee: '2026-08-18', presences_ignorees: ['pos-b'] },
      { service_id: 's3', restaurant_id: 'r1', point_id: 'p3', journee: '2026-08-18', presences_ignorees: ['pos-c'] },
    ];
    assert.deepEqual(
      servicesARattraper(transferts, new Set(['pos-a', 'pos-c'])).map(t => t.service_id),
      ['s1', 's3'],
    );
  });
});

describe('construireJournalRattrapage — la trace laissée au journal Samtrackly', () => {

  test('porte le service, la journée et le nombre de présences récupérées', () => {
    const t: TransfertPresencesIgnorees = {
      service_id: 's1', restaurant_id: 'r1', point_id: 'p1', journee: '2026-08-17',
      presences_ignorees: ['pos-a'],
    };
    const j = construireJournalRattrapage(t, 2);
    assert.equal(j.action, 'rattrapage_presences_pos');
    assert.equal(j.restaurant_id, 'r1');
    assert.equal(j.point_id, 'p1');
    assert.equal(j.details.presences_recuperees, 2);
    assert.equal(j.details.journee, '2026-08-17');
  });

  test('la trace se distingue d’une action humaine — signée « Pont POS »', () => {
    // Un vérificateur qui voit ce nom au journal sait que rien n'a bougé au
    // clavier de quelqu'un : c'est le pont qui a rejoué le service seul.
    const t: TransfertPresencesIgnorees = {
      service_id: 's1', restaurant_id: 'r1', point_id: 'p1', journee: '2026-08-17',
      presences_ignorees: ['pos-a'],
    };
    assert.equal(construireJournalRattrapage(t, 1).user_nom, 'Pont POS');
  });

  test('zéro présence récupérée reste traçable, jamais négatif', () => {
    const t: TransfertPresencesIgnorees = {
      service_id: 's1', restaurant_id: 'r1', point_id: 'p1', journee: '2026-08-17',
      presences_ignorees: ['pos-a'],
    };
    assert.equal(construireJournalRattrapage(t, 0).details.presences_recuperees, 0);
  });
});

describe('doitAlerterEchec — alerter une fois, pas quatre cents', () => {
  test('avant le seuil, on se tait : une coupure réseau se répare seule', () => {
    assert.equal(doitAlerterEchec(1), false);
    assert.equal(doitAlerterEchec(2), false);
  });

  test('au seuil exact (15 min de panne), on alerte', () => {
    assert.equal(doitAlerterEchec(3), true);
  });

  test('au-delà du seuil, plus rien : sinon 400 tentatives = 400 lignes de journal', () => {
    assert.equal(doitAlerterEchec(4), false);
    assert.equal(doitAlerterEchec(400), false);
  });

  test('seuil réglable', () => {
    assert.equal(doitAlerterEchec(5, 5), true);
    assert.equal(doitAlerterEchec(3, 5), false);
  });
});

describe('construireAlerteEchec — la trace au journal', () => {
  test('porte le restaurant SamerTrackly, pas celui du POS', () => {
    const l = construireAlerteEchec('svc-1', 'resto-st-1', 3, 'PGRST102 All object keys must match');
    assert.equal(l.restaurant_id, 'resto-st-1');
    assert.equal(l.action, 'echec_transfert_pos');
    assert.equal(l.user_nom, 'Pont POS');
    assert.equal(l.details.service_id, 'svc-1');
    assert.equal(l.details.tentatives, 3);
  });

  test('un message d’erreur à rallonge est tronqué, jamais rejeté', () => {
    const l = construireAlerteEchec('svc-1', 'resto-st-1', 3, 'x'.repeat(900));
    assert.equal(l.details.erreur.length, 300);
  });
});

describe('journal_activite — les deux formes voyagent dans le même lot', () => {
  test('rattrapage et alerte ont EXACTEMENT les mêmes clés de premier niveau', () => {
    const rattrapage = construireJournalRattrapage(
      { service_id: 's1', restaurant_id: 'r1', point_id: 'p1', journee: '2026-08-24', presences_ignorees: [] },
      2,
    );
    const alerte = construireAlerteEchec('s2', 'r1', 3, 'boum');
    assert.equal(
      Object.keys(rattrapage).sort().join(','),
      Object.keys(alerte).sort().join(','),
      'PostgREST rejette tout le lot (PGRST102) si les objets diffèrent — `details` est du jsonb, son contenu peut varier, pas les clés du dessus',
    );
  });
});
