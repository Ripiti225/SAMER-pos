import { describe, expect, it } from 'vitest';
import { champsSynchro } from '../src/modules/equipe/sync-samtrackly.js';

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
