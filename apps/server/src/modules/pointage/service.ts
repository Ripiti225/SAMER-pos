/**
 * Pointage (§7) — logique métier commune aux 3 méthodes (PIN, géoloc, SMS).
 * Chaque pointage part dans sync_outbox (SamerTrackly consomme les présences).
 */
import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import type { DbOuTx } from '../../db/client.js';
import { db } from '../../db/client.js';
import { parametresLocaux, pointages, utilisateurs } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import { ErreurMetier } from '../../lib/erreurs.js';

export type PointageDb = typeof pointages.$inferSelect;

function debutDuJour(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function lireParamNombre(cle: string, defaut: number): Promise<number> {
  const [p] = await db.select().from(parametresLocaux).where(eq(parametresLocaux.cle, cle));
  return typeof p?.valeur === 'number' ? p.valeur : defaut;
}

/** Pointage ouvert (arrivée sans départ) du jour pour un employé. */
export async function pointageOuvert(tx: DbOuTx, userId: string): Promise<PointageDb | null> {
  const [p] = await tx
    .select()
    .from(pointages)
    .where(and(eq(pointages.user_id, userId), isNull(pointages.depart), gte(pointages.arrivee, debutDuJour())))
    .orderBy(desc(pointages.arrivee));
  return p ?? null;
}

export interface ResultatPointage {
  action: 'ARRIVEE' | 'DEPART';
  nom: string;
  heure: string; // HH h MM
  message: string;
}

function heureFr(d: Date): string {
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }).replace(':', 'h');
}

/**
 * Bascule arrivée ↔ départ pour un employé. Idempotence naturelle : un 2e
 * appel enregistre le départ, un 3e une nouvelle arrivée.
 */
export async function pointerBascule(userId: string, methode: string): Promise<ResultatPointage> {
  return db.transaction(async (tx) => {
    const [u] = await tx.select().from(utilisateurs).where(eq(utilisateurs.id, userId));
    if (!u || !u.actif) throw new ErreurMetier('Employé inconnu ou désactivé', 404);

    const ouvert = await pointageOuvert(tx, userId);
    if (ouvert) {
      const depart = new Date();
      const [maj] = await tx
        .update(pointages)
        .set({ depart })
        .where(eq(pointages.id, ouvert.id))
        .returning();
      await ecrireOutbox(tx, 'pointages', 'UPDATE', ouvert.id, maj as unknown as Record<string, unknown>);
      const h = heureFr(depart);
      return { action: 'DEPART', nom: u.nom_complet, heure: h, message: `Au revoir ${u.nom_complet.split(' ')[0]}, départ enregistré à ${h}` };
    }

    const arrivee = new Date();
    const [cree] = await tx
      .insert(pointages)
      .values({ user_id: userId, methode, arrivee })
      .returning();
    await ecrireOutbox(tx, 'pointages', 'INSERT', cree!.id, cree as unknown as Record<string, unknown>);
    const h = heureFr(arrivee);
    return { action: 'ARRIVEE', nom: u.nom_complet, heure: h, message: `Bonjour ${u.nom_complet.split(' ')[0]}, arrivée enregistrée à ${h}` };
  });
}

/** Distance en mètres entre deux points GPS (Haversine). */
export function distanceMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/** Vérifie que la position est dans le rayon du restaurant (§A2, côté serveur). */
export async function verifierDansRayon(lat: number, lng: number): Promise<void> {
  const [latR, lngR, rayon] = await Promise.all([
    lireParamNombre('pointage_lat', 0),
    lireParamNombre('pointage_lng', 0),
    lireParamNombre('pointage_rayon_metres', 150),
  ]);
  const d = distanceMetres(lat, lng, latR, lngR);
  if (d > rayon) {
    throw new ErreurMetier(`Vous êtes trop loin du restaurant pour pointer (à ${d} m)`, 403);
  }
}

/**
 * À la clôture du dernier service du jour : ferme les pointages encore ouverts
 * en marquant depart_oublie (§A4) ; alerte manager via la page santé.
 */
export async function fermerPointagesOublies(tx: DbOuTx): Promise<number> {
  const ouverts = await tx
    .select()
    .from(pointages)
    .where(and(isNull(pointages.depart), gte(pointages.arrivee, debutDuJour())));
  const maintenant = new Date();
  for (const p of ouverts) {
    const [maj] = await tx
      .update(pointages)
      .set({ depart: maintenant, depart_oublie: true })
      .where(eq(pointages.id, p.id))
      .returning();
    await ecrireOutbox(tx, 'pointages', 'UPDATE', p.id, maj as unknown as Record<string, unknown>);
  }
  return ouverts.length;
}
