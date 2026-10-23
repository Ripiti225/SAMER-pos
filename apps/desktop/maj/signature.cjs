'use strict';
// Signature Ed25519 des manifestes, avec `node:crypto` seul (aucune
// dépendance : ce module est embarqué dans l'asar de PosSamer.exe).
//
// On signe les OCTETS EXACTS de manifeste.json, jamais un objet re-sérialisé :
// deux JSON « équivalents » n'ont pas forcément les mêmes octets, et vérifier
// autre chose que ce qui a été signé ouvrirait une porte.
//
// Rotation : le lanceur embarque deux clés publiques, « actuelle » et
// « suivante ». Un paquet signé par l'une OU l'autre est accepté. Pour
// changer de clé : (1) publier un lanceur qui porte la nouvelle clé en
// « suivante » ; (2) une fois tous les sites passés sur ce lanceur, signer
// avec la nouvelle clé ; (3) le lanceur suivant la remonte en « actuelle ».
// À aucun moment un site ne se retrouve incapable de vérifier un paquet.
const crypto = require('node:crypto');
const { ErreurMaj } = require('./erreurs.cjs');

// En-tête DER SubjectPublicKeyInfo d'une clé Ed25519 (OID 1.3.101.112) :
// suivi des 32 octets bruts de la clé, il forme une clé SPKI complète.
const PREFIXE_SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Accepte une clé publique sous forme PEM (SPKI) ou base64 des 32 octets
 * bruts (forme courte, pratique à embarquer dans le lanceur).
 */
function chargerClePublique(texte) {
  if (texte && typeof texte === 'object' && texte.type === 'public') return verifierEd25519(texte);
  if (typeof texte !== 'string' || !texte.trim()) {
    throw new ErreurMaj('CLE_INVALIDE', 'Clé publique de mise à jour absente.');
  }
  const t = texte.trim();
  let cle;
  try {
    if (t.startsWith('-----BEGIN')) {
      cle = crypto.createPublicKey(t);
    } else {
      const brut = Buffer.from(t, 'base64');
      if (brut.length !== 32) throw new Error('longueur');
      cle = crypto.createPublicKey({ key: Buffer.concat([PREFIXE_SPKI_ED25519, brut]), format: 'der', type: 'spki' });
    }
  } catch {
    throw new ErreurMaj('CLE_INVALIDE', 'Clé publique de mise à jour illisible.');
  }
  return verifierEd25519(cle);
}

function verifierEd25519(cle) {
  if (cle.asymmetricKeyType !== 'ed25519') {
    throw new ErreurMaj('CLE_INVALIDE', 'La clé de mise à jour doit être une clé Ed25519.');
  }
  return cle;
}

/** Les 32 octets bruts d'une clé publique, en base64 (forme à embarquer). */
function clePubliqueBrute(cle) {
  const der = chargerClePublique(cle).export({ format: 'der', type: 'spki' });
  return der.subarray(PREFIXE_SPKI_ED25519.length).toString('base64');
}

/** Empreinte courte d'une clé publique (16 hex), pour les journaux et le siège. */
function empreinteCle(cle) {
  const brut = Buffer.from(clePubliqueBrute(cle), 'base64');
  return crypto.createHash('sha256').update(brut).digest('hex').slice(0, 16);
}

/**
 * Paire Ed25519. Avec `phrase`, la clé privée sort en PKCS#8 PEM chiffrée
 * (AES-256-CBC, dérivation scrypt d'OpenSSL) ; sans phrase, elle n'est
 * renvoyée qu'en objet KeyObject — réservé aux tests (clés jetables).
 */
function genererPaire({ phrase } = {}) {
  if (phrase !== undefined) {
    if (typeof phrase !== 'string' || phrase.length < 12) {
      throw new ErreurMaj('PHRASE_TROP_COURTE', 'La phrase de passe doit faire au moins 12 caractères.');
    }
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: phrase },
    });
    return { clePubliquePem: publicKey, clePriveePemChiffree: privateKey };
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { clePublique: publicKey, clePrivee: privateKey };
}

/**
 * Signe des octets. `clePrivee` : KeyObject, ou PEM chiffré + `phrase`.
 * Renvoie la signature (64 octets) en base64 : c'est le contenu du fichier
 * `manifeste.json.sig`.
 */
function signer(octets, clePrivee, phrase) {
  let cle;
  try {
    cle = typeof clePrivee === 'string' ? crypto.createPrivateKey({ key: clePrivee, passphrase: phrase }) : clePrivee;
  } catch {
    throw new ErreurMaj('CLE_PRIVEE_ILLISIBLE', 'Clé privée illisible ou phrase de passe incorrecte.');
  }
  if (!cle || cle.asymmetricKeyType !== 'ed25519') {
    throw new ErreurMaj('CLE_INVALIDE', 'La clé de signature doit être une clé Ed25519.');
  }
  return crypto.sign(null, Buffer.from(octets), cle).toString('base64');
}

/** Vrai si `signatureB64` signe exactement `octets` avec `clePublique`. Ne lève jamais sur une signature mal formée. */
function verifier(octets, signatureB64, clePublique) {
  const cle = chargerClePublique(clePublique);
  if (typeof signatureB64 !== 'string') return false;
  const sig = Buffer.from(signatureB64.trim(), 'base64');
  // Le décodage base64 de Node ignore les caractères invalides : on exige
  // donc la longueur exacte d'une signature Ed25519.
  if (sig.length !== 64) return false;
  try {
    return crypto.verify(null, Buffer.from(octets), cle, sig);
  } catch {
    return false;
  }
}

/**
 * Vérifie contre le trousseau du lanceur `{ actuelle, suivante }`.
 * Renvoie 'actuelle' | 'suivante' (la clé qui a signé) ou null.
 */
function verifierAvecTrousseau(octets, signatureB64, trousseau) {
  if (!trousseau || !trousseau.actuelle) {
    throw new ErreurMaj('CLE_INVALIDE', 'Aucune clé publique de mise à jour n’est configurée.');
  }
  if (verifier(octets, signatureB64, trousseau.actuelle)) return 'actuelle';
  if (trousseau.suivante && verifier(octets, signatureB64, trousseau.suivante)) return 'suivante';
  return null;
}

module.exports = {
  chargerClePublique,
  clePubliqueBrute,
  empreinteCle,
  genererPaire,
  signer,
  verifier,
  verifierAvecTrousseau,
};
