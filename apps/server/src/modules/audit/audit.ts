/**
 * Journal d'audit append-only (§14.2). Toute action sensible passe par ici.
 * L'écriture audit + la ligne outbox se font dans la transaction appelante.
 */
import { auditLog } from '../../db/schema/index.js';
import { ecrireOutbox } from '../../db/outbox.js';
import type { DbOuTx } from '../../db/client.js';

export type ActionAudit =
  | 'CONNEXION'
  | 'DECONNEXION'
  | 'ECHEC_PIN'
  | 'OUVERTURE_SERVICE'
  | 'CLOTURE_SERVICE'
  | 'CLOTURE_SEQUENCE'
  | 'TRANSFERT_COMMANDES'
  | 'ECART_CAISSE'
  | 'REMISE'
  | 'ANNULATION_ITEM'
  | 'ANNULATION_COMMANDE'
  // Table ouverte par erreur, refermée sans qu'aucun article soit tapé : la
  // commande vide est abandonnée sans PIN (rien n'a été commandé ni encaissé).
  | 'ABANDON_COMMANDE_VIDE'
  | 'REOUVERTURE_NOTE'
  | 'PAIEMENT'
  // Kdo : repas offert, clôturé sans encaissement. Le motif accompagne
  // toujours l'entrée — sans lui, un cadeau est indiscernable d'un vol.
  | 'COMMANDE_OFFERTE'
  | 'SPLIT_NOTE'
  | 'TRANSFERT_TABLE'
  | 'ECART_RECONCILIATION'
  | 'CORRECTION_POINTAGE'
  | 'UTILISATION_POINTS'
  // Sprint 4B/4C — administration (Réglages)
  | 'CREATION_ROLE'
  | 'MODIF_ROLE'
  | 'DESACTIVATION_ROLE'
  | 'CREATION_EMPLOYE'
  | 'MODIF_EMPLOYE'
  | 'REINIT_PIN'
  | 'DESACTIVATION_EMPLOYE'
  | 'MODIF_ZONE'
  | 'MODIF_TABLE'
  | 'REGEN_QR'
  | 'MODIF_DISPONIBILITE'
  | 'MODIF_PARAMETRE'
  | 'MODIF_CATALOGUE'
  // Allumer ou éteindre une promotion change ce que paient les clients sur tout
  // un créneau : l'entrée est nommée, et non noyée dans MODIF_CATALOGUE, pour
  // qu'on retrouve la bascule sans lire le `meta` de chaque ligne.
  | 'PROMO_ACTIVEE'
  | 'PROMO_DESACTIVEE'
  | 'MODIF_FIDELITE'
  | 'FACTURE_IMPRIMEE'
  // Contact client et n° de commande d'une livraison partenaire. Tracé parce
  // que c'est la pièce qu'on ressort quand Yango conteste une course : qui a
  // saisi quoi, et à quelle heure.
  | 'INFOS_LIVRAISON'
  | 'ACCES_PROTEGE_REFUSE'
  // DESIGN_V2 — dépenses, pointage, inventaire (§ 6.7 à § 6.10).
  // Les paiements réels (salaire, encouragement) et le déblocage d'inventaire
  // sont les entrées qui comptent : de l'argent sort du tiroir, ou une clôture
  // passe sans comptage.
  | 'DEPENSE'
  | 'DEPENSE_SUPPRIMEE'
  | 'PAIEMENT_SALAIRE'
  | 'ENCOURAGEMENT'
  | 'POINTAGE_ARRIVEE'
  | 'MARQUAGE_DEPART'
  | 'VALIDATION_INVENTAIRE'
  | 'DEBLOCAGE_INVENTAIRE';

export interface EntreeAudit {
  user_id?: string | null;
  action: ActionAudit;
  entite: string;
  entite_id?: string | null;
  montant?: number | null;
  motif?: string | null;
  meta?: Record<string, unknown>;
}

export async function journaliser(tx: DbOuTx, entree: EntreeAudit): Promise<void> {
  const [ligne] = await tx
    .insert(auditLog)
    .values({
      user_id: entree.user_id ?? null,
      action: entree.action,
      entite: entree.entite,
      entite_id: entree.entite_id ?? null,
      montant: entree.montant ?? null,
      motif: entree.motif ?? null,
      meta: entree.meta ?? {},
    })
    .returning();
  if (ligne) {
    await ecrireOutbox(tx, 'audit_log', 'INSERT', ligne.id, ligne as unknown as Record<string, unknown>);
  }
}
