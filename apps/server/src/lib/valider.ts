import type { z } from 'zod';
import { ErreurMetier } from './erreurs.js';

/** Valide un corps de requête avec Zod ; en cas d'échec, message FR du schéma. */
export function valider<S extends z.ZodTypeAny>(schema: S, donnees: unknown): z.infer<S> {
  const resultat = schema.safeParse(donnees);
  if (!resultat.success) {
    const premier = resultat.error.issues[0];
    let message = premier?.message ?? 'Données invalides';
    // Jamais de message technique anglais de Zod côté caisse (§15)
    if (message === 'Required') {
      message = premier?.path.length
        ? `Le champ « ${premier.path.join('.')} » est obligatoire`
        : 'Un champ obligatoire est manquant';
    }
    throw new ErreurMetier(message, 400);
  }
  return resultat.data;
}
