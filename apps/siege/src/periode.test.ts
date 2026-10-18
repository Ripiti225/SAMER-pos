import { describe, expect, it } from 'vitest';
import { DUREE_MAX_JOURS, libelleBornes, personnalisee } from './periode';

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

  it("porte la clé « perso », qui n'est pas une chip relative", () => {
    const r = personnalisee('2025-10-01', '2025-10-31');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.periode.cle).toBe('perso');
  });
});

describe('personnalisee — les refus', () => {
  it('refuse une plage incomplète', () => {
    expect(personnalisee('', '2025-10-31')).toEqual({ ok: false, refus: 'incomplete' });
    expect(personnalisee('2025-10-01', '')).toEqual({ ok: false, refus: 'incomplete' });
  });

  it('refuse un début postérieur à la fin', () => {
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

  it('même mois, année en cours : « 1 → 31 oct. »', () => {
    const r = personnalisee('2025-10-01', '2025-10-31', enOctobre2025);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.periode.libelle).toBe('1 → 31 oct.');
  });

  it('mois différents, année en cours : « 1 oct. → 15 nov. »', () => {
    const r = personnalisee('2025-10-01', '2025-11-15', enOctobre2025);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.periode.libelle).toBe('1 oct. → 15 nov.');
  });

  it("année passée : l'année est écrite", () => {
    const r = personnalisee('2024-10-01', '2024-10-31', enOctobre2025);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.periode.libelle).toBe('1 → 31 oct. 2024');
  });

  it('deux années différentes : chaque borne porte la sienne', () => {
    const r = personnalisee('2024-12-20', '2025-01-10', enOctobre2025);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.periode.libelle).toBe('20 déc. 2024 → 10 janv. 2025');
  });
});

/**
 * « Qu'a-t-on vendu de 08:24 à 16:18 ? » : l'heure de fin tapée est INCLUSE,
 * comme on la lit. La vente de 16:18:40 en fait partie, donc `fin` (exclue
 * côté cloud) est posée à 16:19:00.
 */
describe('personnalisee — les heures', () => {
  const enOctobre2026 = new Date('2026-10-18T10:00:00.000Z');

  it('un seul jour, 08:24 → 16:18 : fin à 16:19, heure de fin incluse', () => {
    const r = personnalisee('2026-10-18', '2026-10-18', enOctobre2026, { de: '08:24', a: '16:18' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.periode.debut).toBe('2026-10-18T08:24:00.000Z');
    expect(r.periode.fin).toBe('2026-10-18T16:19:00.000Z');
    expect(r.periode.libelle).toBe('18 oct. · 08:24 → 16:18');
  });

  it('sur deux jours, chaque borne porte sa date', () => {
    const r = personnalisee('2026-10-17', '2026-10-18', enOctobre2026, { de: '18:00', a: '02:30' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.periode.debut).toBe('2026-10-17T18:00:00.000Z');
    expect(r.periode.fin).toBe('2026-10-18T02:31:00.000Z');
    expect(r.periode.libelle).toBe('17 oct. 18:00 → 18 oct. 02:30');
  });

  it("une seule heure : l'autre borne reste minuit", () => {
    const r = personnalisee('2026-10-18', '2026-10-18', enOctobre2026, { de: '08:24', a: '' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.periode.debut).toBe('2026-10-18T08:24:00.000Z');
    expect(r.periode.fin).toBe('2026-10-19T00:00:00.000Z');
  });

  it('sans heure, rien ne change : journées entières', () => {
    const r = personnalisee('2026-10-01', '2026-10-31', enOctobre2026, { de: '', a: '' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.periode.debut).toBe('2026-10-01T00:00:00.000Z');
    expect(r.periode.fin).toBe('2026-11-01T00:00:00.000Z');
    expect(r.periode.libelle).toBe('1 → 31 oct.');
  });

  it('refuse une heure de fin avant celle de début, le même jour', () => {
    expect(personnalisee('2026-10-18', '2026-10-18', enOctobre2026, { de: '16:18', a: '08:24' }))
      .toEqual({ ok: false, refus: 'inversee' });
  });

  it('une heure à moitié tapée attend, sans message', () => {
    expect(personnalisee('2026-10-18', '2026-10-18', enOctobre2026, { de: '08:2', a: '' }))
      .toEqual({ ok: false, refus: 'incomplete' });
  });
});

/** Le libellé de la période d'en face, rendue par le cloud. */
describe('libelleBornes', () => {
  it('des jours entiers restent des jours', () => {
    expect(libelleBornes('2026-10-17T00:00:00.000Z', '2026-10-18T00:00:00.000Z')).toBe('sam. 17 oct.');
  });

  it('une plage horaire garde ses heures, fin incluse', () => {
    expect(libelleBornes('2026-10-17T08:24:00.000Z', '2026-10-17T16:19:00.000Z')).toBe('sam. 17 oct. · 08:24 → 16:18');
  });
});
