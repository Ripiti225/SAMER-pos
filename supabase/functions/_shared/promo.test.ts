// Tests de promo.ts — règles des codes promo cartes (brief § 3).
//
// Exécution locale : node --experimental-strip-types --test supabase/functions/_shared/promo.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codesUtilisablesParNumero,
  decisionActivation,
  finBlocage,
  lireFicheRestaurant,
  lireLignes,
  lireLot,
  masquerCode,
  normaliserCode,
  normaliserTelephone,
  refusActivation,
  refusUtilisation,
  remiseEstimee,
  type CodeLu,
  type LotLu,
} from './promo.ts';

const PALMERAIE = '11111111-1111-4111-8111-111111111111';
const ANGRE = '22222222-2222-4222-8222-222222222222';
const TEL = '+2250777303333';
const MIDI = new Date('2026-12-01T12:00:00Z');

const lot: LotLu = {
  pourcentage: 20,
  valide_du: '2026-11-20T00:00:00.000Z',
  valide_au: '2026-12-17T23:59:59.999Z',
  annule_le: null,
};
const code: CodeLu = { restaurant_id: PALMERAIE, id: 'c1', code: 'PAM-7K3QX', statut: 'DISPONIBLE', telephone: null };

test('un code se tape comme on veut, mais seul l’alphabet sans ambiguïté passe', () => {
  assert.equal(normaliserCode('PAM-7K3QX'), 'PAM-7K3QX');
  assert.equal(normaliserCode(' pam 7k3qx '), 'PAM-7K3QX');
  assert.equal(normaliserCode('PAM7K3QX'), 'PAM-7K3QX');
  assert.equal(normaliserCode('PAM-7K3Q0'), null, 'le zéro n’est pas dans l’alphabet');
  assert.equal(normaliserCode('PAL-7K3QX'), null, 'pas de L dans un préfixe');
  assert.equal(normaliserCode('PAM-7K3Q'), null);
  assert.equal(normaliserCode(42), null);
});

test('un numéro ivoirien est ramené à +225 et 10 chiffres', () => {
  for (const saisie of ['0777303333', '07 77 30 33 33', '+225 07 77 30 33 33', '002250777303333', '225-0777-303333']) {
    assert.equal(normaliserTelephone(saisie), TEL, saisie);
  }
  assert.equal(normaliserTelephone('77303333'), null, 'ancien format à 8 chiffres');
  assert.equal(normaliserTelephone('07773O3333'), null);
  assert.equal(normaliserTelephone(''), null);
});

test('le caissier et le site ne voient que le code masqué', () => {
  assert.equal(masquerCode('PAM-7K3QX'), 'PAM-•••QX');
});

test('R2/R3 : un code ne sert que dans son restaurant, pendant sa période', () => {
  assert.equal(refusUtilisation(code, lot, PALMERAIE, MIDI), null);
  assert.equal(refusUtilisation(code, lot, ANGRE, MIDI), 'WRONG_BRANCH');
  assert.equal(refusUtilisation(code, lot, PALMERAIE, new Date('2026-11-19T23:59:59Z')), 'NOT_STARTED');
  assert.equal(refusUtilisation(code, lot, PALMERAIE, new Date('2026-12-17T23:59:00Z')), null, 'dernier jour inclus');
  assert.equal(refusUtilisation(code, lot, PALMERAIE, new Date('2026-12-18T00:00:00Z')), 'EXPIRED');
});

test('R1 : un code utilisé, réservé ou annulé ne resservira pas', () => {
  assert.equal(refusUtilisation({ ...code, statut: 'UTILISE' }, lot, PALMERAIE, MIDI), 'ALREADY_USED');
  assert.equal(refusUtilisation({ ...code, statut: 'RESERVE' }, lot, PALMERAIE, MIDI), 'ALREADY_USED');
  assert.equal(refusUtilisation({ ...code, statut: 'ANNULE' }, lot, PALMERAIE, MIDI), 'INVALID');
  assert.equal(refusUtilisation(code, { ...lot, annule_le: '2026-11-25T10:00:00Z' }, PALMERAIE, MIDI), 'INVALID');
});

