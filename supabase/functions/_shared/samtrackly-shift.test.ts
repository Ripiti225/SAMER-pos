// ──────────────────────────────────────────────────────────────────────────────
// Tests de samtrackly-shift.ts — conversion rapport Z → ligne points_shifts.
//
// C'est la seule partie du pont qui manipule de l'argent. Une erreur ici ne
// plante pas : elle produit un chiffre faux qui part en production et se
// retrouve dans les rapports mensuels.
//
// Exécution locale (Deno n'est pas installé sur le Mac, Node 26 lit le TS) :
//   node --test supabase/functions/_shared/samtrackly-shift.test.ts
// ──────────────────────────────────────────────────────────────────────────────
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { construireShift, journeeDisponible, doitTransferer, totalVentePoint, totalVenteMachinePoint, journeePourTransfert, aDejaEtePlace, ACHATS, SALAIRES } from './samtrackly-shift.ts';

// Un shift réaliste : 412 000 F de ventes système, réglées en espèces, Wave,
// Yango et un Kdo. 10 000 F de dépenses sorties du tiroir, 6 000 F de salaires.
// Fixture cohérente de bout en bout, vérifiée à la main :
//   théorique = fond 25 000 + espèces 182 000 − registre 16 000 = 191 000
//   comptées 193 500 → écart +2 500 (excédent)
//   vente système = 182 000 + 30 000 + 18 000 + 40 000 + 12 000 + 5 000 = 287 000
const RAPPORT_Z = {
  fond_de_caisse: 25_000,
  especes_comptees: 193_500,
  especes_theorique: 191_000,
  ecart: 2_500,
  depenses: 16_000, // registre ENTIER : achats + salaires
  livraisons: { YANGO: 40_000, GLOVO: 12_000 },
  partenaires: {
    YANGO: { nb: 5, total: 40_000, contacts: 4, refs: 5 },
    GLOVO: { nb: 2, total: 12_000, contacts: 1, refs: 2 },
    SAMER_DELLY: { nb: 3, total: 18_000, contacts: 2, refs: 0 },
  },
  offerts: { nb: 1, total: 5_000 },
  modes_declares: { WAVE: 30_000, ORANGE_MONEY: 18_000 },
  par_mode: { ESPECES: 182_000, WAVE: 30_000, ORANGE_MONEY: 18_000 },
  total_ventes: 287_000,
};

const DEPENSES = [
  { categorie: 'MARCHE', montant: 7_000, supprime: false },
  { categorie: 'LEGUMES', montant: 3_000, supprime: false },
  { categorie: 'SALAIRES', montant: 5_000, supprime: false },
  { categorie: 'ENCOURAGEMENTS', montant: 1_000, supprime: false },
  { categorie: 'ANNEXES', montant: 9_999, supprime: true }, // effacée sur le site
];

const SERVICE = {
  id: 'svc-1',
  ouvert_le: '2026-08-17T16:00:00Z',
  cloture_le: '2026-08-18T01:30:00Z',
  fond_de_caisse: 25_000,
  especes_comptees: 193_500,
  especes_theorique: 191_000,
  ecart: 2_500,
  explication_ecart: 'Deux encaissements espèces ont été inversés.',
  rapport_z: RAPPORT_Z,
};

const CTX = {
  restaurantId: 'resto-st',
  pointId: 'point-st',
  caissierId: 'user-st',
  caissierNom: 'Flora',
};

