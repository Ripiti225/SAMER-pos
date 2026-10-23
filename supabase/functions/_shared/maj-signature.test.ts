import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { empreinteCle, ErreurCle, octetsClePublique, verifierAvecTrousseau, verifierEd25519 } from './maj-signature.ts';

// Les clés et signatures viennent du lot L0 (apps/desktop/maj), celui qui
// signe sur le poste de publication et vérifie dans le lanceur : on prouve
// ainsi que la vérification WebCrypto du cloud dit la même chose que lui.
const require = createRequire(import.meta.url);
const l0 = require('../../../apps/desktop/maj/index.cjs');

const paire = l0.genererPaire();
const autre = l0.genererPaire();
const brute: string = l0.clePubliqueBrute(paire.clePublique);
const pem: string = paire.clePublique.export({ format: 'pem', type: 'spki' }).toString();
const octets = new TextEncoder().encode('{"format":1,"type":"APP"}\n');
const signature: string = l0.signer(octets, paire.clePrivee);

describe('clé publique', () => {
  test('forme courte et PEM donnent les mêmes 32 octets', () => {
    assert.deepEqual(octetsClePublique(brute), octetsClePublique(pem));
    assert.equal(octetsClePublique(brute).length, 32);
  });

  test('clé absente, tronquée ou d’un autre type : refusée', () => {
    assert.throws(() => octetsClePublique(''), ErreurCle);
    assert.throws(() => octetsClePublique('abcd'), ErreurCle);
    const rsa = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'pem', type: 'spki' });
    assert.throws(() => octetsClePublique(String(rsa)), ErreurCle);
  });

  test('empreinte identique à celle du lot L0', async () => {
    assert.equal(await empreinteCle(octetsClePublique(brute)), l0.empreinteCle(brute));
  });
});

describe('vérification Ed25519 (WebCrypto)', () => {
  test('signature du lot L0 acceptée', async () => {
    assert.equal(await verifierEd25519(octets, signature, octetsClePublique(brute)), true);
  });

  test('un octet changé, une autre clé, une signature abîmée : refusé sans lever', async () => {
    const modifie = new Uint8Array(octets);
    modifie[3] ^= 1;
    assert.equal(await verifierEd25519(modifie, signature, octetsClePublique(brute)), false);
    assert.equal(await verifierEd25519(octets, signature, octetsClePublique(l0.clePubliqueBrute(autre.clePublique))), false);
    assert.equal(await verifierEd25519(octets, 'pas-du-base64!', octetsClePublique(brute)), false);
    assert.equal(await verifierEd25519(octets, signature.slice(8), octetsClePublique(brute)), false);
  });

  test('trousseau : actuelle, puis suivante pendant une rotation', async () => {
    const r1 = await verifierAvecTrousseau(octets, signature, { actuelle: brute });
    assert.equal(r1?.cle, 'actuelle');
    assert.equal(r1?.empreinte, l0.empreinteCle(brute));
    const r2 = await verifierAvecTrousseau(octets, signature, { actuelle: l0.clePubliqueBrute(autre.clePublique), suivante: pem });
    assert.equal(r2?.cle, 'suivante');
    assert.equal(await verifierAvecTrousseau(octets, signature, { actuelle: l0.clePubliqueBrute(autre.clePublique) }), null);
  });

  test('secret non configuré : erreur, jamais une acceptation', async () => {
    await assert.rejects(verifierAvecTrousseau(octets, signature, { actuelle: '' }), ErreurCle);
  });
});
