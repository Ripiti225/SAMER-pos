import type { PosteImpression } from './constantes.js';

export const MODES_SONNERIE = ['aucun', 'esc_b', 'esc_c', 'epson', 'epson_externe'] as const;
export type ModeSonnerie = typeof MODES_SONNERIE[number];
export const LIBELLES_SONNERIE: Record<ModeSonnerie, string> = {
  aucun: 'Désactivée', esc_b: 'Mode 1 — bips courts',
  esc_c: 'Mode 2 — sonnerie cuisine', epson: 'Mode 3 — Epson interne',
  epson_externe: 'Mode 4 — Epson externe',
};
export function estModeSonnerie(v: unknown): v is ModeSonnerie {
  return typeof v === 'string' && (MODES_SONNERIE as readonly string[]).includes(v);
}
export function cleSonnerie(poste: PosteImpression): string {
  return `imprimante_sonnerie_${poste.toLowerCase()}`;
}
export function modeSonnerieEnregistre(v: unknown, queue: string, poste: PosteImpression): ModeSonnerie {
  if (!queue) return 'aucun';
  // Compatibilité avec le premier correctif ; un changement d'imprimante après
  // calibration impose un nouvel essai plutôt que de réutiliser son protocole.
  if (v === undefined) return poste === 'CUISINE' ? 'esc_b' : 'aucun';
  if (!v || typeof v !== 'object') return 'aucun';
  const config = v as { queue?: unknown; mode?: unknown };
  return config.queue === queue && estModeSonnerie(config.mode) ? config.mode : 'aucun';
}
