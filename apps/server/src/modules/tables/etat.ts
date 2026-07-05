/**
 * État de table DÉRIVÉ (CORRECTIONS3 point 4) — SOURCE UNIQUE de calcul,
 * côté serveur, exposée par l'API et identique partout (caisse, serveur,
 * client). Ne jamais dupliquer cette logique dans les apps.
 *
 * L'état est calculé à partir de l'état réel des commandes et des appels de
 * la table ; le statut physique tables_salle.statut (LIBRE/OCCUPEE/
 * ADDITION_DEMANDEE) reste géré comme avant pour la compatibilité.
 */
import { and, asc, eq, notInArray } from 'drizzle-orm';
import type { BadgeTable, EtatTable, TableVue } from '@pos/shared';
import { db } from '../../db/client.js';
import { appelsTable, commandes, tablesSalle, utilisateurs, zones } from '../../db/schema/index.js';

type CommandeEtat = { statut: string; origine: string };

export interface EtatDerive {
  etat: EtatTable;
  badges: BadgeTable[];
  commande_id: string | null;
}

/** Calcule l'état + badges d'une table à partir de ses commandes et appels. */
export function deriverEtat(
  physique: string,
  commandesActives: CommandeEtat[],
  appelsEnAttente: { type: string }[],
): { etat: EtatTable; badges: BadgeTable[] } {
  const aClientAValider = commandesActives.some(
    (c) => c.origine === 'CLIENT_QR' && c.statut === 'OUVERTE',
  );
  const aEnPreparation = commandesActives.some((c) => c.statut === 'ENVOYEE_CUISINE');
  const aPrete = commandesActives.some((c) => c.statut === 'PRETE');
  const aServie = commandesActives.some((c) => c.statut === 'SERVIE');
  const appelServeur = appelsEnAttente.some((a) => a.type === 'APPEL_SERVEUR');
  const factureDemandee =
    physique === 'ADDITION_DEMANDEE' || appelsEnAttente.some((a) => a.type === 'DEMANDE_FACTURE');

  // Badges des états secondaires — priorité Appel > Facture > Prête
  const badges: BadgeTable[] = [];
  if (appelServeur) badges.push('APPEL');
  if (factureDemandee) badges.push('FACTURE');
  if (aPrete) badges.push('PRETE');

  // Couleur de l'état PRINCIPAL
  let etat: EtatTable;
  if (aClientAValider) etat = 'COMMANDE_CLIENT_A_VALIDER';
  else if (factureDemandee) etat = 'ADDITION_DEMANDEE';
  else if (aPrete) etat = 'PRETE';
  else if (aEnPreparation) etat = 'EN_PREPARATION';
  else if (aServie) etat = 'SERVIE';
  else etat = 'LIBRE';

  return { etat, badges };
}

/** Propriétaire de la table (colonne ouverte_par si présente, sinon NULL). */
function lireOuvertePar(table: Record<string, unknown>): string | null {
  return 'ouverte_par' in table ? ((table.ouverte_par as string | null) ?? null) : null;
}

/** Liste complète des tables avec état dérivé (plan de salle caisse + serveur). */
export async function chargerTables(): Promise<TableVue[]> {
  const [lignes, actives, appels, gens] = await Promise.all([
    db
      .select({ table: tablesSalle, zone_nom: zones.nom, zone_ordre: zones.ordre })
      .from(tablesSalle)
      .innerJoin(zones, eq(zones.id, tablesSalle.zone_id))
      .orderBy(asc(zones.ordre), asc(tablesSalle.numero)),
    db
      .select({
        id: commandes.id,
        table_id: commandes.table_id,
        statut: commandes.statut,
        origine: commandes.origine,
      })
      .from(commandes)
      .where(notInArray(commandes.statut, ['PAYEE', 'ANNULEE'])),
    db
      .select({ table_id: appelsTable.table_id, type: appelsTable.type })
      .from(appelsTable)
      .where(eq(appelsTable.statut, 'EN_ATTENTE')),
    db.select({ id: utilisateurs.id, nom: utilisateurs.nom_complet }).from(utilisateurs),
  ]);

  const nomParId = new Map(gens.map((g) => [g.id, g.nom]));

  return lignes.map(({ table, zone_nom }) => {
    const sesCommandes = actives.filter((c) => c.table_id === table.id);
    const sesAppels = appels.filter((a) => a.table_id === table.id);
    const { etat, badges } = deriverEtat(table.statut, sesCommandes, sesAppels);
    const ouvertePar = lireOuvertePar(table);
    return {
      id: table.id,
      zone_id: table.zone_id,
      zone_nom,
      numero: table.numero,
      partenaire: table.partenaire,
      statut: table.statut as TableVue['statut'],
      commande_id: sesCommandes[0]?.id ?? null,
      etat,
      badges,
      ouverte_par: ouvertePar,
      ouverte_par_nom: ouvertePar ? (nomParId.get(ouvertePar) ?? null) : null,
    };
  });
}

/** État dérivé d'une seule table (page client). */
export async function etatDUneTable(tableId: string, physique: string): Promise<EtatTable> {
  const [actives, appels] = await Promise.all([
    db
      .select({ statut: commandes.statut, origine: commandes.origine })
      .from(commandes)
      .where(and(eq(commandes.table_id, tableId), notInArray(commandes.statut, ['PAYEE', 'ANNULEE']))),
    db
      .select({ type: appelsTable.type })
      .from(appelsTable)
      .where(and(eq(appelsTable.table_id, tableId), eq(appelsTable.statut, 'EN_ATTENTE'))),
  ]);
  return deriverEtat(physique, actives, appels).etat;
}
