/**
 * SPRINT 4C — Paramètres (2.6) et Outils d'encadrement (2.7).
 * - Paramètres : liste blanche PARAMETRES_EDITABLES, effet immédiat + audit
 *   MODIF_PARAMETRE (avant/après). Guard `reglages.parametres`.
 * - Journal d'audit : lecture seule avec filtres. Guard `reglages.audit`.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { CLES_PARAMETRES_EDITABLES, ModifierParametreSchema, PARAMETRES_EDITABLES } from '@pos/shared';
import { db } from '../../db/client.js';
import { auditLog, parametresLocaux, utilisateurs } from '../../db/schema/index.js';
import { ErreurMetier } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';

export function routesReglages(app: FastifyInstance): void {
  // ---- Paramètres du restaurant (2.6) ----
  const gardeParam = app.exigePermission('reglages.parametres');

  app.get('/api/admin/parametres', { preHandler: gardeParam }, async () => {
    const lignes = await db.select().from(parametresLocaux);
    const parCle = new Map(lignes.map((l) => [l.cle, l.valeur]));
    return PARAMETRES_EDITABLES.map((p) => ({
      ...p,
      valeur: parCle.has(p.cle) ? parCle.get(p.cle) : p.defaut,
    }));
  });

  app.patch('/api/admin/parametres', { preHandler: gardeParam }, async (req) => {
    const corps = valider(ModifierParametreSchema, req.body);
    if (!CLES_PARAMETRES_EDITABLES.includes(corps.cle)) {
      throw new ErreurMetier('Ce paramètre n’est pas modifiable', 400);
    }
    const [avant] = await db.select().from(parametresLocaux).where(eq(parametresLocaux.cle, corps.cle));
    await db.transaction(async (tx) => {
      await tx
        .insert(parametresLocaux)
        .values({ cle: corps.cle, valeur: corps.valeur as never })
        .onConflictDoUpdate({ target: parametresLocaux.cle, set: { valeur: corps.valeur as never } });
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_PARAMETRE',
        entite: 'parametres_locaux',
        meta: { cle: corps.cle, avant: avant?.valeur ?? null, apres: corps.valeur },
      });
    });
    return { cle: corps.cle, valeur: corps.valeur };
  });

  // ---- Journal d'audit : lecture seule + filtres (2.7) ----
  app.get('/api/admin/audit', { preHandler: app.exigePermission('reglages.audit') }, async (req) => {
    const q = req.query as { depuis?: string; jusqua?: string; user_id?: string; action?: string; limite?: string };
    const conditions = [];
    if (q.depuis) conditions.push(gte(auditLog.created_at, new Date(q.depuis)));
    if (q.jusqua) conditions.push(lte(auditLog.created_at, new Date(q.jusqua)));
    if (q.user_id) conditions.push(eq(auditLog.user_id, q.user_id));
    if (q.action) conditions.push(eq(auditLog.action, q.action));
    const limite = Math.min(Number(q.limite ?? 200) || 200, 500);

    const lignes = await db
      .select({
        seq: auditLog.seq,
        created_at: auditLog.created_at,
        action: auditLog.action,
        entite: auditLog.entite,
        entite_id: auditLog.entite_id,
        montant: auditLog.montant,
        motif: auditLog.motif,
        meta: auditLog.meta,
        user_id: auditLog.user_id,
        user_nom: utilisateurs.nom_complet,
      })
      .from(auditLog)
      .leftJoin(utilisateurs, eq(utilisateurs.id, auditLog.user_id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(auditLog.seq))
      .limit(limite);
    return lignes.map((l) => ({ ...l, created_at: l.created_at.toISOString() }));
  });

  // ---- Santé : redémarrage du service (2.7) ----
  app.post('/api/admin/redemarrer', { preHandler: app.exigePermission('reglages.sante') }, async (req) => {
    await db.transaction(async (tx) => {
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_PARAMETRE',
        entite: 'systeme',
        meta: { detail: 'Demande de redémarrage du service' },
      });
    });
    // Le redémarrage effectif est confié au gestionnaire de processus (systemd /
    // pm2) : on sort proprement peu après avoir répondu.
    setTimeout(() => process.exit(0), 200);
    return { ok: true, message: 'Le service redémarre…' };
  });
}
