// Tests de samtrackly-corrections.ts — conversion des corrections de stock
// initial. Le calcul d'argent est côté SamerTrackly : ici, on garantit surtout
// qu'une correction remplacée ne part jamais.
//
// Exécution locale : node --test supabase/functions/_shared/samtrackly-corrections.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { construireCorrectionsSamtrackly } from './samtrackly-corrections.ts';

const base = {
  id: 'c1',
  produit_code: 'po8',
  produit_nom: 'Total poulet',
  produit_prix: 8000,
  stock_reporte: '14',
  stock_apres: '12',
  explication: 'Recompté',
  statut: 'A_VALIDER',
  service_sortant_id: 's0',
  caissier_sortant_id: 'u0',
  saisi_par: 'u1',
  shift_intermediaire_debloque: false,
};

const ctx = {
  posServiceId: 's1',
  restaurantId: 'r1',
  caissierPlaceNom: 'Caissier B',
  noms: new Map<string, string | null>([['u0', 'Caissier A'], ['u1', 'Caissier B']]),
};

test('transmet une correction avec des nombres et les noms', () => {
  assert.deepEqual(construireCorrectionsSamtrackly([base], ctx), [{
    pos_correction_id: 'c1',
    restaurant_id: 'r1',
    pos_service_place_id: 's1',
    pos_service_sortant_id: 's0',
    produit_id: 'po8',
    produit_nom: 'Total poulet',
    prix: 8000,
    stock_reporte: 14,
    stock_corrige: 12,
    explication: 'Recompté',
    statut_pos: 'A_VALIDER',
    shift_intermediaire_debloque: false,
    caissier_place_nom: 'Caissier B',
    caissier_sortant_nom: 'Caissier A',
    saisi_par_nom: 'Caissier B',
  }]);
});

test('ne transmet jamais une correction remplacée', () => {
  assert.deepEqual(construireCorrectionsSamtrackly([{ ...base, statut: 'REMPLACEE' }], ctx), []);
});

test('sans sortant, le nom reste vide', () => {
  const [c] = construireCorrectionsSamtrackly([{ ...base, service_sortant_id: null, caissier_sortant_id: null, statut: 'SANS_LITIGE' }], ctx);
  assert.equal(c?.pos_service_sortant_id, null);
  assert.equal(c?.caissier_sortant_nom, null);
});
