/**
 * Conversion d'un logo PNG en image raster ESC/POS (GS v 0), monochrome, pour
 * l'en-tête des tickets thermiques. Le logo est fourni avec un fond transparent
 * (Chez Samer / Al Kayan) : on encre là où le dessin est opaque. Le résultat est
 * mis en cache par marque (calcul une seule fois).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const LARGEUR_POINTS = 384; // multiple de 8 (48 octets/ligne), ~48 mm de large
const SEUIL_ALPHA = 100; // opacité minimale pour encrer un point

const cache = new Map<string, Buffer | null>();

function cheminLogo(marque: 'SAMER' | 'AL_KAYAN'): string {
  const fichier = marque === 'AL_KAYAN' ? 'logo-alkayan.png' : 'logo-samer.png';
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../assets', fichier);
}

/** Commande GS v 0 (impression raster) prête à insérer dans le flux ESC/POS. */
export function rasterLogo(marque: 'SAMER' | 'AL_KAYAN'): Buffer | null {
  if (cache.has(marque)) return cache.get(marque)!;
  let resultat: Buffer | null = null;
  try {
    const png = PNG.sync.read(readFileSync(cheminLogo(marque)));
    const { width: sw, height: sh, data } = png; // data = RGBA
    const tw = LARGEUR_POINTS;
    const echelle = tw / sw;
    const th = Math.max(1, Math.round(sh * echelle));
    const octetsParLigne = tw / 8;
    const raster = Buffer.alloc(octetsParLigne * th);

    for (let ty = 0; ty < th; ty++) {
      for (let tx = 0; tx < tw; tx++) {
        // Moyenne de l'opacité sur le bloc source correspondant (anti-crénelage).
        const x0 = Math.floor(tx / echelle), x1 = Math.max(x0 + 1, Math.floor((tx + 1) / echelle));
        const y0 = Math.floor(ty / echelle), y1 = Math.max(y0 + 1, Math.floor((ty + 1) / echelle));
        let somme = 0, n = 0;
        for (let y = y0; y < y1 && y < sh; y++) {
          for (let x = x0; x < x1 && x < sw; x++) {
            somme += data[(y * sw + x) * 4 + 3]!; // canal alpha
            n++;
          }
        }
        if (n > 0 && somme / n > SEUIL_ALPHA) {
          raster[ty * octetsParLigne + (tx >> 3)]! |= 0x80 >> (tx & 7);
        }
      }
    }

    const entete = Buffer.from([
      0x1d, 0x76, 0x30, 0x00,
      octetsParLigne & 0xff, (octetsParLigne >> 8) & 0xff,
      th & 0xff, (th >> 8) & 0xff,
    ]);
    resultat = Buffer.concat([entete, raster]);
  } catch (e) {
    console.error('Logo ticket indisponible :', (e as Error).message);
    resultat = null;
  }
  cache.set(marque, resultat);
  return resultat;
}
