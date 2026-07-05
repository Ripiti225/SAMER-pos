/**
 * Client API du KDS (correction 3) : pas de session humaine, l'appareil
 * s'identifie par un jeton envoyé dans l'en-tête « x-jeton-kds ».
 * Le jeton est saisi UNE FOIS à l'installation et gardé sur l'appareil.
 */
const CLE_JETON = 'kds_jeton_appareil';

export function lireJeton(): string | null {
  return localStorage.getItem(CLE_JETON);
}

export function enregistrerJeton(jeton: string): void {
  localStorage.setItem(CLE_JETON, jeton.trim());
}

export function oublierJeton(): void {
  localStorage.removeItem(CLE_JETON);
}

export class ErreurApi extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

export async function apiKds<T>(
  chemin: string,
  options: { method?: 'GET' | 'POST'; corps?: unknown } = {},
): Promise<T> {
  const entetes: Record<string, string> = { 'x-jeton-kds': lireJeton() ?? '' };
  if (options.corps !== undefined) entetes['Content-Type'] = 'application/json';

  const rep = await fetch(chemin, {
    method: options.method ?? 'GET',
    headers: entetes,
    body: options.corps !== undefined ? JSON.stringify(options.corps) : undefined,
  }).catch(() => {
    throw new ErreurApi('Serveur injoignable — vérifiez le réseau local', 0);
  });

  if (!rep.ok) {
    let message = 'Une erreur est survenue, réessayez';
    try {
      const corps = (await rep.json()) as { erreur?: string };
      if (corps.erreur) message = corps.erreur;
    } catch {
      /* réponse non JSON */
    }
    throw new ErreurApi(message, rep.status);
  }
  return rep.json() as Promise<T>;
}