describe('construireShift — les montants', () => {

  test('les dépenses ne portent que les achats, jamais les salaires', () => {
    // 7 000 + 3 000. Les 5 000 de salaire et les 1 000 d'encouragement partent
    // dans les présences ; la ligne effacée sur le site est exclue.
    assert.equal(construireShift(SERVICE, DEPENSES, CTX).depenses, 10_000);
  });

  test('une dépense effacée sur le site n’est jamais comptée', () => {
    const sansEffacee = DEPENSES.filter(d => !d.supprime);
    assert.equal(
      construireShift(SERVICE, DEPENSES, CTX).depenses,
      construireShift(SERVICE, sansEffacee, CTX).depenses,
    );
  });

  test('les fournisseurs et les retours restent à zéro', () => {
    const s = construireShift(SERVICE, DEPENSES, CTX);
    assert.equal(s.fournisseurs, 0, 'le gérant paie les fournisseurs, pas la caisse');
    assert.equal(s.retour, 0, 'retour_pos porte le montant, retour reste neutre');
  });

  test('les canaux reprennent les livraisons et les modes déclarés', () => {
    const s = construireShift(SERVICE, DEPENSES, CTX);
    assert.equal(s.yango_cse, 40_000);
    assert.equal(s.glovo_cse, 12_000);
    assert.equal(s.wave, 30_000);
    assert.equal(s.om, 18_000);
    assert.equal(s.kdo, 5_000);
  });

  test('les compteurs partenaires du rapport Z alimentent les colonnes POS du shift', () => {
    const s = construireShift(SERVICE, DEPENSES, CTX);
    assert.equal(s.pos_nb_yango, 5);
    assert.equal(s.pos_nb_glovo, 2);
    assert.equal(s.pos_nb_contacts, 7, 'les contacts de tous les partenaires sont cumulés');
  });

  // ── LE POINT LE PLUS SENSIBLE : d'où vient la part espèces ──
  // Décision du boss (2026-08-20) : `espece` doit refléter le COMPTAGE À
  // L'AVEUGLE de la caissière, pas ce que le système a enregistré. Sinon la
  // vente théorique est une copie du système, et l'écart théorique/machine ne
  // peut plus jamais révéler un manquant en espèces — le contrôle est mort.
  //
  // La règle « SamerTrackly ne lit jamais le fond du POS » tient toujours : le
  // fond sert ICI, dans le cloud POS, à retrouver la remise nette. Il n'est
  // transmis dans AUCUN champ envoyé à SamerTrackly (test plus bas).

  test('espece vient du comptage à l’aveugle, moins le fond', () => {
    // 193 500 comptées − 25 000 de fond = 168 500 réellement remis.
    assert.equal(construireShift(SERVICE, DEPENSES, CTX).espece, 168_500);
  });

  test('un manquant en espèces fait baisser la vente du shift d’autant', () => {
    // C'est TOUT l'intérêt du changement : 10 000 manquants au comptage
    // doivent se voir dans la vente théorique, donc dans l'écart avec la
    // vente machine. Avant, ce manquant était invisible à ce niveau.
    const manquant = { ...SERVICE, especes_comptees: 183_500, ecart: -7_500 };
    const normal = construireShift(SERVICE, DEPENSES, CTX);
    const avecTrou = construireShift(manquant, DEPENSES, CTX);
    assert.equal(normal.vente_shift - avecTrou.vente_shift, 10_000);
  });

  test('le fond n’est transmis dans AUCUN champ envoyé à SamerTrackly', () => {
    // La règle du boss tient : le fond sert au calcul dans le cloud POS, mais
    // ne franchit jamais la frontière — SamerTrackly garde sa propre logique
    // de fond (fond de veille + espece = fond restant).
    const s = construireShift(SERVICE, DEPENSES, CTX) as Record<string, unknown>;
    for (const cle of Object.keys(s)) {
      assert.ok(!cle.includes('fond'), `le champ ${cle} ne doit pas exister`);
    }
    assert.equal(Object.values(s).includes(SERVICE.fond_de_caisse), false,
      'la valeur du fond ne doit apparaître dans aucun champ');
  });

  // ── L'INVARIANT CENTRAL ──
  // vente du shift − vente système = écart mesuré au comptage. C'est ce qui
  // rend l'écart théorique/machine lisible : il vaut exactement le manquant
  // (ou le surplus) que la caissière a au tiroir.

  test('vente du shift − vente système = écart mesuré', () => {
    const s = construireShift(SERVICE, DEPENSES, CTX);
    assert.equal(s.vente_shift - RAPPORT_Z.total_ventes, s.ecart_pos);
  });

  test('quand le tiroir tombe juste, la vente retombe sur la vente système', () => {
    // Sans écart, les deux chiffres se rejoignent exactement.
    const juste = { ...SERVICE, especes_comptees: 191_000, ecart: 0 };
    assert.equal(construireShift(juste, DEPENSES, CTX).vente_shift, RAPPORT_Z.total_ventes);
  });

  test('la vente système du POS est transmise pour alimenter vente_machine', () => {
    // Le gérant ne tape plus ce chiffre : le POS le connaît exactement.
    assert.equal(construireShift(SERVICE, DEPENSES, CTX).vente_systeme_pos, 287_000);
  });

  test('l’écart mesuré part aussi dans ecart_pos, pour l’imputation', () => {
    assert.equal(construireShift(SERVICE, DEPENSES, CTX).ecart_pos, 2_500);
  });

  test('l’explication du caissier accompagne l’écart dans SamerTrackly', () => {
    assert.equal(
      construireShift(SERVICE, DEPENSES, CTX).explication_ecart,
      'Deux encaissements espèces ont été inversés.',
    );
  });
});

