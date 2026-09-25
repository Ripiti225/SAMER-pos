import { describe, expect, it } from 'vitest';
import { DUREE_MAX_JOURS, personnalisee } from './periode';

/**
 * `fin` est EXCLUE côté cloud (`< p_fin`). Une plage « jusqu'au 31 octobre »
 * doit donc s'envoyer avec `fin` au 1er novembre : sinon le 31 octobre entier
 * disparaît du rapport, et personne ne s'en aperçoit avant la clôture du mois.
 */
describe('personnalisee — les bornes envoyées au cloud', () => {
  it('inclut le dernier jour saisi : fin = minuit du lendemain, en UTC', () => {
    const r = personnalisee('2025-10-01', '2025-10-31');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.periode.debut).toBe('2025-10-01T00:00:00.000Z');
    expect(r.periode.fin).toBe('2025-11-01T00:00:00.000Z');
  });

  it("accepte une plage d'un seul jour", () => {
    const r = personnalisee('2025-10-07', '2025-10-07');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.periode.debut).toBe('2025-10-07T00:00:00.000Z');
    expect(r.periode.fin).toBe('2025-10-08T00:00:00.000Z');
  });

  it('porte la clé "perso", qui n\'est pas une chip relative', () => {
    const r = personnalisee('2025-10-01', '2025-10-31');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.periode.cle).toBe('perso');
  });
});

describe('personnalisee — les refus', () => {
  it('refuse une plage incomplete', () => {
    expect(personnalisee('', '2025-10-31')).toEqual({ ok: false, refus: 'incomplete' });
    expect(personnalisee('2025-10-01', '')).toEqual({ ok: false, refus: 'incomplete' });
  });

  it('refuse un debut posterieur a la fin', () => {
    expect(personnalisee('2025-10-31', '2025-10-01')).toEqual({ ok: false, refus: 'inversee' });
  });

  it('accepte exactement 366 jours et refuse le 367e', () => {
    const debut = new Date(Date.UTC(2024, 0, 1));
    const finOk = new Date(debut.getTime() + (DUREE_MAX_JOURS - 1) * 86_400_000);
    const finTrop = new Date(debut.getTime() + DUREE_MAX_JOURS * 86_400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    expect(personnalisee(iso(debut), iso(finOk)).ok).toBe(true);
    expect(personnalisee(iso(debut), iso(finTrop))).toEqual({ ok: false, refus: 'trop_longue' });
  });
});

/**
 * Le libellé est ce que le siège lit dans le bandeau et dans l'en-tête d'une
 * colonne de comparaison. Il écrit les vraies dates, et n'encombre pas d'une
 * année quand c'est l'année en cours.
 */
describe('personnalisee — le libellé', () => {
  const enOctobre2025 = new Date('2025-10-15T10:00:00.000Z');

  it('meme mois, annee en cours : "1 → 31 oct."', () => {
    const r = personnalisee('2025-10-01', '2025-10-31', enOctobre2025);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.periode.libelle).toBe('1 → 31 oct.');
  });

  it('mois differents, annee en cours : "1 oct. → 15 nov."', () => {
    const r = personnalisee('2025-10-01', '2025-11-15', enOctobre2025);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.periode.libelle).toBe('1 oct. → 15 nov.');
  });

  it("annee passee : l'annee est ecrite", () => {
    const r = personnalisee('2024-10-01', '2024-10-31', enOctobre2025);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.periode.libelle).toBe('1 → 31 oct. 2024');
  });

  it('deux annees differentes : chaque borne porte la sienne', () => {
    const r = personnalisee('2024-12-20', '2025-01-10', enOctobre2025);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.periode.libelle).toBe('20 déc. 2024 → 10 janv. 2025');
  });
});