test('R11/R13 : un code se garde sur un seul numéro, avec consentement', () => {
  assert.deepEqual(decisionActivation(code, lot, TEL, true, MIDI), { deja: false });
  assert.deepEqual(decisionActivation(code, lot, TEL, false, MIDI), { motif: 'CONSENT_REQUIRED' });
  const garde = { ...code, telephone: TEL };
  assert.deepEqual(decisionActivation(garde, lot, TEL, false, MIDI), { deja: true }, 'le même numéro réactive sans effet');
  assert.deepEqual(decisionActivation(garde, lot, '+2250101010101', true, MIDI), { motif: 'ALREADY_CLAIMED' });
  assert.deepEqual(
    decisionActivation(code, lot, TEL, true, new Date('2026-11-19T09:00:00Z')),
    { deja: false },
    'on peut garder son code avant le début de validité',
  );
  assert.deepEqual(decisionActivation(code, lot, TEL, true, new Date('2026-12-18T09:00:00Z')), { motif: 'EXPIRED' });
  assert.deepEqual(decisionActivation({ ...code, statut: 'UTILISE' }, lot, TEL, true, MIDI), { motif: 'ALREADY_USED' });
});

test('la page d’activation sait si le code peut encore être gardé, quel que soit le numéro', () => {
  assert.equal(refusActivation(code, lot, MIDI), null);
  assert.equal(refusActivation({ ...code, telephone: TEL }, lot, MIDI), null, 'déjà gardé : la page le dit autrement');
  assert.equal(refusActivation({ ...code, statut: 'RESERVE' }, lot, MIDI), null);
  assert.equal(refusActivation({ ...code, statut: 'UTILISE' }, lot, MIDI), 'ALREADY_USED');
  assert.equal(refusActivation(code, { ...lot, annule_le: '2026-11-25T10:00:00Z' }, MIDI), 'INVALID');
  assert.equal(refusActivation(code, lot, new Date('2026-12-18T00:00:00Z')), 'EXPIRED');
});

test('R12 : par numéro, le code qui expire en premier passe d’abord, et seulement dans ce restaurant', () => {
  const tot = { code: { ...code, id: 'tot', telephone: TEL }, lot: { ...lot, valide_au: '2026-12-05T23:59:59.999Z' } };
  const tard = { code: { ...code, id: 'tard', telephone: TEL }, lot };
  const ailleurs = { code: { ...code, id: 'ailleurs', restaurant_id: ANGRE, telephone: TEL }, lot };
  const servi = { code: { ...code, id: 'servi', statut: 'UTILISE' as const, telephone: TEL }, lot };
  const choix = codesUtilisablesParNumero([tard, ailleurs, servi, tot], PALMERAIE, MIDI);
  assert.deepEqual(choix.map((c) => c.code.id), ['tot', 'tard']);
});

test('R5/R7 : la remise estimée ignore les lignes exclues (Chawarma), arrondie ligne par ligne', () => {
  assert.equal(remiseEstimee([{ montant: 3000, exclue: true }, { montant: 6500, exclue: false }], 20), 1300);
  assert.equal(remiseEstimee([{ montant: 2499, exclue: false }, { montant: 2499, exclue: false }], 20), 1000);
  assert.equal(remiseEstimee([{ montant: 3000, exclue: true }], 20), null);
  assert.equal(remiseEstimee([], 20), null);
});

test('les lignes du panier sont des montants entiers', () => {
  assert.deepEqual(lireLignes(undefined), {});
  assert.deepEqual(lireLignes([{ montant: 1500, exclue: false }]), { lignes: [{ montant: 1500, exclue: false }] });
  assert.ok(lireLignes([{ montant: 15.5, exclue: false }]).erreur);
  assert.ok(lireLignes([{ montant: -1, exclue: false }]).erreur);
  assert.ok(lireLignes([{ montant: 100 }]).erreur);
  assert.ok(lireLignes('panier').erreur);
});

