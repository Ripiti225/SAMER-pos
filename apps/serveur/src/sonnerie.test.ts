import { describe, expect, it } from 'vitest';
import { DUREE_SONNERIE_S, motifVibration, partition } from './sonnerie';

describe('sonnerie « commande prête »', () => {
  it('dure au moins 10 secondes', () => {
    expect(DUREE_SONNERIE_S).toBeGreaterThanOrEqual(10);
    const notes = partition();
    const fin = Math.max(...notes.map((n) => n.debut + n.duree));
    expect(fin).toBeGreaterThanOrEqual(10);
    expect(fin).toBeLessThanOrEqual(DUREE_SONNERIE_S);
  });

  it('revient tout du long, sans trou de plus de 2 secondes', () => {
    const debuts = partition().map((n) => n.debut).sort((a, b) => a - b);
    for (let i = 1; i < debuts.length; i++) expect(debuts[i]! - debuts[i - 1]!).toBeLessThan(2);
  });

  it('la vibration couvre la même durée', () => {
    const totalMs = motifVibration().reduce((s, v) => s + v, 0);
    expect(totalMs).toBeGreaterThanOrEqual(10_000);
  });
});
