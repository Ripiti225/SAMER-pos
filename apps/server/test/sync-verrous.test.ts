import { describe, expect, it } from 'vitest';
import { champsSynchro, mapPosteRole } from '../src/modules/equipe/sync-samtrackly.js';

const depuisSamtrackly = {
  nom: 'KONE DJENEBA',
  poste: 'Serveur/se',
  photo_url: 'https://exemple/nouvelle.jpg',
  telephone: '0102030405',
  actif: true,
  externe_id: 'ext-1',
  role: 'SERVEUR' as const,
  roleId: 'role-serveur',
  posteCuisine: null,
};

describe('champsSynchro — verrouillage des champs modifiés dans le POS', () => {
  it('sans verrou : tous les champs viennent de SamerTrackly', () => {
    const set = champsSynchro([], depuisSamtrackly);
    expect(set.nom_complet).toBe('KONE DJENEBA');
    expect(set.poste).toBe('Serveur/se');
    expect(set.role_id).toBe('role-serveur');
    expect(set.role).toBe('SERVEUR');
  });

  it('rôle verrouillé : le rôle (et poste_cuisine) N’est PAS écrasé', () => {
    const set = champsSynchro(['role'], depuisSamtrackly);
    expect(set).not.toHaveProperty('role_id');
    expect(set).not.toHaveProperty('role');
    expect(set).not.toHaveProperty('poste_cuisine');
    // les autres champs continuent de se synchroniser
    expect(set.poste).toBe('Serveur/se');
    expect(set.telephone).toBe('0102030405');
  });

  it('poste verrouillé : le poste n’est pas écrasé, le rôle si', () => {
    const set = champsSynchro(['poste'], depuisSamtrackly);
    expect(set).not.toHaveProperty('poste');
    expect(set.role_id).toBe('role-serveur');
    expect(set.nom_complet).toBe('KONE DJENEBA');
  });

  it('plusieurs verrous : rôle + nom protégés, le reste synchronisé', () => {
    const set = champsSynchro(['role', 'nom_complet'], depuisSamtrackly);
    expect(set).not.toHaveProperty('role_id');
    expect(set).not.toHaveProperty('nom_complet');
    expect(set.poste).toBe('Serveur/se');
    expect(set.photo_url).toBe('https://exemple/nouvelle.jpg');
    // actif et externe_id sont toujours synchronisés (départs, rapprochement)
    expect(set.actif).toBe(true);
    expect(set.externe_id).toBe('ext-1');
  });
});

/**
 * 2026-09-25 — un caissier promu gérant restait CAISSIER dans le POS : son
 * intitulé RH gardait « caisse », et la règle `/caiss/` passait AVANT la règle
 * gérance. Il encaissait normalement mais son PIN était refusé dès qu'il
 * fallait approuver une remise, une annulation ou vider une table.
 */
describe('mapPosteRole — la gérance passe avant la caisse', () => {
  it.each([
    'Gérant',
    'Gérante',
    'Gérante caisse',
    'Manager',
    'Manager caissière',
    'Caissière / Gérante',
    'Caissier manager',
  ])('« %s » devient MANAGER', (poste) => {
    expect(mapPosteRole(poste).role).toBe('MANAGER');
  });

  it('un vrai caissier reste CAISSIER', () => {
    expect(mapPosteRole('Caissière').role).toBe('CAISSIER');
    expect(mapPosteRole('Caissier').role).toBe('CAISSIER');
  });

  it('les gardes précédents tiennent toujours', () => {
    // « ménagère » ne doit pas être lue comme « manager »
    expect(mapPosteRole('Ménagère').role).toBe('ENTRETIEN');
    expect(mapPosteRole('Plongeuse').role).toBe('ENTRETIEN');
    expect(mapPosteRole('Comptoiriste').role).toBe('COMPTOIRISTE');
    expect(mapPosteRole('Aide cuisinier').role).toBe('CUISINE');
    expect(mapPosteRole('Serveur/se').role).toBe('SERVEUR');
    // « responsable » reste en dernier : la cuisine garde ses droits de cuisine
    expect(mapPosteRole('Responsable cuisine').role).toBe('CUISINE');
  });
});