describe('construireShift — la journée de rattachement', () => {

  test('un shift de nuit compte pour le jour où il a commencé', () => {
    // Ouvert le 17 à 16h, clôturé le 18 à 01h30 → journée du 17.
    assert.equal(construireShift(SERVICE, DEPENSES, CTX).date, '2026-08-17');
  });

  test('un shift ouvert à minuit compte pour le jour qui commence', () => {
    // 00h→08h : ouvert le 18 à 00h00 → journée du 18, pas du 17.
    const nuit = { ...SERVICE, ouvert_le: '2026-08-18T00:00:00Z', cloture_le: '2026-08-18T08:00:00Z' };
    assert.equal(construireShift(nuit, DEPENSES, CTX).date, '2026-08-18');
  });
});

describe('doitTransferer — la journée de reprise par site', () => {

  // On compare la JOURNÉE D'EXPLOITATION, pas l'heure de clôture. Le shift du
  // soir se clôture après minuit : filtrer sur l'heure de clôture le ferait
  // basculer dans la journée suivante et on recréerait un shift sur une journée
  // déjà saisie — parfois même sur un point validé.
  const shift = (ouvert: string, cloture: string) => ({ id: 's', ouvert_le: ouvert, cloture_le: cloture });

  const DEPUIS_17 = { transferer_depuis: '2026-08-17', actif: true };

  test('sans configuration, un site ne transfère RIEN', () => {
    // Défaut volontairement fermé : un site dont la reprise n'a pas été
    // décidée déverserait tout son historique par-dessus les shifts déjà
    // saisis à la main. Le silence est le comportement sûr.
    const s = shift('2026-08-17T16:00:00Z', '2026-08-18T01:30:00Z');
    assert.equal(doitTransferer(s, undefined), false);
    assert.equal(doitTransferer(s, null), false);
  });

  // ── LE CAS QUI A MOTIVÉ CE CHOIX ──
  test('le shift du soir de la VEILLE reste exclu, même clôturé après minuit', () => {
    // Angré 7E, 16/08 : ouvert à 16h, clôturé le 17 à 00h00. Sa journée est le
    // 16, déjà saisi à la main ET déjà VALIDÉ par le gérant. Un filtre sur
    // l'heure de clôture l'aurait laissé passer.
    const veille = shift('2026-08-16T16:00:00Z', '2026-08-17T00:00:00Z');
    assert.equal(doitTransferer(veille, DEPUIS_17), false);
  });

  test('le shift de nuit du jour de reprise est transféré', () => {
    // 00h→08h du 17 : sa journée est le 17. C'est celui que le boss a supprimé
    // à la main pour le remplacer par celui du POS — il doit remonter.
    const nuit = shift('2026-08-17T00:00:00Z', '2026-08-17T08:00:00Z');
    assert.equal(doitTransferer(nuit, DEPUIS_17), true);
  });

  test('les shifts des jours suivants sont transférés', () => {
    assert.equal(doitTransferer(shift('2026-08-18T08:00:00Z', '2026-08-18T16:00:00Z'), DEPUIS_17), true);
  });

  test('une journée antérieure est ignorée', () => {
    assert.equal(doitTransferer(shift('2026-08-14T08:00:00Z', '2026-08-14T16:00:00Z'), DEPUIS_17), false);
  });

  test('un site désactivé ne transfère plus, même configuré', () => {
    // L'interrupteur d'arrêt : on coupe un site sans effacer sa configuration.
    const s = shift('2026-08-18T08:00:00Z', '2026-08-18T16:00:00Z');
    assert.equal(doitTransferer(s, { transferer_depuis: '2026-08-17', actif: false }), false);
  });

  test('un service sans heure d’ouverture n’est jamais transféré', () => {
    assert.equal(doitTransferer({ id: 's', ouvert_le: null, cloture_le: '2026-08-18T16:00:00Z' }, DEPUIS_17), false);
  });

  test('un service non clôturé n’est jamais transféré', () => {
    // Un shift en cours n'a pas de rapport Z : il n'y a rien à transférer.
    assert.equal(doitTransferer({ id: 's', ouvert_le: '2026-08-18T08:00:00Z', cloture_le: null }, DEPUIS_17), false);
  });

  test('une journée de reprise illisible ferme le robinet', () => {
    const s = shift('2026-08-18T08:00:00Z', '2026-08-18T16:00:00Z');
    assert.equal(doitTransferer(s, { transferer_depuis: 'pas-une-date', actif: true }), false);
  });
});

