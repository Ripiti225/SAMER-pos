'use strict';
// Test du script scripts/maj/generer-cle.mjs : la clé est générée dans un
// dossier temporaire, avec une phrase de passe jetable passée par un tube.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { signer, verifier, empreinteCle } = require('../index.cjs');
const { dossierTemp } = require('./aide.cjs');

const SCRIPT = path.resolve(__dirname, '..', '..', '..', '..', 'scripts', 'maj', 'generer-cle.mjs');
const lancer = (args, entree) => spawnSync(process.execPath, [SCRIPT, ...args], { input: entree, encoding: 'utf8' });

test('génère une clé privée chiffrée et imprime la clé publique', (t) => {
  const sortie = path.join(dossierTemp(t, 'cle'), 'usb-signature');
  const phrase = 'phrase de passe de test jetable';
  const r = lancer(['--sortie', sortie], `${phrase}\n${phrase}\n`);
  assert.equal(r.status, 0, r.stderr);
  const privee = fs.readFileSync(path.join(sortie, 'cle-signature-maj.pem'), 'utf8');
  assert.match(privee, /BEGIN ENCRYPTED PRIVATE KEY/);
  assert.doesNotMatch(privee, /BEGIN PRIVATE KEY/);
  assert.ok(!r.stdout.includes(phrase), 'la phrase n’est jamais affichée');
  const courte = /embarquer dans le lanceur : (\S+)/.exec(r.stdout)[1];
  assert.ok(r.stdout.includes(empreinteCle(courte)));
  assert.equal(verifier('paquet', signer('paquet', privee, phrase), courte), true);

  // jamais d'écrasement d'une clé existante
  const encore = lancer(['--sortie', sortie], `${phrase}\n${phrase}\n`);
  assert.notEqual(encore.status, 0);
  assert.equal(fs.readFileSync(path.join(sortie, 'cle-signature-maj.pem'), 'utf8'), privee);
});

test('refuse d’écrire dans le dépôt (public)', () => {
  const dansDepot = path.resolve(__dirname, 'ne-doit-pas-exister');
  const r = lancer(['--sortie', dansDepot], 'phrase assez longue 1\nphrase assez longue 1\n');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /PUBLIC/);
  assert.equal(fs.existsSync(dansDepot), false);
});

test('refuse une phrase trop courte ou mal confirmée', (t) => {
  const d = dossierTemp(t, 'cle');
  assert.notEqual(lancer(['--sortie', d], 'court\ncourt\n').status, 0);
  assert.notEqual(lancer(['--sortie', d], 'phrase assez longue A\nphrase assez longue B\n').status, 0);
  assert.equal(fs.existsSync(path.join(d, 'cle-signature-maj.pem')), false);
  assert.notEqual(lancer([], '').status, 0);
});
