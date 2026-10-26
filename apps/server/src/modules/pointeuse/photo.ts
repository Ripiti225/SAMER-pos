/**
 * Photo d'un employé (celle de SamerTrackly) prête pour la pointeuse : JPEG
 * de 200 Ko au plus. Les photos sont sur Supabase Storage, qui sait les
 * redimensionner à la volée — on évite ainsi une bibliothèque d'image native
 * de plus sur la clé USB.
 */
import { TAILLE_MAX_PHOTO } from './isapi.js';

export type PhotoPointeuse = { jpeg: Buffer } | { raison: string };

/** URL publique Supabase Storage → URL de rendu redimensionné (JPEG, 600 px). */
export function urlRedimensionnee(url: string): string | null {
  const m = /^(https?:\/\/[^/]+)\/storage\/v1\/object\/public\/(.+?)(\?.*)?$/.exec(url);
  return m ? `${m[1]}/storage/v1/render/image/public/${m[2]}?width=600&quality=80&resize=contain` : null;
}

const estJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

async function telecharger(url: string): Promise<Buffer | null> {
  const rep = await fetch(url, {
    headers: { Accept: 'image/jpeg' },
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!rep?.ok) return null;
  return Buffer.from(await rep.arrayBuffer());
}

export async function photoPourPointeuse(url: string): Promise<PhotoPointeuse> {
  // D'abord la version réduite, sinon l'originale si elle convient déjà.
  const candidates = [urlRedimensionnee(url), url].filter((u): u is string => !!u);
  let vue = false;
  for (const u of candidates) {
    const image = await telecharger(u);
    if (!image) continue;
    vue = true;
    if (estJpeg(image) && image.length <= TAILLE_MAX_PHOTO) return { jpeg: image };
  }
  return { raison: vue ? 'photo trop lourde ou pas au format JPEG' : 'photo introuvable (pas d’internet ?)' };
}
