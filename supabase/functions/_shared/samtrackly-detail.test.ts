// ──────────────────────────────────────────────────────────────────────────────
// Tests de samtrackly-detail.ts — dépenses détaillées et présences.
//
// Le shift porte les totaux ; ces deux tables portent le détail que le gérant
// ouvre quand un chiffre le surprend. La paie est de l'argent versé à quelqu'un
// de nommé : une erreur d'attribution est pire qu'une erreur de total.
//
//   node --test supabase/functions/_shared/samtrackly-detail.test.ts
// ──────────────────────────────────────────────────────────────────────────────
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { construireDepenses, construirePresences } from './samtrackly-detail.ts';

const DEPENSES = [
  { id: 'd1', categorie: 'MARCHE', libelle: 'Poulet', montant: 7_000, agent_id: null, supprime: false },
  { id: 'd2', categorie: 'LEGUMES', libelle: 'Tomates', montant: 3_000, agent_id: null, supprime: false },
  { id: 'd3', categorie: 'SALAIRES', libelle: 'Journée', montant: 5_000, agent_id: 'pos-flora', supprime: false },
  { id: 'd4', categorie: 'ENCOURAGEMENTS', libelle: 'Rush', montant: 1_000, agent_id: 'pos-flora', supprime: false },
  { id: 'd5', categorie: 'ANNEXES', libelle: 'Gaz', montant: 9_999, agent_id: null, supprime: true },
];

// L'équipe pointée à l'ouverture du service.
const EQUIPE = [
  { utilisateur_id: 'pos-flora', poste_jour: 'Caisse', pointe_le: '2026-08-17T16:00:00Z', reste: false },
  { utilisateur_id: 'pos-adama', poste_jour: 'Cuisine', pointe_le: '2026-08-17T16:05:00Z', reste: true },
  { utilisateur_id: 'pos-inconnu', poste_jour: 'Plonge', pointe_le: '2026-08-17T16:10:00Z', reste: false },
];

// POS `utilisateurs.externe_id` → fiche RH SamerTrackly. « pos-inconnu » est un
// employé créé sur place : il n'existe pas encore côté RH.
const RH = new Map([
  ['pos-flora', { travailleurId: 'trav-flora', nom: 'Flora' }],
  ['pos-adama', { travailleurId: 'trav-adama', nom: 'Adama' }],
]);

const CTX = {
  pointId: 'point-st',
  restaurantId: 'resto-st',
  caissierId: 'user-st',
  caissierNom: 'Flora',
  date: '2026-08-17',
  heureDebut: '16:00',
  heureFin: '01:30',
};

describe('construireDepenses — le détail des achats', () => {

  test('seuls les achats descendent, jamais les salaires', () => {
    const lignes = construireDepenses(DEPENSES, CTX);
    assert.deepEqual(lignes.map(l => l.libelle).sort(), ['Poulet', 'Tomates']);
  });

  test('les catégories sont traduites dans les libellés de Samtrackly', () => {
    const lignes = construireDepenses(DEPENSES, CTX);
    assert.deepEqual(
      lignes.map(l => l.categorie).sort(),
      ['Légumes', 'Marché'],
    );
  });

  test('une ligne effacée sur le site ne descend pas', () => {
    assert.equal(construireDepenses(DEPENSES, CTX).some(l => l.libelle === 'Gaz'), false);
  });

  test('la ligne garde l’id du POS, ce qui rend l’écriture idempotente', () => {
    const lignes = construireDepenses(DEPENSES, CTX);
    assert.deepEqual(lignes.map(l => l.id).sort(), ['d1', 'd2']);
  });

  test('la ligne est attribuée au caissier et au point', () => {
    const [l] = construireDepenses(DEPENSES, CTX);
    assert.equal(l.point_id, 'point-st');
    assert.equal(l.saisi_par, 'caissier');
    assert.equal(l.caissier_nom, 'Flora');
  });

  test('une liste vide ne casse rien', () => {
    assert.deepEqual(construireDepenses([], CTX), []);
    assert.deepEqual(construireDepenses(null, CTX), []);
  });
});

describe('construirePresences — qui était là, et combien il a touché', () => {

  test('une ligne par personne pointée, connue de la RH', () => {
    const lignes = construirePresences(EQUIPE, DEPENSES, RH, CTX);
    assert.deepEqual(lignes.map(l => l.travailleur_nom).sort(), ['Adama', 'Flora']);
  });

  test('un employé créé sur place, inconnu de la RH, est ignoré', () => {
    // Sa fiche n'existe pas dans `travailleurs` : insérer sa présence ferait
    // échouer la clé étrangère et bloquerait TOUT le transfert du shift.
    const lignes = construirePresences(EQUIPE, DEPENSES, RH, CTX);
    assert.equal(lignes.some(l => l.travailleur_id === 'pos-inconnu'), false);
  });

  test('la paie cumule le salaire et l’encouragement de la personne', () => {
    const flora = construirePresences(EQUIPE, DEPENSES, RH, CTX)
      .find(l => l.travailleur_nom === 'Flora');
    assert.equal(flora.paye, 6_000); // 5 000 + 1 000
  });

  test('une personne présente sans paie est à zéro, pas absente de la liste', () => {
    const adama = construirePresences(EQUIPE, DEPENSES, RH, CTX)
      .find(l => l.travailleur_nom === 'Adama');
    assert.equal(adama.paye, 0);
  });

  test('une paie effacée sur le site n’est pas versée', () => {
    const avecEffacee = [
      ...DEPENSES,
      { id: 'd6', categorie: 'SALAIRES', libelle: 'Erreur', montant: 50_000, agent_id: 'pos-adama', supprime: true },
    ];
    const adama = construirePresences(EQUIPE, avecEffacee, RH, CTX)
      .find(l => l.travailleur_nom === 'Adama');
    assert.equal(adama.paye, 0);
  });

  test('la ligne porte la clé d’unicité de Samtrackly', () => {
    // UNIQUE (point_id, caissier_id, travailleur_id) : c'est ce trio qui rend
    // le transfert rejouable sans créer de doublon.
    const [l] = construirePresences(EQUIPE, DEPENSES, RH, CTX);
    assert.equal(l.point_id, 'point-st');
    assert.equal(l.caissier_id, 'user-st');
    assert.ok(l.travailleur_id);
  });

  test('la présence porte les heures et la journée du shift', () => {
    const [l] = construirePresences(EQUIPE, DEPENSES, RH, CTX);
    assert.equal(l.date, '2026-08-17');
    assert.equal(l.heure_debut, '16:00');
    assert.equal(l.heure_fin, '01:30');
    assert.equal(l.statut, 'Présent');
  });

  test('une équipe vide ne casse rien', () => {
    assert.deepEqual(construirePresences([], DEPENSES, RH, CTX), []);
    assert.deepEqual(construirePresences(null, DEPENSES, RH, CTX), []);
  });
});
