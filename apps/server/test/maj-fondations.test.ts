import { describe, expect, it } from 'vitest';
import {
  deciderCreneau,
  genererPaire,
  ouvrirManifesteSigne,
  serialiserManifeste,
  signer,
  type ManifesteApp,
} from '../src/modules/maj/fondations.js';

// Vérifie que le serveur (ESM, TypeScript) consomme bien les modules CommonJS
// du lanceur, avec leurs types. Les tests complets sont côté apps/desktop
// (`node --test`), sans base de données.
describe('fondations maj importées depuis le serveur', () => {
  it('signe et rouvre un manifeste', () => {
    const { clePublique, clePrivee } = genererPaire();
    const manifeste: ManifesteApp = {
      format: 1,
      type: 'APP',
      numero: 1,
      version: '2026.10.23-1',
      commit: 'abc1234',
      publie_le: '2026-10-23T05:00:00.000Z',
      lanceur_min: 1,
      node_min: '22.0.0',
      dependances: { empreinte: 'a'.repeat(64) },
      migrations: { derniere: null, nouvelles: [], retrocompatibles: true },
      notes: '',
      archive: { sha256: 'b'.repeat(64), taille: 10 },
      morceaux: [{ nom: 'paquet-1.tar.gz.000', sha256: 'c'.repeat(64), taille: 10 }],
      fichiers: [{ chemin: 'VERSION.json', sha256: 'd'.repeat(64), taille: 1 }],
    };
    const octets = serialiserManifeste(manifeste);
    const { cle } = ouvrirManifesteSigne(octets, signer(octets, clePrivee), { actuelle: clePublique });
    expect(cle).toBe('actuelle');
  });

  it('décide le créneau', () => {
    const d = deciderCreneau({
      maintenant: new Date('2026-10-24T06:00:00Z'),
      typeSite: 'H24',
      pretLe: new Date('2026-10-23T14:00:00Z'),
      auDemarrage: false,
    });
    expect(d.action).toBe('INSTALLER');
  });
});
