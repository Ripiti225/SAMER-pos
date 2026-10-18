import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { erreursSysteme } from '../../db/schema/index.js';

interface ContexteIncident {
  methode?: string;
  chemin?: string;
  request_id?: string;
  utilisateur_id?: string | null;
  [cle: string]: unknown;
}

const ACTIONS: [RegExp, string][] = [
  [/\/api\/services\/ouvrir/, 'l’ouverture du service'],
  [/\/api\/services\/cloturer/, 'la clôture du service'],
  [/\/api\/commandes.*paiements/, 'l’encaissement de la commande'],
  [/\/api\/commandes/, 'le traitement de la commande'],
  [/\/api\/admin\/imprimante/, 'la communication avec l’imprimante'],
  [/\/api\/admin/, 'l’enregistrement des paramètres'],
  [/\/api\/sante/, 'la lecture de l’état du système'],
];

function actionPour(chemin?: string): string {
  if (!chemin) return 'une opération en arrière-plan';
  return ACTIONS.find(([motif]) => motif.test(chemin))?.[1] ?? `la demande ${chemin}`;
}

function codeErreur(erreur: unknown): string | null {
  const brut = (erreur as { code?: unknown })?.code;
  return typeof brut === 'string' ? brut : null;
}

/** Explication destinée au gérant, distincte du détail technique pour le développeur. */
export function expliquerErreur(erreur: unknown, contexte: ContexteIncident = {}): string {
  const action = actionPour(contexte.chemin);
  const code = codeErreur(erreur);
  if (code === '23505') return `Le système n’a pas pu terminer ${action}, car un enregistrement identique existe déjà.`;
  if (code === '23503') return `Le système n’a pas pu terminer ${action}, car une donnée liée n’existe plus. Une reconnexion ou une resynchronisation peut être nécessaire.`;
  if (code === '23514' || code === '22P02') return `Le système a refusé ${action}, car une valeur enregistrée ne respecte pas les règles de la base de données.`;
  if (code === '42P01' || code === '42703') return `Le système n’a pas pu terminer ${action}, car la base locale n’est pas à jour. Redémarrez le POS pour appliquer les migrations.`;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') {
    return `Le système n’a pas pu terminer ${action}, car le service distant ou le périphérique ne répond pas.`;
  }
  return `Le système n’a pas pu terminer ${action} à cause d’un problème interne du logiciel.`;
}

function detailErreur(erreur: unknown): string {
  if (erreur instanceof Error) return erreur.stack ?? erreur.message;
  return typeof erreur === 'string' ? erreur : JSON.stringify(erreur);
}

/**
 * Enregistre sans jamais masquer l'erreur d'origine. Deux incidents identiques
 * sur dix minutes sont regroupés afin qu'une panne réseau ne remplisse pas la page.
 */
export async function enregistrerIncident(
  origine: string,
  erreur: unknown,
  contexte: ContexteIncident = {},
  messageFr = expliquerErreur(erreur, contexte),
): Promise<{ id: string; message_fr: string } | null> {
  try {
    const code = codeErreur(erreur);
    const depuis = new Date(Date.now() - 10 * 60 * 1000);
    const [existant] = await db
      .select({ id: erreursSysteme.id })
      .from(erreursSysteme)
      .where(and(
        eq(erreursSysteme.origine, origine),
        code === null ? isNull(erreursSysteme.code) : eq(erreursSysteme.code, code),
        eq(erreursSysteme.message_fr, messageFr),
        isNull(erreursSysteme.resolue_le),
        gt(erreursSysteme.derniere_occurrence, depuis),
      ))
      .orderBy(desc(erreursSysteme.derniere_occurrence))
      .limit(1);

    if (existant) {
      const [maj] = await db.update(erreursSysteme).set({
        occurrences: sql`${erreursSysteme.occurrences} + 1`,
        derniere_occurrence: new Date(),
        detail_technique: detailErreur(erreur),
        contexte,
      }).where(eq(erreursSysteme.id, existant.id)).returning();
      return maj ? { id: maj.id, message_fr: maj.message_fr } : null;
    }

    const [cree] = await db.insert(erreursSysteme).values({
      origine,
      code,
      message_fr: messageFr,
      detail_technique: detailErreur(erreur),
      contexte,
    }).returning();
    return cree ? { id: cree.id, message_fr: cree.message_fr } : null;
  } catch (e) {
    // La base peut précisément être la cause de l'incident. Le logger fichier
    // reste alors le dernier recours ; l'appelant doit continuer à répondre.
    console.error('Journal de santé indisponible :', e instanceof Error ? e.message : e);
    return null;
  }
}
