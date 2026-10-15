/**
 * Note des caissiers sur la caisse (2026-10-15).
 *
 * Calculée par SamerTrackly (« Note des caissiers », sur 20, 30 derniers
 * jours), descendue du cloud par le flux NOTES : ce module ne fait que la
 * LIRE. Chacun voit la sienne ; la Supervision voit celles de l'équipe.
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { NoteCaissierVue } from '@pos/shared';
import { db } from '../../db/client.js';
import { notesCaissiers, utilisateurs } from '../../db/schema/index.js';

type LigneNote = typeof notesCaissiers.$inferSelect;

const nombre = (v: string | null): number | null => (v === null ? null : Number(v));

function versVue(l: LigneNote, nom?: string): NoteCaissierVue {
  return {
    utilisateur_id: l.id,
    ...(nom !== undefined ? { nom } : {}),
    note: nombre(l.note),
    note_precedente: nombre(l.note_precedente),
    appreciation: l.appreciation,
    nb_shifts: l.nb_shifts,
    min_shifts: l.min_shifts,
    criteres: (l.criteres ?? []) as NoteCaissierVue['criteres'],
    bonus: (l.bonus ?? null) as NoteCaissierVue['bonus'],
    periode_debut: l.periode_debut,
    periode_fin: l.periode_fin,
    calcule_le: l.calcule_le.toISOString(),
  };
}

export function routesNotes(app: FastifyInstance): void {
  /** Ma note : le serveur ne renvoie JAMAIS celle d'un autre par cette route. */
  app.get('/api/moi/note', { preHandler: app.exigerAuth }, async (req) => {
    const [ligne] = await db
      .select()
      .from(notesCaissiers)
      .where(eq(notesCaissiers.id, req.session!.utilisateur_id));
    return { note: ligne ? versVue(ligne) : null };
  });

  /** Notes de l'équipe du site : responsables seulement (Supervision). */
  app.get('/api/equipe/notes', { preHandler: app.exigePermission('rapports.z') }, async () => {
    const lignes = await db
      .select({ note: notesCaissiers, nom: utilisateurs.nom_complet, actif: utilisateurs.actif })
      .from(notesCaissiers)
      .innerJoin(utilisateurs, eq(utilisateurs.id, notesCaissiers.id));
    return lignes
      .filter((l) => l.actif)
      .map((l) => versVue(l.note, l.nom))
      .sort((a, b) => (b.note ?? -1) - (a.note ?? -1) || b.nb_shifts - a.nb_shifts);
  });
}
