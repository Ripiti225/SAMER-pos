import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cibleAServir,
  cibleDuSite,
  estTableAbsente,
  lireRapport,
  numeroInstalle,
  numeroLanceur,
  reglagesContrat,
  reglagesDuSite,
  tronquerDetail,
  DETAIL_MAX_OCTETS,
  type VersionResumee,
} from './maj-cible.ts';

const v = (numero: number, statut: VersionResumee['statut'], extra: Partial<VersionResumee> = {}): VersionResumee => ({
  numero,
  version: `2026.10.${String(Math.floor((numero / 100) % 100)).padStart(2, '0')}-${numero % 100}`,
  statut,
  pilote_le: statut === 'PILOTE' || statut === 'GENERALE' ? '2026-10-24T10:00:00Z' : null,
  generale_le: statut === 'GENERALE' ? '2026-10-26T10:00:00Z' : null,
  ...extra,
});

const VERSIONS = [
  v(2026102301, 'GENERALE'),
  v(2026102401, 'GENERALE'),
  v(2026102501, 'PILOTE'),
  v(2026102601, 'BROUILLON'),
  v(2026102701, 'RETIREE'),
];

describe('réglages servis au site', () => {
  test('sans ligne : défauts 24h/24 à 06:00, anneau général', () => {
    const r = reglagesDuSite(null);
    assert.equal(r.type_site, 'H24');
    assert.equal(r.anneau, 'GENERAL');
    assert.deepEqual(reglagesContrat(r), {
      type_site: 'H24',
      heure_installation: '06:00',
      heure_filet: '05:00',
      pause: false,
      installer_maintenant: null,
      reessayer: null,
    });
  });

  test('ligne abîmée : chaque champ retombe sur son défaut', () => {
    const r = reglagesDuSite({ type_site: 'NUIT' as never, heure_installation: '25:00', anneau: 'X' as never, pause: 'oui' as never });
    assert.equal(r.type_site, 'H24');
    assert.equal(r.heure_installation, '06:00');
    assert.equal(r.anneau, 'GENERAL');
    assert.equal(r.pause, false);
  });

  test('le contrat ne divulgue ni l’anneau ni l’épinglage', () => {
    const r = reglagesDuSite({ type_site: 'FERME_LA_NUIT', anneau: 'PILOTE', version_epinglee: 5, installer_maintenant: 'j1' });
    const c = reglagesContrat(r);
    assert.deepEqual(Object.keys(c).sort(), ['heure_filet', 'heure_installation', 'installer_maintenant', 'pause', 'reessayer', 'type_site']);
    assert.equal(c.installer_maintenant, 'j1');
  });
});

