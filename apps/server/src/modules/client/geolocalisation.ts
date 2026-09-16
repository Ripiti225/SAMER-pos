import { inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { LocalisationClientSchema } from '@pos/shared';
import type { DbOuTx } from '../../db/client.js';
import { parametresLocaux } from '../../db/schema/index.js';
import { ErreurMetier } from '../../lib/erreurs.js';

export type LocalisationClient = z.infer<typeof LocalisationClientSchema>;

export interface ConfigurationGeolocalisationClient {
  activee: boolean;
  latitude: number | null;
  longitude: number | null;
  rayon_metres: number;
}

const CLES_GEOLOCALISATION = [
  'client_qr_geolocalisation_activee',
  'client_qr_latitude',
  'client_qr_longitude',
  'client_qr_rayon_metres',
];

function nombre(valeur: unknown): number | null {
  return typeof valeur === 'number' && Number.isFinite(valeur) ? valeur : null;
}

export async function configurationGeolocalisationClient(
  dbx: DbOuTx,
): Promise<ConfigurationGeolocalisationClient> {
  const lignes = await dbx
    .select({ cle: parametresLocaux.cle, valeur: parametresLocaux.valeur })
    .from(parametresLocaux)
    .where(inArray(parametresLocaux.cle, CLES_GEOLOCALISATION));
  const valeurs = new Map(lignes.map((ligne) => [ligne.cle, ligne.valeur]));
  const rayon = nombre(valeurs.get('client_qr_rayon_metres'));
  return {
    activee: valeurs.get('client_qr_geolocalisation_activee') === true,
    latitude: nombre(valeurs.get('client_qr_latitude')),
    longitude: nombre(valeurs.get('client_qr_longitude')),
    rayon_metres: rayon !== null && rayon > 0 ? Math.round(rayon) : 50,
  };
}

/** Distance orthodromique en mètres (formule de Haversine). */
export function distanceMetres(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const radians = (degres: number) => (degres * Math.PI) / 180;
  const dLat = radians(latitudeB - latitudeA);
  const dLon = radians(longitudeB - longitudeA);
  const latA = radians(latitudeA);
  const latB = radians(latitudeB);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(latA) * Math.cos(latB) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export async function verifierProximiteClient(
  dbx: DbOuTx,
  localisation: LocalisationClient | undefined,
): Promise<{ distance_metres: number | null; precision_metres: number | null }> {
  const config = await configurationGeolocalisationClient(dbx);
  if (!config.activee) return { distance_metres: null, precision_metres: null };
  if (config.latitude === null || config.longitude === null
    || (config.latitude === 0 && config.longitude === 0)) {
    throw new ErreurMetier('La position du restaurant n’est pas encore configurée', 503);
  }
  if (!localisation) {
    throw new ErreurMetier('Votre position est nécessaire pour commander depuis cette table', 400);
  }
  const distance = Math.round(distanceMetres(
    config.latitude,
    config.longitude,
    localisation.latitude,
    localisation.longitude,
  ));
  if (distance > config.rayon_metres) {
    throw new ErreurMetier(
      `Vous êtes trop loin du restaurant pour commander (${distance} m, maximum ${config.rayon_metres} m)`,
      403,
    );
  }
  return {
    distance_metres: distance,
    precision_metres: Math.round(localisation.precision_metres),
  };
}
