import { describe, expect, it } from 'vitest';
import { evaluerSite, ilYa, trierParUrgence, versionMajoritaire, type SanteBrute } from './sante';

const MAINTENANT = new Date('2026-10-21T12:00:00Z');
const avant = (minutes: number) => new Date(MAINTENANT.getTime() - minutes * 60_000).toISOString();

/** Un site sain, avec battement, contact il y a 2 min. Chaque test en dérive. */
function sante(p: Partial<SanteBrute> = {}): SanteBrute {
  return {
    restaurant_id: 'r1',
    code: 'ANGRE',
    actif: true,
    dernier_push: avant(10),
    dernier_pull: avant(2),
    rejets_24h: 0,
    battement_le: avant(2),
    version_code: '3ff10db',
    commit_git: '3ff10db0123456789abcdef0123456789abcdef0',
    lignes_en_attente: 0,
    plus_ancienne_en_attente: null,
    dernier_acquittement: avant(10),
    derniere_descente: avant(7),
    derniere_erreur: null,
    heure_site: avant(2),
    ...p,
  };
}

const evaluer = (p: Partial<SanteBrute> | null, enrole = true) =>
  evaluerSite({ enrole, sante: p === null ? null : sante(p) }, MAINTENANT);

describe('couleur d’un site', () => {
  it('vert sous 15 min, orange sous 24 h, rouge au-delà', () => {
    expect(evaluer({}).couleur).toBe('vert');

    const orange = evaluer({ dernier_push: avant(60), dernier_pull: avant(30), battement_le: avant(30), derniere_descente: avant(30) });
    expect(orange.couleur).toBe('orange');
    expect(orange.resume).toContain('30 min');
    expect(orange.points_bloques).toBe(false);

    const rouge = evaluer({ dernier_push: avant(26 * 60), dernier_pull: avant(25 * 60), battement_le: avant(25 * 60), derniere_descente: avant(25 * 60) });
    expect(rouge.couleur).toBe('rouge');
    expect(rouge.points_bloques).toBe(true);
  });

  it('un site calme la nuit (aucun PUSH) reste vert grâce à la descente', () => {
    const r = evaluer({ dernier_push: avant(9 * 60), dernier_pull: avant(3) });
    expect(r.couleur).toBe('vert');
    expect(r.dernier_contact).toBe(avant(2)); // le battement, le plus récent
  });

  it('jamais synchronisé : rouge, points bloqués', () => {
    const r = evaluer({ dernier_push: null, dernier_pull: null, battement_le: null });
    expect(r.couleur).toBe('rouge');
    expect(r.resume).toContain('jamais');
    expect(r.points_bloques).toBe(true);
    expect(evaluer(null).couleur).toBe('rouge');
  });

  it('non enrôlé : gris, pas d’alerte', () => {
    const r = evaluer(null, false);
    expect(r.couleur).toBe('gris');
    expect(r.points_bloques).toBe(false);
  });

  it('le site parle mais ses ventes restent chez lui : la couleur suit la plus vieille vente', () => {
    const r = evaluer({ lignes_en_attente: 14, plus_ancienne_en_attente: avant(3 * 60), derniere_erreur: 'Le cloud a refusé commandes' });
    expect(r.couleur).toBe('orange');
    expect(r.en_attente).toBe(14);
    expect(r.resume).toContain('14 ligne(s)');
    expect(r.resume).toContain('Le cloud a refusé commandes');

    // Quelques ventes de la dernière minute : normal, on reste vert.
    expect(evaluer({ lignes_en_attente: 2, plus_ancienne_en_attente: avant(1) }).couleur).toBe('vert');
    // Bloquées depuis plus de 24 h : rouge.
    expect(evaluer({ lignes_en_attente: 2, plus_ancienne_en_attente: avant(30 * 60) }).couleur).toBe('rouge');
  });
});

describe('règle des 24 h du paiement en points', () => {
  it('suit la dernière descente APPLIQUÉE par le site, pas le dernier contact', () => {
    // Le site parle (montée OK) mais n'applique plus la descente depuis 25 h.
    const r = evaluer({ derniere_descente: avant(25 * 60) });
    expect(r.points_bloques).toBe(true);
    expect(r.couleur).toBe('rouge');
    expect(r.resume).toContain('paiement en points bloqué');
  });

  it('annonce le temps restant avant blocage', () => {
    const r = evaluer({ derniere_descente: avant(20 * 60) });
    expect(r.points_bloques).toBe(false);
    expect(r.points_bloques_dans_ms).toBe(4 * 3_600_000);
  });

  it('POS sans battement : se rabat sur la dernière descente servie', () => {
    const ancien = evaluer({ battement_le: null, heure_site: null, version_code: null, lignes_en_attente: null, derniere_descente: null, dernier_pull: avant(4) });
    expect(ancien.points_bloques).toBe(false);
    expect(ancien.en_attente).toBeNull(); // inconnu, pas zéro
    expect(ancien.couleur).toBe('vert');
  });

  it('battement présent mais aucune descente appliquée : bloqué', () => {
    const r = evaluer({ derniere_descente: null });
    expect(r.points_bloques).toBe(true);
    expect(r.resume).toContain('Aucune descente');
  });
});

describe('détails', () => {
  it('signale une horloge de site décalée', () => {
    expect(evaluer({ heure_site: avant(2 + 30) }).decalage_horloge_ms).toBe(-30 * 60_000);
    expect(evaluer({ heure_site: avant(3) }).decalage_horloge_ms).toBeNull();
  });

  it('repère la version à part, sauf égalité ou version unique', () => {
    const s = (v: string | null) => ({ sante: v === null ? null : sante({ version_code: v }) });
    expect(versionMajoritaire([s('a'), s('a'), s('b'), s(null)])).toBe('a');
    expect(versionMajoritaire([s('a'), s('a')])).toBeNull();
    expect(versionMajoritaire([s('a'), s('b')])).toBeNull();
  });

  it('trie les sites à traiter en premier', () => {
    const l = (nom: string, couleur: 'vert' | 'rouge' | 'gris' | 'orange') => ({
      nom,
      evaluation: { ...evaluer({}), couleur },
    });
    expect(trierParUrgence([l('B', 'vert'), l('A', 'gris'), l('C', 'rouge'), l('D', 'orange'), l('A', 'vert')]).map((x) => `${x.nom}${x.evaluation.couleur[0]}`))
      .toEqual(['Cr', 'Do', 'Av', 'Bv', 'Ag']);
  });

  it('formate les durées en français', () => {
    expect(ilYa(20_000)).toBe('à l’instant');
    expect(ilYa(5 * 60_000)).toBe('il y a 5 min');
    expect(ilYa(3 * 3_600_000)).toBe('il y a 3 h');
    expect(ilYa(72 * 3_600_000)).toBe('il y a 3 j');
  });
});
