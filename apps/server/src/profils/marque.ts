/** Le nom vient de SamerTrackly, parfois sans accent. */
export function estALaBraise(nom: string): boolean {
  const normalise = nom.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /\ba[\s_-]*la[\s_-]+braise\b/i.test(normalise);
}

export function marqueRestaurant(nom: string): 'SAMER' | 'AL_KAYAN' | 'A_LA_BRAISE' {
  if (estALaBraise(nom)) return 'A_LA_BRAISE';
  return /al\s*kayan/i.test(nom) ? 'AL_KAYAN' : 'SAMER';
}