describe('journeeDisponible — un point validé ne se rouvre pas', () => {

  test('sans point existant, la journée reste celle du shift', () => {
    assert.equal(journeeDisponible('2026-08-17', new Map()), '2026-08-17');
  });

  test('un point ouvert accueille le shift', () => {
    const points = new Map([['2026-08-17', false]]); // false = pas encore validé
    assert.equal(journeeDisponible('2026-08-17', points), '2026-08-17');
  });

  test('un point validé renvoie le shift au jour suivant', () => {
    // Règle du boss : « quand un jour est validé on ne peut plus le
    // sélectionner » — le shift va au jour d'après, il n'est jamais perdu.
    const points = new Map([['2026-08-17', true]]);
    assert.equal(journeeDisponible('2026-08-17', points), '2026-08-18');
  });

  test('plusieurs jours validés d’affilée sont sautés', () => {
    const points = new Map([['2026-08-17', true], ['2026-08-18', true], ['2026-08-19', false]]);
    assert.equal(journeeDisponible('2026-08-17', points), '2026-08-19');
  });

  test('le passage d’un mois à l’autre est correct', () => {
    const points = new Map([['2026-08-31', true]]);
    assert.equal(journeeDisponible('2026-08-31', points), '2026-09-01');
  });

  test('la recherche ne boucle pas indéfiniment', () => {
    // Tous validés : la fonction doit rendre la main plutôt que tourner.
    const points = new Map(
      Array.from({ length: 40 }, (_, i) => [`2026-08-${String(i + 1).padStart(2, '0')}`, true] as const),
    );
    const j = journeeDisponible('2026-08-01', points);
    assert.ok(j, 'une journée doit être renvoyée');
  });
});

describe('construireShift — identité et idempotence', () => {

  test('la ligne porte l’id du service POS comme clé d’idempotence', () => {
    assert.equal(construireShift(SERVICE, DEPENSES, CTX).pos_service_id, 'svc-1');
  });

  test('la ligne est rattachée au restaurant et au point Samtrackly', () => {
    const s = construireShift(SERVICE, DEPENSES, CTX);
    assert.equal(s.restaurant_id, 'resto-st');
    assert.equal(s.point_id, 'point-st');
    assert.equal(s.caissier_id, 'user-st');
    assert.equal(s.caissier_nom, 'Flora');
  });

  test('les heures sont au format attendu par Samtrackly', () => {
    const s = construireShift(SERVICE, DEPENSES, CTX);
    assert.equal(s.heure_debut, '16:00');
    assert.equal(s.heure_fin, '01:30');
  });

  test('le shift arrive validé, sans photo', () => {
    const s = construireShift(SERVICE, DEPENSES, CTX);
    assert.equal(s.valide, true);
    assert.ok(!('photo_kdo' in s), 'plus de justificatif photo : les montants viennent du système');
  });
});

