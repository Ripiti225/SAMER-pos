/**
 * BATTEMENT DE CŒUR du site (2026-10-21) — envoyé au cloud avec chaque
 * descente, lu par l'écran « Santé des sites » de la console du siège.
 *
 * Il ne porte que ce que le cloud ne peut PAS déduire seul : le journal de
 * synchro lui dit déjà quand le site a parlé, pas ce qui reste coincé chez lui
 * ni quelle version il fait tourner.
 *
 * Construit au mieux : une erreur ici ne doit jamais coûter la descente du
 * catalogue — l'appelant envoie alors la descente sans battement.
 */
import { asc, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { syncEtat, syncOutbox } from '../../db/schema/index.js';
import { etatSync } from './etat.js';
import { compterEnAttente } from './montee.js';
import { versionCode } from './version.js';
import { moteurMajCourant, type BlocSanteMaj } from '../maj/moteur.js';

/** Forme attendue par `supabase/functions/_shared/sante-sites.ts`. */
export interface Battement {
  version_code: string | null;
  commit_git: string | null;
  lignes_en_attente: number;
  plus_ancienne_en_attente: string | null;
  dernier_acquittement: string | null;
  derniere_descente: string | null;
  derniere_erreur: string | null;
  heure_site: string;
  /**
   * Mise à jour à distance (contrat docs/MAJ_CONTRAT.md § 3). FACULTATIF :
   * absent sur un poste sans dossier portable (développement), ignoré par un
   * cloud antérieur.
   */
  maj?: BlocSanteMaj;
}

/**
 * Dernière descente APPLIQUÉE : exactement la date que lit `soldeVerifiable`
 * (fidelite/service.ts) pour autoriser ou non le paiement en points. Le siège
 * doit voir la même que la caisse, sinon il annoncerait les points ouverts sur
 * un site qui les refuse.
 */
export async function derniereDescente(): Promise<Date | null> {
  const [r] = await db
    .select({ dernier: sql<string | null>`MAX(${syncEtat.synced_at})` })
    .from(syncEtat)
    .where(isNotNull(syncEtat.synced_at));
  return r?.dernier ? new Date(r.dernier) : null;
}

/** Date de la plus vieille ligne pas encore acquittée (la tête de file). */
async function plusAncienneEnAttente(): Promise<Date | null> {
  // Par seq et non MIN(created_at) : l'index partiel de l'outbox porte sur
  // seq, et la tête de file est par construction la plus ancienne.
  const [r] = await db
    .select({ created_at: syncOutbox.created_at })
    .from(syncOutbox)
    .where(isNull(syncOutbox.synced_at))
    .orderBy(asc(syncOutbox.seq))
    .limit(1);
  return r?.created_at ?? null;
}

export async function construireBattement(): Promise<Battement> {
  const [enAttente, ancienne, descente] = await Promise.all([
    compterEnAttente(),
    plusAncienneEnAttente(),
    derniereDescente(),
  ]);
  const version = versionCode();
  // La montée d'abord : c'est elle qui retient les ventes. Une erreur de
  // descente n'apparaît que si les ventes, elles, partent bien.
  const erreur = etatSync.derniere_erreur
    ?? (etatSync.erreur_descente ? `Descente du catalogue : ${etatSync.erreur_descente}` : null);
  const moteurMaj = moteurMajCourant();
  const maj = moteurMaj ? await moteurMaj.blocSante().catch(() => undefined) : undefined;
  return {
    ...(maj ? { maj } : {}),
    version_code: version.version_code,
    commit_git: version.commit_git,
    lignes_en_attente: enAttente,
    plus_ancienne_en_attente: ancienne?.toISOString() ?? null,
    dernier_acquittement: etatSync.dernier_acquittement?.toISOString() ?? null,
    derniere_descente: descente?.toISOString() ?? null,
    derniere_erreur: erreur,
    heure_site: new Date().toISOString(),
  };
}
