/**
 * Paiements « actifs » : ceux qui n'ont pas été annulés.
 *
 * Une annulation ne supprime rien : elle ajoute une ligne NÉGATIVE qui
 * contre-passe l'original (`contrepasse_de`). Les SOMMES n'ont donc besoin
 * d'aucun filtre — l'original et sa contre-passation s'annulent d'eux-mêmes.
 * En revanche tout ce qui COMPTE ou LISTE les lignes (« un paiement a-t-il
 * commencé ? », l'écran, le reçu) doit écarter la paire entière, sinon une
 * commande dont le paiement a été annulé resterait bloquée comme « payée ».
 */
import { and, sql, type SQL } from 'drizzle-orm';
import { paiements } from '../../db/schema/index.js';

type LignePaiement = { id: string; contrepasse_de: string | null };

/** Les lignes d'encaissement encore valables (ni annulées, ni contre-passations). */
export function paiementsActifs<T extends LignePaiement>(lignes: T[]): T[] {
  const annules = new Set(lignes.filter((p) => p.contrepasse_de).map((p) => p.contrepasse_de!));
  return lignes.filter((p) => !p.contrepasse_de && !annules.has(p.id));
}

/** Les paiements annulés, avec leur contre-passation (pour l'affichage). */
export function paiementsAnnules<T extends LignePaiement>(lignes: T[]): { original: T; contrepassation: T }[] {
  const paires: { original: T; contrepassation: T }[] = [];
  for (const contrepassation of lignes) {
    if (!contrepassation.contrepasse_de) continue;
    const original = lignes.find((p) => p.id === contrepassation.contrepasse_de);
    if (original) paires.push({ original, contrepassation });
  }
  return paires;
}

/** Condition SQL équivalente à `paiementsActifs`, sur la table `paiements`. */
export function conditionPaiementActif(): SQL {
  return and(
    sql`${paiements.contrepasse_de} IS NULL`,
    sql`NOT EXISTS (SELECT 1 FROM paiements AS contre WHERE contre.contrepasse_de = ${paiements.id})`,
  )!;
}

/**
 * Nombre NET de paiements : un paiement annulé ne compte plus. Sa
 * contre-passation retire l'unité que l'original avait ajoutée.
 */
export function nbPaiementsNet(): SQL<string> {
  return sql<string>`(COUNT(*) FILTER (WHERE ${paiements.montant} > 0)
    - COUNT(*) FILTER (WHERE ${paiements.montant} < 0))`;
}

/**
 * Nombre NET de rendus de monnaie : la contre-passation d'un paiement en
 * espèces porte une monnaie rendue NÉGATIVE, qui retire le rendu de l'original.
 */
export function nbRendusNet(): SQL<string> {
  return sql<string>`(COUNT(*) FILTER (WHERE ${paiements.monnaie_rendue} > 0)
    - COUNT(*) FILTER (WHERE ${paiements.monnaie_rendue} < 0))`;
}
