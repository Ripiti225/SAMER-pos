/** Client API de la page téléphone (borné au qr_token de la table). */
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
  options: { method?: 'GET' | 'POST'; corps?: unknown; visiteId?: string } = {},
): Promise<T> {
  const rep = await fetch(chemin, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.corps !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.visiteId ? { 'X-Visite-QR': options.visiteId } : {}),
    },
    body: options.corps !== undefined ? JSON.stringify(options.corps) : undefined,
  }).catch(() => {
    throw new ErreurApi('Connexion au restaurant impossible, réessayez', 0);
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

/** Téléchargement authentifié d'un reçu sans exposer le jeton de visite dans l'URL. */
export async function apiBlob(chemin: string, visiteId: string): Promise<Blob> {
  const rep = await fetch(chemin, { headers: { 'X-Visite-QR': visiteId } }).catch(() => {
    throw new ErreurApi('Connexion au restaurant impossible, réessayez', 0);
  });
  if (!rep.ok) {
    let message = 'Le reçu ne peut pas être téléchargé, réessayez';
    try {
      const corps = (await rep.json()) as { erreur?: string };
      if (corps.erreur) message = corps.erreur;
    } catch {
      /* réponse non JSON */
    }
    throw new ErreurApi(message, rep.status);
  }
  return rep.blob();
}
