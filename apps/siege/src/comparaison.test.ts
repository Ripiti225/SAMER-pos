import { describe, expect, it } from 'vitest';
import { ecarts, synthese } from './comparaison';
import type { VueBord } from './bord';

/** Une vue minimale : seuls les champs comparés comptent ici. */
function vue(partiel: Partial<VueBord> & { nom: string }): VueBord {
  return {
    restaurantId: null,
    enrole: true,
    vide: false,
    ca: 0,
    caPrecedent: 0,
    commandes: 0,
    commandesPrecedent: 0,
    panier: 0,
    depenses: 0,
    retoursMontant: 0,
    retoursNb: 0,
    ecartCumule: 0,
    heuresTravaillees: 0,
    salaires: 0,
    pointsJour: [],
    heures: [],
    platsHeure: new Map(),
    plats: [],
    caissiers: [],
    modes: [],
    tables: [],
    canaux: [],
    retours: [],
    depensesCategories: [],
    ecarts: [],
    equipe: [],
    remises: [],
    annulations: [],
    inventaire: [],
    livraisons: [],
    totalLivraisons: { nb: 0, contacts: 0 },
    absents: [],
    noms: new Map(),
    personnes: 0,
    ...partiel,
  };
}

const ligne = (liste: ReturnType<typeof ecarts>, cle: string) => liste.find((e) => e.cle === cle);

describe('ecarts — le calcul', () => {
  it('rend l’écart absolu et le pourcentage contre A', () => {
    const a = vue({ nom: 'Angré', ca: 1_240_000 });
    const b = vue({ nom: 'Riviera', ca: 980_000 });

    const ca = ligne(ecarts(a, b), 'ca');
    expect(ca?.valeurA).toBe(1_240_000);
    expect(ca?.valeurB).toBe(980_000);
    expect(ca?.absolu).toBe(-260_000);
    expect(ca?.pourcentage).toBe(-21);
  });

  it('B à zéro donne −100 %, qui est légitime et s’affiche', () => {
    const ca = ligne(ecarts(vue({ nom: 'A', ca: 500_000 }), vue({ nom: 'B', ca: 0 })), 'ca');
    expect(ca?.pourcentage).toBe(-100);
  });
});

/**
 * (b − a) / a avec a = 0 est une division par zéro. Le cas arrive pour de
 * bon : un restaurant fermé un jour férié, un bloc sans donnée. Afficher
 * « Infinity % » ou « NaN » serait pire que ne rien afficher.
 */
describe('ecarts — A à zéro', () => {
  it('ne produit aucun pourcentage et donne une raison en français', () => {
    const ca = ligne(ecarts(vue({ nom: 'Angré', ca: 0 }), vue({ nom: 'Riviera', ca: 980_000 })), 'ca');
    expect(ca?.pourcentage).toBeNull();
    expect(ca?.raison).toContain('Angré');
    expect(ca?.absolu).toBe(980_000);
  });

  it('garde l’écart absolu, qui lui reste vrai', () => {
    const ca = ligne(ecarts(vue({ nom: 'A', ca: 0 }), vue({ nom: 'B', ca: 12_000 })), 'ca');
    expect(ca?.absolu).toBe(12_000);
  });
});

/**
 * Les sites non enrôlés restent sélectionnables — les retirer laisserait
 * croire que le groupe compte moins de restaurants qu'en vrai. Mais leurs
 * zéros ne sont pas des ventes nulles : c'est l'absence de synchro.
 */
describe('ecarts — un site non enrôlé', () => {
  it('ne produit aucun pourcentage, dans un sens comme dans l’autre', () => {
    const a = vue({ nom: 'Angré', ca: 1_000_000 });
    const b = vue({ nom: 'Yopougon', ca: 0, enrole: false });

    for (const e of ecarts(a, b)) expect(e.pourcentage).toBeNull();
    for (const e of ecarts(b, a)) expect(e.pourcentage).toBeNull();
  });

  it('nomme le site fautif dans la raison', () => {
    const e = ligne(ecarts(vue({ nom: 'Angré', ca: 1_000_000 }), vue({ nom: 'Yopougon', enrole: false })), 'ca');
    expect(e?.raison).toContain('Yopougon');
  });
});

