import { describe, expect, it } from 'vitest';
import { vueBord, type ContexteVue } from './bord';
import type { Bord } from './api';

const ANGRE = '11111111-1111-1111-1111-111111111111';
const RIVIERA = '22222222-2222-2222-2222-222222222222';

const NOMS = new Map([
  [ANGRE, 'Angré'],
  [RIVIERA, 'Riviera'],
]);

/** Le contexte d'une vue « un restaurant », le cas le plus courant. */
function ctx(restaurantId: string | null, nom = 'Angré', enrole = true): ContexteVue {
  return { restaurantId, nom, enrole, noms: NOMS };
}

/**
 * Une charge utile minimale mais RÉALISTE : deux restaurants, pour que le
 * filtrage ait quelque chose à filtrer. Les blocs non renseignés partent
 * vides — c'est exactement ce que fait la fonction `siege` quand une
 * migration n'est pas passée.
 */
function charge(partiel: Partial<Bord> = {}): Bord {
  return {
    periode: { debut: '2025-10-01T00:00:00.000Z', fin: '2025-10-08T00:00:00.000Z', debut_precedent: '2025-09-24T00:00:00.000Z' },
    total: 0,
    total_precedent: 0,
    restaurants: [],
    tendance: [],
    heures: [],
    plats: [],
    modes: [],
    types: [],
    tables: [],
    retours: [],
    depenses: [],
    ecarts: [],
    equipe: [],
    remises: [],
    annulations: [],
    inventaire: [],
    livraisons: [],
    absents: [],
    aucun_site_enrole: false,
    salle_non_publiee: false,
    ...partiel,
  };
}

describe('vueBord — le filtrage par restaurant', () => {
  it('ne garde que les lignes du restaurant demandé', () => {
    const d = charge({
      plats: [
        { restaurant_id: ANGRE, nom: 'Chawarma', quantite: 10, total: 30_000 },
        { restaurant_id: RIVIERA, nom: 'Pizza', quantite: 4, total: 26_000 },
      ],
    });

    const a = vueBord(d, ctx(ANGRE));
    expect(a.plats.map((p) => p.libelle)).toEqual(['Chawarma']);

    const b = vueBord(d, ctx(RIVIERA, 'Riviera'));
    expect(b.plats.map((p) => p.libelle)).toEqual(['Pizza']);
  });

  it('restaurantId à null garde tout le groupe et cumule', () => {
    const d = charge({
      plats: [
        { restaurant_id: ANGRE, nom: 'Chawarma', quantite: 10, total: 30_000 },
        { restaurant_id: RIVIERA, nom: 'Chawarma', quantite: 4, total: 12_000 },
      ],
    });

    const v = vueBord(d, ctx(null, 'Tous les restaurants'));
    expect(v.plats).toHaveLength(1);
    expect(v.plats[0]?.valeur).toBe(42_000);
    expect(v.plats[0]?.detail).toBe('× 14');
  });
});

describe('vueBord — les chiffres d’appel', () => {
  it('cumule le CA, les commandes et calcule le panier moyen', () => {
    const v = vueBord(
      charge({
        restaurants: [
          { restaurant_id: ANGRE, samtrackly_id: 'ANG', nom: 'Angré', marque: 'SAMER', enrole: true, nb_commandes: 4, ca: 12_000, nb_annulees: 0, remises: 0, panier_moyen: 3_000, ca_precedent: 10_000, nb_commandes_precedent: 5 },
        ],
      }),
      ctx(ANGRE),
    );

    expect(v.ca).toBe(12_000);
    expect(v.caPrecedent).toBe(10_000);
    expect(v.commandes).toBe(4);
    expect(v.panier).toBe(3_000);
  });

  it('panier moyen à zéro commande rend 0, jamais NaN ni Infinity', () => {
    const v = vueBord(charge(), ctx(ANGRE));
    expect(v.panier).toBe(0);
    expect(Number.isFinite(v.panier)).toBe(true);
  });
});

describe('vueBord — la robustesse', () => {
  it('une charge utile absente rend une vue vide, sans lever', () => {
    const v = vueBord(undefined, ctx(ANGRE));
    expect(v.ca).toBe(0);
    expect(v.plats).toEqual([]);
    expect(v.vide).toBe(true);
  });

  it('un bloc absent (migration pas passée) rend une liste vide, pas une exception', () => {
    const d = charge();
    // @ts-expect-error — on simule la réponse d'une fonction `siege` plus ancienne.
    delete d.livraisons;
    expect(() => vueBord(d, ctx(ANGRE))).not.toThrow();
    expect(vueBord(d, ctx(ANGRE)).livraisons).toEqual([]);
  });

  it('un site non enrôlé le dit, au lieu de laisser croire à une journée blanche', () => {
    const v = vueBord(charge(), ctx(ANGRE, 'Angré', false));
    expect(v.enrole).toBe(false);
    expect(v.ca).toBe(0);
  });
});

describe('vueBord — les agrégats par clé', () => {
  it('cumule les heures et les trie', () => {
    const d = charge({
      heures: [
        { restaurant_id: ANGRE, heure: 12, nb: 3, ca: 9_000 },
        { restaurant_id: ANGRE, heure: 19, nb: 8, ca: 24_000 },
        { restaurant_id: ANGRE, heure: 12, nb: 1, ca: 3_000 },
      ],
    });
    const v = vueBord(d, ctx(ANGRE));
    expect(v.heures).toEqual([
      { heure: 12, ca: 12_000, nb: 4 },
      { heure: 19, ca: 24_000, nb: 8 },
    ]);
  });

  it('les jours sortent triés par date croissante', () => {
    const d = charge({
      tendance: [
        { restaurant_id: ANGRE, jour: '2025-10-03', ca: 5_000, nb_commandes: 2 },
        { restaurant_id: ANGRE, jour: '2025-10-01', ca: 7_000, nb_commandes: 3 },
      ],
    });
    const v = vueBord(d, ctx(ANGRE));
    expect(v.pointsJour.map((p) => p.cle)).toEqual(['2025-10-01', '2025-10-03']);
    expect(v.pointsJour[0]?.valeurs[ANGRE]).toBe(7_000);
  });

  it('cumule l’équipe en heures et les salaires', () => {
    const d = charge({
      equipe: [
        { restaurant_id: ANGRE, utilisateur_id: 'u1', nom: 'Awa', poste: 'Caissière', nb_services: 3, minutes: 480, salaire: 15_000 },
        { restaurant_id: ANGRE, utilisateur_id: 'u2', nom: 'Koffi', poste: null, nb_services: 2, minutes: 240, salaire: 8_000 },
      ],
    });
    const v = vueBord(d, ctx(ANGRE));
    expect(v.heuresTravaillees).toBe(12);
    expect(v.salaires).toBe(23_000);
    expect(v.equipe[0]?.libelle).toBe('Awa');
  });
});