describe('construireShift — robustesse', () => {

  test('un rapport Z incomplet ne produit pas de NaN', () => {
    const nu = { ...SERVICE, rapport_z: {} };
    const s = construireShift(nu, [], CTX);
    for (const [cle, val] of Object.entries(s)) {
      if (typeof val === 'number') assert.ok(Number.isFinite(val), `${cle} vaut ${val}`);
    }
  });

  test('les catégories sont celles du POS, sans recouvrement', () => {
    for (const c of ACHATS) assert.ok(!SALAIRES.includes(c), `${c} des deux côtés`);
    assert.deepEqual([...ACHATS].sort(), ['ANNEXES', 'FRUITS', 'LEGUMES', 'MARCHE']);
    assert.deepEqual([...SALAIRES].sort(), ['ENCOURAGEMENTS', 'SALAIRES']);
  });
});

describe('totalVentePoint — le cache affiché aux managers', () => {
  // points.vente_total est lu par dashboard.js, rapports.js, rapportMensuel.js,
  // rapportHebdo.js et verification.js (les déductions du vérificateur). Le
  // pont crée le point mais n'écrivait pas ce total : les journées transférées
  // affichaient 0 F partout ailleurs, malgré des shifts bien réels dessous.
  // Trouvé en production le 2026-08-18 : deux journées à 194 000 F de ventes
  // réelles affichaient 0 sur points.vente_total.

  test('somme les ventes de tous les shifts du point', () => {
    const shifts = [{ vente_shift: 42_000 }, { vente_shift: 33_000 }, { vente_shift: 68_000 }];
    assert.equal(totalVentePoint(shifts), 143_000);
  });

  test('un point sans shift vaut 0, pas une erreur', () => {
    assert.equal(totalVentePoint([]), 0);
  });

  test('un montant manquant compte pour 0, pas pour NaN', () => {
    const shifts = [{ vente_shift: 42_000 }, { vente_shift: null }, { vente_shift: undefined }];
    assert.equal(totalVentePoint(shifts), 42_000);
  });

  test('une liste absente ne fait pas tomber l’appelant', () => {
    assert.equal(totalVentePoint(null), 0);
    assert.equal(totalVentePoint(undefined), 0);
  });
});


describe('totalVenteMachinePoint — la vente machine du point', () => {
  // points.vente_machine était tapée à la main par le gérant. Le 19 et le 20
  // août, personne ne l'a fait : l'écart théorique/machine a disparu en
  // silence sur un site pourtant basculé. Le POS connaît ce chiffre
  // exactement — il n'y a aucune raison de le faire retaper.

  test('somme les ventes système de tous les shifts du point', () => {
    const shifts = [{ vente_systeme_pos: 152_000 }, { vente_systeme_pos: 135_000 }];
    assert.equal(totalVenteMachinePoint(shifts), 287_000);
  });

  test('un shift saisi à la main (sans vente système) compte pour 0', () => {
    // Jour de bascule : des shifts manuels côtoient des shifts du POS.
    const shifts = [{ vente_systeme_pos: 152_000 }, { vente_systeme_pos: null }];
    assert.equal(totalVenteMachinePoint(shifts), 152_000);
  });

  test('un point sans aucun shift POS vaut 0, jamais NaN', () => {
    assert.equal(totalVenteMachinePoint([]), 0);
    assert.equal(totalVenteMachinePoint(null), 0);
    assert.equal(totalVenteMachinePoint(undefined), 0);
  });
});