describe('ecarts — la polarité', () => {
  it('le chiffre d’affaires qui monte est une bonne nouvelle', () => {
    const e = ligne(ecarts(vue({ nom: 'A', ca: 100 }), vue({ nom: 'B', ca: 200 })), 'ca');
    expect(e?.polarite).toBe('bon');
    expect(e?.favorable).toBe(true);
  });

  it('les dépenses qui montent sont une mauvaise nouvelle', () => {
    const e = ligne(ecarts(vue({ nom: 'A', depenses: 100 }), vue({ nom: 'B', depenses: 200 })), 'depenses');
    expect(e?.polarite).toBe('mauvais');
    expect(e?.favorable).toBe(false);
  });

  it('les dépenses qui baissent sont une bonne nouvelle', () => {
    const e = ligne(ecarts(vue({ nom: 'A', depenses: 200 }), vue({ nom: 'B', depenses: 100 })), 'depenses');
    expect(e?.favorable).toBe(true);
  });

  it('l’écart de caisse se compare en valeur absolue : −8 000 est pire que −2 500', () => {
    const e = ligne(ecarts(vue({ nom: 'A', ecartCumule: -2_500 }), vue({ nom: 'B', ecartCumule: -8_000 })), 'ecart');
    expect(e?.valeurA).toBe(2_500);
    expect(e?.valeurB).toBe(8_000);
    expect(e?.favorable).toBe(false);
  });

  it('les heures travaillées sont neutres : ni bonnes ni mauvaises', () => {
    const e = ligne(ecarts(vue({ nom: 'A', heuresTravaillees: 10 }), vue({ nom: 'B', heuresTravaillees: 20 })), 'heures');
    expect(e?.polarite).toBe('neutre');
    expect(e?.favorable).toBe(false);
  });
});

describe('synthese', () => {
  it('la phrase porte sur le chiffre d’affaires', () => {
    const s = synthese(vue({ nom: 'Angré', ca: 1_240_000 }), vue({ nom: 'Riviera', ca: 980_000 }));
    expect(s.phrase).toContain('Riviera');
    expect(s.phrase).toContain('Angré');
    expect(s.phrase).toContain('21');
  });

  it('retient au plus trois lignes, jamais le CA ni les indicateurs neutres', () => {
    const a = vue({ nom: 'A', ca: 100, commandes: 100, panier: 100, depenses: 100, retoursMontant: 100, ecartCumule: 100, heuresTravaillees: 100 });
    const b = vue({ nom: 'B', ca: 50, commandes: 90, panier: 50, depenses: 400, retoursMontant: 200, ecartCumule: 110, heuresTravaillees: 900 });

    const s = synthese(a, b);
    expect(s.lignes).toHaveLength(3);
    expect(s.lignes.map((l) => l.cle)).not.toContain('ca');
    expect(s.lignes.map((l) => l.cle)).not.toContain('heures');
  });

  it('trie par écart RELATIF, pas absolu', () => {
    // Les trois tris doivent DIFFÉRER : dépenses +300 %, commandes +90 %,
    // panier −50 % en relatif ; mais en ABSOLU le panier écrase tout avec
    // −500 000. Un test où les deux ordres coïncident ne prouve rien.
    const a = vue({ nom: 'A', ca: 1, commandes: 10, panier: 1_000_000, depenses: 100 });
    const b = vue({ nom: 'B', ca: 1, commandes: 19, panier: 500_000, depenses: 400 });

    expect(synthese(a, b).lignes.map((l) => l.cle)).toEqual(['depenses', 'commandes', 'panier']);
  });

  it('A à zéro : la phrase le dit au lieu d’un pourcentage', () => {
    const s = synthese(vue({ nom: 'Angré', ca: 0 }), vue({ nom: 'Riviera', ca: 980_000 }));
    expect(s.phrase).toContain('Angré');
    expect(s.phrase).not.toContain('%');
  });

  /**
   * Le piège : un site non enrôlé a TOUJOURS un CA à zéro. Tester la valeur
   * avant `enrole` fait donc dire à la synthèse « il n'a rien vendu » — un
   * constat commercial, là où la vérité est qu'on ne sait rien de ses ventes.
   */
  it('un site non enrôlé n’est jamais décrit comme n’ayant rien vendu', () => {
    const s = synthese(vue({ nom: 'Yopougon', ca: 0, enrole: false }), vue({ nom: 'Angré', ca: 1_000_000 }));
    expect(s.phrase).toContain('Yopougon');
    expect(s.phrase).toContain('synchronise');
    expect(s.phrase).not.toContain('rien vendu');
    expect(s.phrase).not.toContain('%');
  });

  it('égalité parfaite : la phrase le dit, aucune ligne', () => {
    const s = synthese(vue({ nom: 'A', ca: 500 }), vue({ nom: 'B', ca: 500 }));
    expect(s.phrase).toContain('autant');
    expect(s.lignes).toEqual([]);
  });
});
