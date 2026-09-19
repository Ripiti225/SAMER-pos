export interface LocalisationClient {
  latitude: number;
  longitude: number;
  precision_metres: number;
}

const PREFIXE = 'pos_visite_qr:';

export function lireVisite(jetonTable: string): string | null {
  // Un scan provoque une vraie navigation : même si le scanner réutilise un
  // onglet existant, il doit démarrer une visite vide. Un rechargement ou un
  // retour arrière conserve en revanche la visite du client courant.
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (navigation?.type === 'navigate') return null;
  return sessionStorage.getItem(`${PREFIXE}${jetonTable}`);
}

export function memoriserVisite(jetonTable: string, visiteId: string): void {
  sessionStorage.setItem(`${PREFIXE}${jetonTable}`, visiteId);
}

/**
 * Ne demande rien quand le contrôle est désactivé. En mode géolocalisé, une
 * position fraîche et précise est transmise ; le serveur reste seul juge de la
 * distance au restaurant.
 */
export async function positionActuelle(requise: boolean): Promise<LocalisationClient | undefined> {
  if (!requise) return undefined;
  if (!window.isSecureContext) {
    throw new Error('La localisation nécessite le lien sécurisé HTTPS du restaurant.');
  }
  if (!navigator.geolocation) {
    throw new Error('La localisation n’est pas disponible sur ce téléphone.');
  }
  const position = await new Promise<GeolocationPosition>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15000,
    });
  }).catch(() => {
    throw new Error('Impossible d’obtenir votre position. Autorisez la localisation puis réessayez.');
  });
  return {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    precision_metres: position.coords.accuracy,
  };
}
