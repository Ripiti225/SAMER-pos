import { describe, expect, it } from 'vitest';
import { actionsPossibles, libelleEvenement, resumeDetail, taille, versionsEpinglables, type VersionMaj } from './maj';

const v = (numero: number, statut: VersionMaj['statut'], purge = false) =>
  ({ numero, statut, fichiers_purges_le: purge ? '2026-10-01T00:00:00Z' : null }) as VersionMaj;

describe('écran Mises à jour', () => {
  it('cycle de vie : actions proposées au propriétaire', () => {
    expect(actionsPossibles({ statut: 'BROUILLON' })).toEqual(['PILOTE', 'RETIRER']);
    expect(actionsPossibles({ statut: 'PILOTE' })).toEqual(['GENERALE', 'RETIRER']);
    expect(actionsPossibles({ statut: 'GENERALE' })).toEqual(['RETIRER']);
    expect(actionsPossibles({ statut: 'RETIREE' })).toEqual([]);
  });

  it('épinglage : seulement pilote ou générale, fichiers encore là', () => {
    expect(versionsEpinglables([v(1, 'BROUILLON'), v(2, 'PILOTE'), v(3, 'GENERALE'), v(4, 'RETIREE'), v(5, 'GENERALE', true)]).map((x) => x.numero))
      .toEqual([2, 3]);
  });

  it('libellés des événements du contrat', () => {
    expect(libelleEvenement('INSTALLE')).toEqual({ texte: 'Installée', grave: false });
    expect(libelleEvenement('ECHEC_RETOUR_ARRIERE').grave).toBe(true);
    expect(libelleEvenement('NOUVEAU').texte).toBe('NOUVEAU');
  });

  it('résumé du détail et tailles', () => {
    expect(resumeDetail({ etape: 'MIGRATIONS', cause: 'Migration 0044 en échec' })).toBe('Migration 0044 en échec');
    expect(resumeDetail({ duree_s: 120 })).toBeNull();
    expect(taille(3 * 1024 * 1024 + 400 * 1024)).toBe('3,4 Mo');
    expect(taille(2048)).toBe('2 Ko');
    expect(taille(null)).toBe('—');
  });
});
