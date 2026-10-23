'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  genererPaire,
  signer,
  verifier,
  verifierAvecTrousseau,
  chargerClePublique,
  clePubliqueBrute,
  empreinteCle,
  ouvrirManifesteSigne,
  serialiserManifeste,
} = require('../index.cjs');
const { manifesteApp } = require('./aide.cjs');

// Toutes les clés sont jetables, générées pour le test : AUCUNE vraie clé dans le dépôt.

test('signer puis vérifier les octets exacts', () => {
  const { clePublique, clePrivee } = genererPaire();
  const octets = Buffer.from('{"numero":42}\n');
  const sig = signer(octets, clePrivee);
  assert.equal(Buffer.from(sig, 'base64').length, 64);
  assert.equal(verifier(octets, sig, clePublique), true);
});

test('signature falsifiée : refusée sans lever', () => {
  const { clePublique, clePrivee } = genererPaire();
  const octets = Buffer.from('contenu');
  const sig = Buffer.from(signer(octets, clePrivee), 'base64');
  sig[10] ^= 0x01;
  assert.equal(verifier(octets, sig.toString('base64'), clePublique), false);
  assert.equal(verifier(octets, 'pas-du-base64!!', clePublique), false);
  assert.equal(verifier(octets, '', clePublique), false);
  assert.equal(verifier(octets, undefined, clePublique), false);
  // signature tronquée
  assert.equal(verifier(octets, sig.subarray(0, 63).toString('base64'), clePublique), false);
});

test('manifeste modifié d’un seul octet : signature invalide', () => {
  const { clePublique, clePrivee } = genererPaire();
  const octets = serialiserManifeste(manifesteApp());
  const sig = signer(octets, clePrivee);
  assert.ok(ouvrirManifesteSigne(octets, sig, { actuelle: clePublique }));
  for (const position of [0, Math.floor(octets.length / 2), octets.length - 1]) {
    const altere = Buffer.from(octets);
    altere[position] ^= 0x01;
    assert.throws(() => ouvrirManifesteSigne(altere, sig, { actuelle: clePublique }), { code: 'SIGNATURE_INVALIDE' });
  }
  // même un JSON « équivalent » mais ré-indenté est refusé : on signe des octets, pas un objet
  const reindente = Buffer.from(JSON.stringify(JSON.parse(octets.toString())));
  assert.throws(() => ouvrirManifesteSigne(reindente, sig, { actuelle: clePublique }), { code: 'SIGNATURE_INVALIDE' });
});

test('le manifeste n’est validé qu’APRÈS la signature', () => {
  const { clePublique } = genererPaire();
  // JSON invalide + signature invalide : c'est la signature qui est signalée
  assert.throws(() => ouvrirManifesteSigne(Buffer.from('{pas du json'), 'AAAA', { actuelle: clePublique }), {
    code: 'SIGNATURE_INVALIDE',
  });
});

test('rotation : actuelle, suivante, inconnue', () => {
  const ancienne = genererPaire();
  const nouvelle = genererPaire();
  const etrangere = genererPaire();
  const octets = serialiserManifeste(manifesteApp());
  const trousseau = { actuelle: ancienne.clePublique, suivante: nouvelle.clePublique };

  assert.equal(verifierAvecTrousseau(octets, signer(octets, ancienne.clePrivee), trousseau), 'actuelle');
  assert.equal(verifierAvecTrousseau(octets, signer(octets, nouvelle.clePrivee), trousseau), 'suivante');
  assert.equal(verifierAvecTrousseau(octets, signer(octets, etrangere.clePrivee), trousseau), null);
  // sans « suivante », la nouvelle clé n'est pas encore acceptée
  assert.equal(verifierAvecTrousseau(octets, signer(octets, nouvelle.clePrivee), { actuelle: ancienne.clePublique }), null);
  // trousseau vide : erreur explicite, jamais un « accepté par défaut »
  assert.throws(() => verifierAvecTrousseau(octets, 'x', {}), { code: 'CLE_INVALIDE' });

  const { cle } = ouvrirManifesteSigne(octets, signer(octets, nouvelle.clePrivee), trousseau);
  assert.equal(cle, 'suivante');
});

test('clé publique : forme courte base64 et PEM sont équivalentes', () => {
  const { clePublique, clePrivee } = genererPaire();
  const pem = clePublique.export({ type: 'spki', format: 'pem' });
  const courte = clePubliqueBrute(clePublique);
  assert.equal(Buffer.from(courte, 'base64').length, 32);
  assert.equal(clePubliqueBrute(pem), courte);
  assert.equal(empreinteCle(courte), empreinteCle(pem));
  assert.match(empreinteCle(courte), /^[0-9a-f]{16}$/);
  const sig = signer('abc', clePrivee);
  assert.equal(verifier('abc', sig, courte), true);
  assert.equal(verifier('abc', sig, pem), true);
});

test('clé publique invalide ou d’un autre type : refusée', () => {
  assert.throws(() => chargerClePublique(''), { code: 'CLE_INVALIDE' });
  assert.throws(() => chargerClePublique('AAAA'), { code: 'CLE_INVALIDE' });
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey;
  assert.throws(() => chargerClePublique(rsa.export({ type: 'spki', format: 'pem' })), { code: 'CLE_INVALIDE' });
});

test('clé privée chiffrée par phrase de passe', () => {
  const phrase = 'une phrase de passe assez longue';
  const { clePubliquePem, clePriveePemChiffree } = genererPaire({ phrase });
  assert.match(clePriveePemChiffree, /BEGIN ENCRYPTED PRIVATE KEY/);
  assert.doesNotMatch(clePriveePemChiffree, /BEGIN PRIVATE KEY/);
  const sig = signer('octets', clePriveePemChiffree, phrase);
  assert.equal(verifier('octets', sig, clePubliquePem), true);
  assert.throws(() => signer('octets', clePriveePemChiffree, 'mauvaise phrase de passe'), { code: 'CLE_PRIVEE_ILLISIBLE' });
  assert.throws(() => signer('octets', clePriveePemChiffree), { code: 'CLE_PRIVEE_ILLISIBLE' });
  assert.throws(() => genererPaire({ phrase: 'court' }), { code: 'PHRASE_TROP_COURTE' });
});
