/**
 * Selfie du pointage : le téléphone le réduit (≈ 640 px, JPEG) avant l'envoi.
 * Le serveur vérifie seulement que c'est bien un JPEG de taille raisonnable :
 * il n'a pas de bibliothèque d'image (rien de natif de plus sur la clé USB).
 */

/** Un selfie réduit pèse ~50 Ko ; au-delà de 400 Ko, le téléphone n'a pas réduit. */
export const TAILLE_MAX_SELFIE = 400 * 1024;
/** En dessous, ce n'est pas une vraie photo (image vide, écran noir). */
const TAILLE_MIN_SELFIE = 2 * 1024;

const PREFIXE_DATA_URL = /^data:image\/jpe?g;base64,/i;

/** « data:image/jpeg;base64,… » (ou base64 nu) → octets, sinon null. */
export function jpegDepuisDataUrl(texte: string): Buffer | null {
  const base64 = texte.replace(PREFIXE_DATA_URL, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) return null;
  const octets = Buffer.from(base64, 'base64');
  return octets.length > 0 ? octets : null;
}

export function estJpegValide(b: Buffer): boolean {
  if (b.length < TAILLE_MIN_SELFIE || b.length > TAILLE_MAX_SELFIE) return false;
  // Début (SOI) et fin (EOI) d'un JPEG.
  return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;
}
