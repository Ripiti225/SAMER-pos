// Vérification Ed25519 côté cloud, par WebCrypto (Deno comme Node 22).
//
// Pourquoi le cloud vérifie, alors que seul le lanceur fait foi (contrat § 2) :
// pour refuser TÔT, à l'enregistrement, un paquet mal signé ou signé avec une
// autre clé — avant qu'il parte vers huit sites qui le refuseraient chacun de
// leur côté, en pleine nuit, avec un compte rendu SIGNATURE_INVALIDE. Ce n'est
// pas une barrière de sécurité : un cloud compromis pourrait sauter ce contrôle,
// et le lanceur refuserait quand même.
//
// La clé publique attendue est un SECRET DE FONCTION (`MAJ_CLE_PUBLIQUE`, et
// `MAJ_CLE_PUBLIQUE_SUIVANTE` pendant une rotation), jamais écrite dans le
// code : le dépôt est public, et surtout c'est au propriétaire de dire quelle
// clé est la bonne, pas à un commit.
//
// Formats acceptés : ceux du lot L0 (apps/desktop/maj/signature.cjs) — forme
// courte (base64 des 32 octets bruts) ou PEM SubjectPublicKeyInfo.

// En-tête DER SPKI d'une clé Ed25519 (OID 1.3.101.112), suivi des 32 octets.
const PREFIXE_SPKI_ED25519 = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
const RE_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export class ErreurCle extends Error {}

function base64VersOctets(texte: string): Uint8Array | null {
  const t = texte.replace(/\s+/g, '');
  if (!t || t.length % 4 !== 0 || !RE_BASE64.test(t)) return null;
  const binaire = atob(t);
  const octets = new Uint8Array(binaire.length);
  for (let i = 0; i < binaire.length; i++) octets[i] = binaire.charCodeAt(i);
  return octets;
}

/** Les 32 octets bruts d'une clé publique Ed25519 (forme courte ou PEM). Lève ErreurCle sinon. */
export function octetsClePublique(texte: string): Uint8Array {
  const t = String(texte ?? '').trim();
  if (!t) throw new ErreurCle('Clé publique de mise à jour absente');
  if (t.startsWith('-----BEGIN')) {
    const corps = t.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----/g, '');
    const der = base64VersOctets(corps);
    if (!der || der.length !== PREFIXE_SPKI_ED25519.length + 32 || !PREFIXE_SPKI_ED25519.every((o, i) => der[i] === o)) {
      throw new ErreurCle('La clé publique PEM n’est pas une clé Ed25519');
    }
    return der.slice(PREFIXE_SPKI_ED25519.length);
  }
  const brut = base64VersOctets(t);
  if (!brut || brut.length !== 32) throw new ErreurCle('Clé publique de mise à jour illisible (32 octets en base64 attendus)');
  return brut;
}

/** Empreinte courte (16 hex) — la même que `empreinteCle` du lot L0. */
export async function empreinteCle(brut: Uint8Array): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', brut as BufferSource));
  return [...h].map((o) => o.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/** Vrai si `signatureB64` signe exactement `octets`. Ne lève jamais sur une signature mal formée. */
export async function verifierEd25519(octets: Uint8Array, signatureB64: string, clePublique: Uint8Array): Promise<boolean> {
  const sig = typeof signatureB64 === 'string' ? base64VersOctets(signatureB64.trim()) : null;
  if (!sig || sig.length !== 64) return false;
  try {
    const cle = await crypto.subtle.importKey('raw', clePublique as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, cle, sig as BufferSource, octets as BufferSource);
  } catch {
    return false;
  }
}

export interface Trousseau {
  actuelle: string;
  suivante?: string | null;
}

/**
 * Vérifie contre le trousseau du cloud. Renvoie la clé qui a signé
 * (`{ cle: 'actuelle' | 'suivante', empreinte }`) ou null. Lève ErreurCle si
 * la clé ACTUELLE n'est pas configurée : refuser tout paquet vaut mieux que
 * d'en accepter un sans contrôle.
 */
export async function verifierAvecTrousseau(
  octets: Uint8Array,
  signatureB64: string,
  trousseau: Trousseau,
): Promise<{ cle: 'actuelle' | 'suivante'; empreinte: string } | null> {
  const actuelle = octetsClePublique(trousseau.actuelle);
  if (await verifierEd25519(octets, signatureB64, actuelle)) return { cle: 'actuelle', empreinte: await empreinteCle(actuelle) };
  if (trousseau.suivante && trousseau.suivante.trim()) {
    const suivante = octetsClePublique(trousseau.suivante);
    if (await verifierEd25519(octets, signatureB64, suivante)) return { cle: 'suivante', empreinte: await empreinteCle(suivante) };
  }
  return null;
}
