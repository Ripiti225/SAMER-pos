/** Client API : erreurs toujours en français courant (renvoyées par le serveur). */
export class ErreurApi extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

export async function api<T>(
  chemin: string,
  options: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; corps?: unknown } = {},
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
    throw new ErreurApi(message, rep.status);
  }
  return rep.json() as Promise<T>;
}
