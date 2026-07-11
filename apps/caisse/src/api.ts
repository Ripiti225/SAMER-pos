/** Client API : erreurs toujours en français courant (renvoyées par le serveur). */
export class ErreurApi extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

// Session invalide côté serveur (redémarrage, expiration) → l'app revient
// proprement au Login au lieu d'empiler des « Connectez-vous » sur l'écran.
let auNonAutorise: (() => void) | null = null;
export function surNonAutorise(cb: () => void): void {
  auNonAutorise = cb;
}
// Les endpoints d'authentification renvoient aussi 401 (mauvais PIN) : les en
// exclure pour ne pas déconnecter pendant une saisie de PIN.
const CHEMINS_AUTH = ['/api/auth/login', '/api/auth/deverrouiller', '/api/auth/poser-pin'];

export async function api<T>(
  chemin: string,
  options: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; corps?: unknown } = {},
): Promise<T> {
  const rep = await fetch(chemin, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: options.corps !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: options.corps !== undefined ? JSON.stringify(options.corps) : undefined,
  }).catch(() => {
    throw new ErreurApi('Serveur de caisse injoignable — vérifiez le réseau local', 0);
  });

  if (!rep.ok) {
    let message = 'Une erreur est survenue, réessayez';
    try {
      const corps = (await rep.json()) as { erreur?: string };
      if (corps.erreur) message = corps.erreur;
    } catch {
      /* réponse non JSON */
    }
    // Session perdue (401 hors saisie de PIN) → retour au Login.
    if (rep.status === 401 && !CHEMINS_AUTH.some((c) => chemin.startsWith(c))) {
      auNonAutorise?.();
    }
    throw new ErreurApi(message, rep.status);
  }
  return rep.json() as Promise<T>;
}
