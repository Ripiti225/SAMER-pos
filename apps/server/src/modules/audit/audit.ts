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
  | 'TRANSFERT_COMMANDES'
  | 'ECART_CAISSE'
  | 'REMISE'
  | 'ANNULATION_ITEM'
  | 'ANNULATION_COMMANDE'
  | 'REOUVERTURE_NOTE'
  | 'PAIEMENT'
  | 'SPLIT_NOTE'
  | 'TRANSFERT_TABLE';

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
