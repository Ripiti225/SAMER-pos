/** Erreur métier : message en français courant, montré tel quel à l'utilisateur. */
export class ErreurMetier extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'ErreurMetier';
  }
}

export function introuvable(quoi: string): ErreurMetier {
  return new ErreurMetier(`${quoi} introuvable`, 404);
}