test('10 codes faux dans l’heure bloquent l’IP une heure à compter du 10e', () => {
  const t0 = Date.parse('2026-12-01T10:00:00Z');
  const echecs = Array.from({ length: 10 }, (_, i) => new Date(t0 + (9 - i) * 60_000)); // 10:00 → 10:09
  assert.equal(finBlocage(echecs.slice(0, 9), new Date(t0 + 10 * 60_000)), null, '9 échecs ne bloquent pas');
  assert.deepEqual(finBlocage(echecs, new Date(t0 + 10 * 60_000)), new Date(t0 + 69 * 60_000));
  assert.equal(finBlocage(echecs, new Date(t0 + 69 * 60_000)), null, 'débloqué une heure après le 10e');
  const etales = echecs.map((d, i) => new Date(d.getTime() - i * 10 * 60_000));
  assert.equal(finBlocage(etales, new Date(t0 + 10 * 60_000)), null, '10 échecs étalés sur plus d’une heure');
});

test('un lot dure par défaut du lendemain pendant 28 jours, dernier jour inclus', () => {
  const creation = new Date('2026-11-19T17:30:00Z');
  const { valeur } = lireLot({ restaurant_id: PALMERAIE, libelle: ' Autocollants S47 ', quantite: 200 }, creation);
  assert.deepEqual(valeur, {
    restaurant_id: PALMERAIE,
    libelle: 'Autocollants S47',
    pourcentage: 20,
    quantite: 200,
    valide_du: '2026-11-20T00:00:00.000Z',
    valide_au: '2026-12-17T23:59:59.999Z',
  });
});

test('un lot mal rempli est refusé avec un message clair', () => {
  const ok = { restaurant_id: PALMERAIE, libelle: 'S47', quantite: 200, du: '2026-11-20', au: '2026-12-17' };
  const creation = new Date('2026-11-19T17:30:00Z');
  assert.ok(lireLot(ok, creation).valeur);
  assert.ok(lireLot({ ...ok, restaurant_id: 'palmeraie' }, creation).erreur);
  assert.ok(lireLot({ ...ok, libelle: '   ' }, creation).erreur);
  assert.ok(lireLot({ ...ok, quantite: 0 }, creation).erreur);
  assert.ok(lireLot({ ...ok, quantite: 2001 }, creation).erreur);
  assert.ok(lireLot({ ...ok, quantite: '200' }, creation).erreur);
  assert.ok(lireLot({ ...ok, pourcentage: 0 }, creation).erreur);
  assert.ok(lireLot({ ...ok, du: '2026-11-18' }, creation).erreur, 'début déjà passé');
  assert.ok(lireLot({ ...ok, au: '2026-11-19' }, creation).erreur, 'fin avant le début');
  assert.ok(lireLot({ ...ok, du: '2026-02-30' }, creation).erreur, 'date impossible');
  assert.ok(lireLot({ ...ok, au: '2028-01-01' }, creation).erreur, 'plus d’un an');
  assert.equal(lireLot({ ...ok, du: '2026-11-19' }, creation).valeur?.valide_du, '2026-11-19T00:00:00.000Z', 'aujourd’hui accepté');
});

test('la fiche promo d’un restaurant est normalisée, vide = effacé', () => {
  assert.deepEqual(
    lireFicheRestaurant({ telephone: '07 77 30 33 33', adresse: '  Riviera Palmeraie ', prefixe_promo: 'pam', slug_site: 'Palmeraie' }).valeur,
    { telephone: '+2250777303333', adresse: 'Riviera Palmeraie', prefixe_promo: 'PAM', slug_site: 'palmeraie' },
  );
  assert.deepEqual(lireFicheRestaurant({ telephone: '', adresse: null, prefixe_promo: ' ', slug_site: undefined }).valeur, {
    telephone: null, adresse: null, prefixe_promo: null, slug_site: null,
  });
});

test('une fiche mal remplie est refusée avec un message clair', () => {
  assert.ok(lireFicheRestaurant({ telephone: '77303333' }).erreur);
  assert.ok(lireFicheRestaurant({ prefixe_promo: 'PAL' }).erreur, 'pas de L');
  assert.ok(lireFicheRestaurant({ prefixe_promo: 'PA' }).erreur);
  assert.ok(lireFicheRestaurant({ slug_site: 'angre 7e' }).erreur);
  assert.ok(lireFicheRestaurant({ slug_site: '-angre' }).erreur);
  assert.ok(lireFicheRestaurant({ adresse: 'x'.repeat(161) }).erreur);
  assert.ok(lireFicheRestaurant({ telephone: 42 }).erreur);
});
