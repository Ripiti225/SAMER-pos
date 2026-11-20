// Polices de l'autocollant (maquette validée), servies par la console et
// incorporées dans le PDF. Chargées seulement quand on fabrique une planche.
import archivo from '@fontsource/archivo-black/files/archivo-black-latin-400-normal.woff?url';
import inter500 from '@fontsource/inter/files/inter-latin-500-normal.woff?url';
import inter600 from '@fontsource/inter/files/inter-latin-600-normal.woff?url';
import inter700 from '@fontsource/inter/files/inter-latin-700-normal.woff?url';
import inter800 from '@fontsource/inter/files/inter-latin-800-normal.woff?url';
import mono from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff?url';
import kaushan from '@fontsource/kaushan-script/files/kaushan-script-latin-400-normal.woff?url';
import type { Polices } from './pdf';

async function lire(url: string): Promise<Uint8Array> {
  const reponse = await fetch(url);
  if (!reponse.ok) throw new Error('Police introuvable : la planche ne peut pas être fabriquée');
  return new Uint8Array(await reponse.arrayBuffer());
}

export async function chargerPolices(): Promise<Polices> {
  const [a, i5, i6, i7, i8, m, k] = await Promise.all([archivo, inter500, inter600, inter700, inter800, mono, kaushan].map(lire));
  return { archivo: a!, inter500: i5!, inter600: i6!, inter700: i7!, inter800: i8!, mono: m!, kaushan: k! };
}
