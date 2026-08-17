/**
 * Logo PNG → image monochrome pour l'en-tête des tickets thermiques. Le logo est
 * fourni avec un fond transparent (Chez Samer / Al Kayan) : on encre là où le
 * dessin est opaque.
 *
 * DEUX encodages, parce que toutes les imprimantes ne parlent pas le même
 * dialecte : une commande non reconnue n'est pas ignorée, son contenu est
 * imprimé comme du texte — d'où les pages de charabia avant les articles.
 * - `raster` (GS v 0) : commande moderne, compacte, comprise par les Epson TM
 *   et la plupart des clones.
 * - `bandes` (ESC * mode 33) : la vieille commande bit-image, découpée en
 *   tranches de 24 points. Bien plus verbeuse, mais c'est le dénominateur
 *   commun — notamment sur les imprimantes mobiles (Woosim…) qui n'ont jamais
 *   implémenté GS v 0.
 * Le mode se choisit dans Réglages → Imprimantes après comparaison sur papier
 * (le ticket de test imprime les deux, étiquetés).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const LARGEUR_POINTS = 384; // multiple de 8 (48 octets/ligne), ~48 mm de large
const SEUIL_ALPHA = 100; // opacité minimale pour encrer un point
/**
 * Hauteur maximale du logo, en points (~2 cm). Sans plafond, un PNG plus haut
 * que large monopolise le ticket (le logo Al Kayan sortait sur 460 lignes, soit
 * ~5,7 cm et 22 Ko d'un coup — de quoi saturer le tampon d'une imprimante
 * mobile). Au-delà, on réduit AUSSI la largeur pour garder les proportions.
 */
const HAUTEUR_MAX_POINTS = 160;

/** Modes d'encodage disponibles pour le logo. */
export const MODES_LOGO = ['aucun', 'raster', 'bandes'] as const;
export type ModeLogo = (typeof MODES_LOGO)[number];

export function estModeLogo(v: unknown): v is ModeLogo {
  return typeof v === 'string' && (MODES_LOGO as readonly string[]).includes(v);
}

export type Marque = 'SAMER' | 'AL_KAYAN';

/** Bitmap monochrome : 1 bit par point, `true` = encré. */
interface Bitmap {
  largeur: number;
  hauteur: number;
  points: Uint8Array; // 1 octet par point (0/1) — simple à indexer, taille négligeable
}

const cacheBitmap = new Map<Marque, Bitmap | null>();
const cacheEncode = new Map<string, Buffer | null>();

function cheminLogo(marque: Marque): string {
  const fichier = marque === 'AL_KAYAN' ? 'logo-alkayan.png' : 'logo-samer.png';
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../assets', fichier);
}

/** Charge le PNG et le réduit en bitmap monochrome (avec anti-crénelage). */
function bitmap(marque: Marque): Bitmap | null {
  if (cacheBitmap.has(marque)) return cacheBitmap.get(marque)!;
  let resultat: Bitmap | null = null;
  try {
    const png = PNG.sync.read(readFileSync(cheminLogo(marque)));
    const { width: sw, height: sh, data } = png; // data = RGBA

    // Largeur cible, rabotée si le logo est trop haut, puis arrondie à un
    // multiple de 8 (les deux encodages travaillent par octets de 8 points).
    let echelle = LARGEUR_POINTS / sw;
    if (sh * echelle > HAUTEUR_MAX_POINTS) echelle = HAUTEUR_MAX_POINTS / sh;
    const tw = Math.max(8, Math.floor((sw * echelle) / 8) * 8);
    echelle = tw / sw;
    const th = Math.max(1, Math.round(sh * echelle));

    const points = new Uint8Array(tw * th);
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
        if (n > 0 && somme / n > SEUIL_ALPHA) points[ty * tw + tx] = 1;
      }
    }
    resultat = { largeur: tw, hauteur: th, points };
  } catch (e) {
    console.error('Logo ticket indisponible :', (e as Error).message);
  }
  cacheBitmap.set(marque, resultat);
  return resultat;
}

/** GS v 0 : le bitmap en un seul bloc raster. */
function encoderRaster(b: Bitmap): Buffer {
  const octetsParLigne = b.largeur / 8;
  const raster = Buffer.alloc(octetsParLigne * b.hauteur);
  for (let y = 0; y < b.hauteur; y++) {
    for (let x = 0; x < b.largeur; x++) {
      if (b.points[y * b.largeur + x]) raster[y * octetsParLigne + (x >> 3)]! |= 0x80 >> (x & 7);
    }
  }
  const entete = Buffer.from([
    0x1d, 0x76, 0x30, 0x00,
    octetsParLigne & 0xff, (octetsParLigne >> 8) & 0xff,
    b.hauteur & 0xff, (b.hauteur >> 8) & 0xff,
  ]);
  return Buffer.concat([entete, raster]);
}

/**
 * ESC * mode 33 (24 points de haut, double densité) : une commande par bande de
 * 24 lignes, chaque colonne codée sur 3 octets, bande terminée par un saut de
 * ligne. On force l'interligne à 24 points (ESC 3 24) pour que les bandes se
 * collent, puis on rétablit le défaut (ESC 2).
 */
function encoderBandes(b: Bitmap): Buffer {
  const morceaux: Buffer[] = [Buffer.from([0x1b, 0x33, 24])]; // ESC 3 n : interligne 24 points
  for (let base = 0; base < b.hauteur; base += 24) {
    const colonnes = Buffer.alloc(b.largeur * 3);
    for (let x = 0; x < b.largeur; x++) {
      for (let bit = 0; bit < 24; bit++) {
        const y = base + bit;
        if (y < b.hauteur && b.points[y * b.largeur + x]) {
          colonnes[x * 3 + (bit >> 3)]! |= 0x80 >> (bit & 7);
        }
      }
    }
    morceaux.push(
      Buffer.from([0x1b, 0x2a, 33, b.largeur & 0xff, (b.largeur >> 8) & 0xff]),
      colonnes,
      Buffer.from([0x0a]),
    );
  }
  morceaux.push(Buffer.from([0x1b, 0x32])); // ESC 2 : interligne par défaut
  return Buffer.concat(morceaux);
}

/**
 * Logo prêt à insérer dans le flux ESC/POS, dans le mode demandé.
 * `aucun` (ou logo illisible) → null : l'en-tête saute simplement l'image.
 */
export function logoTicket(marque: Marque, mode: ModeLogo): Buffer | null {
  if (mode === 'aucun') return null;
  const cle = `${marque}:${mode}`;
  if (cacheEncode.has(cle)) return cacheEncode.get(cle)!;
  const b = bitmap(marque);
  const encode = b ? (mode === 'bandes' ? encoderBandes(b) : encoderRaster(b)) : null;
  cacheEncode.set(cle, encode);
  return encode;
}
