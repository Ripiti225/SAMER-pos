import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aleaCrypto,
  lireMois,
  moisTermine,
  selectionnerParticipants,
  tirerAuSort,
  type DepenseClient,
} from './siege-tirage.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const client = (n: number, montant: number | string, extra: Partial<DepenseClient> = {}): DepenseClient => ({
  client_id: id(n),
  telephone: `07000000${String(n).padStart(2, '0')}`,
  nom: `Client ${n}`,
  montant,
  nb_visites: 1,
  ...extra,
});

describe('mois du tirage', () => {
  test('« AAAA-MM » donne les bornes du mois entier, décembre compris', () => {
    assert.deepEqual(lireMois('2026-10'), {
      mois: '2026-10',
      premier_jour: '2026-10-01',
      debut: '2026-10-01T00:00:00.000Z',
      fin: '2026-11-01T00:00:00.000Z',
    });
    assert.equal(lireMois('2026-12')?.fin, '2027-01-01T00:00:00.000Z');
  });

  test('refuse tout ce qui n’est pas un mois explicite', () => {
    for (const v of ['2026-13', '2026-1', '2026-00', '26-10', '2026-10-01', '', null, 202610, '1999-05']) {
      assert.equal(lireMois(v), null, String(v));
    }
  });

  test('un mois en cours ne se tire pas ; il l’est dès minuit du 1er suivant', () => {
    const octobre = lireMois('2026-10')!;
    assert.equal(moisTermine(octobre, new Date('2026-10-31T23:59:59Z')), false);
    assert.equal(moisTermine(octobre, new Date('2026-11-01T00:00:00Z')), true);
  });
});

describe('sélection des 20 meilleurs clients', () => {
  test('garde les 20 plus gros montants, classés et numérotés', () => {
    const lignes = Array.from({ length: 25 }, (_, i) => client(i + 1, (i + 1) * 1000));
    const p = selectionnerParticipants(lignes);
    assert.equal(p.length, 20);
    assert.equal(p[0]!.montant, 25_000);
    assert.equal(p[0]!.rang, 1);
    assert.equal(p[19]!.montant, 6_000);
    assert.equal(p[19]!.rang, 20);
  });

  test('départage les ex aequo du dernier rang de façon stable, quel que soit l’ordre reçu', () => {
    // 19 clients bien placés, puis 3 ex aequo pour la 20e place.
    const tete = Array.from({ length: 19 }, (_, i) => client(i + 1, 100_000 - i));
    const exAequo = [
      client(30, 5_000, { nb_visites: 2, telephone: '0799' }),
      client(31, 5_000, { nb_visites: 3, telephone: '0700' }),
      client(32, 5_000, { nb_visites: 3, telephone: '0500' }),
    ];
    const a = selectionnerParticipants([...tete, ...exAequo]);
    const b = selectionnerParticipants([...exAequo.reverse(), ...tete.reverse()]);
    assert.deepEqual(a, b);
    // Plus de visites d'abord, puis le téléphone.
    assert.equal(a[19]!.client_id, id(32));
  });

  test('écarte les clients sans téléphone ou sans dépense, et lit les BIGINT en texte', () => {
    const p = selectionnerParticipants([
      client(1, '12500', { nb_visites: '4' }),
      client(2, 9_000, { telephone: '  ' }),
      client(3, 9_000, { telephone: null }),
      client(4, 0),
    ]);
    assert.deepEqual(p, [
      { rang: 1, client_id: id(1), telephone: '0700000001', nom: 'Client 1', montant: 12_500, nb_visites: 4 },
    ]);
  });

  test('un client sans nom participe : on affichera son téléphone', () => {
    const [p] = selectionnerParticipants([client(1, 3_000, { nom: '   ' })]);
    assert.equal(p!.nom, null);
    assert.equal(p!.telephone, '0700000001');
  });

  test('une fiche en double ne joue qu’une fois', () => {
    const p = selectionnerParticipants([client(1, 3_000), client(1, 4_000), client(2, 3_500)]);
    assert.deepEqual(p.map((x) => [x.client_id, x.montant]), [[id(1), 4_000], [id(2), 3_500]]);
  });

  test('moins de 20 clients : tous participent', () => {
    assert.equal(selectionnerParticipants([client(1, 1_000), client(2, 2_000)]).length, 2);
  });
});

describe('tirage au sort', () => {
  const participants = selectionnerParticipants(Array.from({ length: 20 }, (_, i) => client(i + 1, (i + 1) * 1000)));

  test('le gagnant est celui que désigne l’aléa, et l’aléa reçoit le nombre de participants', () => {
    let recu = 0;
    const gagnant = tirerAuSort(participants, (n) => {
      recu = n;
      return 7;
    });
    assert.equal(recu, 20);
    assert.equal(gagnant, participants[7]);
  });

  test('refuse un aléa hors bornes plutôt que d’enregistrer un tirage faux', () => {
    assert.throws(() => tirerAuSort(participants, () => 20));
    assert.throws(() => tirerAuSort(participants, () => -1));
    assert.throws(() => tirerAuSort(participants, () => 2.5));
    assert.throws(() => tirerAuSort(participants, () => Number.NaN));
  });

  test('refuse de tirer sans participant', () => {
    assert.throws(() => tirerAuSort([], () => 0), /Aucun participant/);
  });

  test('le générateur cryptographique reste dans [0, n[ et donne sa chance à chacun', () => {
    const vus = new Array<number>(20).fill(0);
    for (let i = 0; i < 20_000; i++) {
      const k = aleaCrypto(20);
      assert.ok(Number.isInteger(k) && k >= 0 && k < 20);
      vus[k]!++;
    }
    // ~1 000 attendus par rang : une borne large, qui ne vérifie que l'absence
    // de rang oublié ou massivement favorisé (pas un test statistique fin).
    for (const v of vus) assert.ok(v > 700 && v < 1_300, `répartition suspecte : ${vus.join(',')}`);
    assert.equal(aleaCrypto(1), 0);
    assert.throws(() => aleaCrypto(0));
  });

  test('chances égales : le classement ne pèse pas sur le tirage', () => {
    // L'aléa injecté parcourt tous les indices une fois : chaque participant
    // gagne exactement une fois, le 1er comme le 20e.
    const gagnants = new Set(participants.map((_, i) => tirerAuSort(participants, () => i).client_id));
    assert.equal(gagnants.size, 20);
  });
});