describe('résolution de la cible', () => {
  test('anneau général : la plus haute GENERALE', () => {
    const c = cibleDuSite(VERSIONS, reglagesDuSite({ anneau: 'GENERAL' }));
    assert.equal(c?.numero, 2026102401);
    assert.equal(c?.raison, 'GENERALE');
    assert.equal(c?.disponible_le, '2026-10-26T10:00:00Z');
  });

  test('anneau pilote : la plus haute PILOTE ou GENERALE, jamais un brouillon ni une retirée', () => {
    const c = cibleDuSite(VERSIONS, reglagesDuSite({ anneau: 'PILOTE' }));
    assert.equal(c?.numero, 2026102501);
    assert.equal(c?.raison, 'PILOTE');
    assert.equal(c?.disponible_le, '2026-10-24T10:00:00Z');
  });

  test('épinglée : cette version-là, même plus ancienne que la générale', () => {
    const c = cibleDuSite(VERSIONS, reglagesDuSite({ version_epinglee: 2026102301, maj_le: '2026-10-27T08:00:00Z' }));
    assert.equal(c?.numero, 2026102301);
    assert.equal(c?.raison, 'EPINGLEE');
    assert.equal(c?.disponible_le, '2026-10-27T08:00:00Z');
  });

  test('épingle sur une version retirée ou un brouillon : ignorée', () => {
    assert.equal(cibleDuSite(VERSIONS, reglagesDuSite({ version_epinglee: 2026102701 }))?.numero, 2026102401);
    assert.equal(cibleDuSite(VERSIONS, reglagesDuSite({ version_epinglee: 2026102601 }))?.numero, 2026102401);
    assert.equal(cibleDuSite(VERSIONS, reglagesDuSite({ version_epinglee: 999 }))?.numero, 2026102401);
  });

  test('fichiers purgés : plus servable', () => {
    const vs = [v(1, 'GENERALE'), v(2, 'GENERALE', { fichiers_purges_le: '2026-10-30T00:00:00Z' })];
    assert.equal(cibleDuSite(vs, reglagesDuSite(null))?.numero, 1);
  });

  test('rien de publié : null', () => {
    assert.equal(cibleDuSite([], reglagesDuSite(null)), null);
    assert.equal(cibleDuSite([v(3, 'BROUILLON'), v(4, 'RETIREE')], reglagesDuSite({ anneau: 'PILOTE' })), null);
  });

  test('jamais de retour en arrière : null si le site a déjà ce numéro ou plus', () => {
    const c = cibleDuSite(VERSIONS, reglagesDuSite(null));
    assert.equal(cibleAServir(c, 0)?.numero, 2026102401);
    assert.equal(cibleAServir(c, 2026102301)?.numero, 2026102401);
    assert.equal(cibleAServir(c, 2026102401), null);
    assert.equal(cibleAServir(c, 2026102501), null);
    // Épinglé sur une version plus ancienne que l'installée : rien.
    const e = cibleDuSite(VERSIONS, reglagesDuSite({ version_epinglee: 2026102301 }));
    assert.equal(cibleAServir(e, 2026102401), null);
  });

  test('numéros BIGINT rendus en texte par PostgREST : comparés en nombre', () => {
    const vs = [{ ...v(9, 'GENERALE'), numero: '10' as unknown as number }, v(9, 'GENERALE')];
    assert.equal(cibleDuSite(vs, reglagesDuSite(null))?.numero, 10);
  });
});

describe('lecture de la requête du site', () => {
  test('numéro installé : 0 si absent ou abîmé', () => {
    assert.equal(numeroInstalle({ numero: 2026102301, version: '2026.10.23-1' }), 2026102301);
    assert.equal(numeroInstalle(undefined), 0);
    assert.equal(numeroInstalle({ numero: -1 }), 0);
    assert.equal(numeroInstalle({ numero: '12' }), 0);
  });

  test('numéro du lanceur', () => {
    assert.equal(numeroLanceur(3), 3);
    assert.equal(numeroLanceur('3'), null);
    assert.equal(numeroLanceur(1.5), null);
  });
});

describe('comptes rendus', () => {
  test('événement du contrat accepté', () => {
    const r = lireRapport({ numero: 2026102401, evenement: 'INSTALLE', detail: { duree_s: 140 } });
    assert.deepEqual(r, { numero: 2026102401, evenement: 'INSTALLE', detail: { duree_s: 140 } });
  });

  test('événement inconnu ou numéro abîmé : refusé', () => {
    assert.ok('erreur' in lireRapport({ evenement: 'FINI' }));
    assert.ok('erreur' in lireRapport({ evenement: 'INSTALLE', numero: 'x' }));
  });

  test('numéro absent toléré (BLOQUE avant toute version)', () => {
    const r = lireRapport({ evenement: 'BLOQUE' });
    assert.ok(!('erreur' in r));
    assert.equal(r.numero, null);
    assert.deepEqual(r.detail, {});
  });

  test('détail au-delà de 8 Ko : extrait tronqué', () => {
    const d = tronquerDetail({ stderr: 'é'.repeat(20_000) });
    assert.equal(d.tronque, true);
    assert.ok(new TextEncoder().encode(JSON.stringify(d)).length <= DETAIL_MAX_OCTETS);
    assert.deepEqual(tronquerDetail({ a: 1 }), { a: 1 });
    assert.deepEqual(tronquerDetail('texte'), { valeur: 'texte' });
  });
});

describe('migration absente', () => {
  test('reconnaît les erreurs PostgREST de table ou colonne manquante', () => {
    assert.equal(estTableAbsente({ code: '42P01', message: 'relation "maj_versions" does not exist' }), true);
    assert.equal(estTableAbsente({ code: 'PGRST205', message: 'Could not find the table in the schema cache' }), true);
    assert.equal(estTableAbsente({ code: '08006', message: 'connection failure' }), false);
    assert.equal(estTableAbsente(null), false);
  });
});