describe('journeePourTransfert — un rejeu ne déplace JAMAIS un shift de jour', () => {
  // INCIDENT DU 2026-08-20, en production.
  // Le gérant avait validé les points du 17 et du 18. Un rejeu (pour appliquer
  // une nouvelle formule) a fait repasser ces shifts par la règle « un point
  // validé ne se rouvre pas, va au jour suivant » : les 6 shifts du 17 et du 18
  // ont atterri sur le 19. De l'argent a changé de journée.
  //
  // La règle du boss reste vraie pour un shift QUI ARRIVE POUR LA PREMIÈRE
  // FOIS. Elle ne doit jamais s'appliquer à un shift déjà placé : celui-là
  // retourne exactement là où il était, validé ou non.

  const VALIDES = new Map([['2026-08-17', true], ['2026-08-18', true], ['2026-08-19', false]]);

  test('un nouveau shift sur un jour validé va au jour suivant (règle inchangée)', () => {
    assert.equal(journeePourTransfert('2026-08-17', VALIDES, false), '2026-08-19');
  });

  test('un shift DÉJÀ transféré retourne sur sa vraie journée, même validée', () => {
    // C'est le correctif : le rejeu ne relocalise plus.
    assert.equal(journeePourTransfert('2026-08-17', VALIDES, true), '2026-08-17');
    assert.equal(journeePourTransfert('2026-08-18', VALIDES, true), '2026-08-18');
  });

  test('un nouveau shift sur un jour ouvert reste sur ce jour', () => {
    assert.equal(journeePourTransfert('2026-08-19', VALIDES, false), '2026-08-19');
  });

  test('un rejeu sur un jour ouvert reste aussi sur ce jour', () => {
    assert.equal(journeePourTransfert('2026-08-19', VALIDES, true), '2026-08-19');
  });

  test('sans aucun point connu, la journée demandée est conservée dans les deux cas', () => {
    assert.equal(journeePourTransfert('2026-08-21', new Map(), false), '2026-08-21');
    assert.equal(journeePourTransfert('2026-08-21', new Map(), true), '2026-08-21');
  });
});


describe('aDejaEtePlace — reconnaître un service déjà posé sur une journée', () => {
  // DEUXIÈME ERREUR DU 2026-08-20, après la première.
  // Mon correctif détectait « déjà transféré » avec `transfere_le IS NOT NULL`.
  // Or `rejouer_transferts()` vide justement cette colonne AVANT que la
  // fonction ne tourne : au démarrage, tous les services paraissaient neufs et
  // ont été relocalisés une seconde fois. Le marqueur doit survivre au rejeu.
  //
  // `journee` et `point_id` sont préservés par le rejeu : ce sont eux qui
  // disent qu'un service a déjà atterri quelque part.

  test('un service jamais transféré n’a pas de journée', () => {
    assert.equal(aDejaEtePlace({ journee: null, point_id: null, transfere_le: null }), false);
    assert.equal(aDejaEtePlace(undefined), false);
    assert.equal(aDejaEtePlace(null), false);
  });

  test('un service transféré puis REJOUÉ reste reconnu comme déjà placé', () => {
    // C'est le cas qui a échoué : transfere_le remis à NULL par le rejeu,
    // mais journee et point_id toujours là.
    assert.equal(
      aDejaEtePlace({ journee: '2026-08-17', point_id: 'p1', transfere_le: null }),
      true,
    );
  });

  test('un service transféré et non rejoué est évidemment déjà placé', () => {
    assert.equal(
      aDejaEtePlace({ journee: '2026-08-17', point_id: 'p1', transfere_le: '2026-08-20T12:00:00Z' }),
      true,
    );
  });

  test('un point_id seul suffit, même sans journée', () => {
    assert.equal(aDejaEtePlace({ journee: null, point_id: 'p1', transfere_le: null }), true);
  });

  test('un service en échec permanent, jamais abouti, reste neuf', () => {
    // tentatives > 0 mais rien n'a jamais été écrit : il n'a pas de place.
    assert.equal(
      aDejaEtePlace({ journee: null, point_id: null, transfere_le: null, tentatives: 5 }),
      false,
    );
  });
});
