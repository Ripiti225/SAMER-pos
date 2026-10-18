import type { ModeSonnerie } from '@pos/shared';

/** Commandes bornées : aucune impulsion tiroir, aucun réglage permanent. */
export function commandeSonnerie(mode: ModeSonnerie): Buffer {
  switch (mode) {
    case 'aucun': return Buffer.alloc(0);
    // EC/GP-80XXX Programmer Manual, ESC B et ESC C : deux répétitions.
    case 'esc_b': return Buffer.from([0x1b, 0x42, 2, 3]);
    case 'esc_c': return Buffer.from([0x1b, 0x43, 2, 3, 1]);
    // Epson ESC ( A fonction 97 : motif 100, deux répétitions, 300 ms on/off.
    case 'epson': return Buffer.from([0x1b, 0x28, 0x41, 5, 0, 97, 100, 2, 3, 3]);
    case 'epson_externe': return Buffer.from([0x1b, 0x28, 0x41, 3, 0, 97, 1, 2]);
  }
}
