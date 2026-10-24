#!/usr/bin/env node
// Génère la paire de clés Ed25519 qui signe les paquets de mise à jour.
//
//   node scripts/maj/generer-cle.mjs --sortie E:\signature
//
// - La clé PRIVÉE est écrite en PKCS#8 PEM CHIFFRÉE par une phrase de passe
//   (AES-256-CBC) : elle n'existe jamais en clair, ni sur disque ni à l'écran.
//   Elle va sur la clé USB « signature », distincte de la clé master, gardée
//   par le propriétaire seul (décision du 23/10/2026).
// - Le script REFUSE d'écrire dans le dépôt : il est public.
// - La clé PUBLIQUE est imprimée (forme courte base64 à embarquer dans le
//   lanceur, et PEM) et écrite à côté, elle n'a rien de secret.
//
// Pour une rotation, générer la nouvelle paire, embarquer sa clé publique en
// « suivante » dans le lanceur, et ne signer avec elle qu'une fois tous les
// sites passés sur ce lanceur (voir apps/desktop/maj/signature.cjs).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { genererPaire, clePubliqueBrute, empreinteCle } = require('../../apps/desktop/maj/index.cjs');

const RACINE_DEPOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOM_PRIVEE = 'cle-signature-maj.pem';
const NOM_PUBLIQUE = 'cle-publique-maj.txt';

function quitter(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function argument(nom) {
  const i = process.argv.indexOf(nom);
  return i === -1 ? undefined : process.argv[i + 1];
}

function estDans(enfant, parent) {
  const rel = path.relative(parent.toLowerCase(), enfant.toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Lit deux lignes (phrase + confirmation). Au clavier, la saisie est masquée ;
 * depuis un tube (tests), les lignes sont lues telles quelles.
 */
async function lirePhrases() {
  if (!process.stdin.isTTY) {
    let texte = '';
    for await (const b of process.stdin) texte += b;
    const lignes = texte.split(/\r?\n/);
    return [lignes[0] ?? '', lignes[1] ?? ''];
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let masque = false;
  rl._writeToOutput = (s) => {
    if (!masque || s.includes('\n')) rl.output.write(masque ? '\n' : s);
  };
  const poser = (question) =>
    new Promise((resolve) => {
      masque = false;
      rl.output.write(question);
      masque = true;
      rl.question('', resolve);
    });
  const a = await poser('Phrase de passe (12 caractères minimum) : ');
  const b = await poser('Confirmez la phrase de passe : ');
  rl.close();
  return [a, b];
}

const sortie = argument('--sortie');
if (!sortie) quitter('Usage : node scripts/maj/generer-cle.mjs --sortie <dossier sur la clé USB « signature »>');
const dossier = path.resolve(sortie);
if (estDans(dossier, RACINE_DEPOT)) {
  quitter(`Refus : ${dossier} est dans le dépôt, qui est PUBLIC. Choisissez un dossier sur la clé USB « signature ».`);
}
const cheminPrivee = path.join(dossier, NOM_PRIVEE);
if (fs.existsSync(cheminPrivee)) quitter(`Refus : ${cheminPrivee} existe déjà (jamais d'écrasement d'une clé).`);

const [phrase, confirmation] = await lirePhrases();
if (phrase !== confirmation) quitter('Les deux phrases de passe sont différentes.');
if (phrase.length < 12) quitter('La phrase de passe doit faire au moins 12 caractères.');

const { clePubliquePem, clePriveePemChiffree } = genererPaire({ phrase });
if (!clePriveePemChiffree.includes('ENCRYPTED PRIVATE KEY')) quitter('Erreur interne : la clé privée ne serait pas chiffrée.');

// Racine d'une clé USB (`D:\`) : Windows refuse mkdir dessus (EPERM) même en
// récursif, alors qu'elle existe déjà.
if (!fs.existsSync(dossier)) fs.mkdirSync(dossier, { recursive: true });
fs.writeFileSync(cheminPrivee, clePriveePemChiffree, { flag: 'wx', mode: 0o600 });
const brute = clePubliqueBrute(clePubliquePem);
const empreinte = empreinteCle(clePubliquePem);
fs.writeFileSync(
  path.join(dossier, NOM_PUBLIQUE),
  `Clé publique de mise à jour POS-Samer\nEmpreinte : ${empreinte}\nForme courte (à embarquer) : ${brute}\n\n${clePubliquePem}`,
  { flag: 'wx' },
);

process.stdout.write(
  [
    '',
    `Clé privée chiffrée écrite dans : ${cheminPrivee}`,
    'Gardez la phrase de passe HORS de cette clé USB.',
    '',
    `Empreinte de la clé publique : ${empreinte}`,
    `Clé publique à embarquer dans le lanceur : ${brute}`,
    '',
    clePubliquePem,
  ].join('\n'),
);
