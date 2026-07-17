/**
 * SPRINT 4C — Paramètres (2.6) et Outils d'encadrement (2.7).
 * - Paramètres : liste blanche PARAMETRES_EDITABLES, effet immédiat + audit
 *   MODIF_PARAMETRE (avant/après). Guard `reglages.parametres`.
 * - Journal d'audit : lecture seule avec filtres. Guard `reglages.audit`.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { CLES_PARAMETRES_EDITABLES, ConfigRestaurantSchema, ModifierParametreSchema, PARAMETRES_EDITABLES } from '@pos/shared';
import { db } from '../../db/client.js';
import { auditLog, parametresLocaux, restaurant, utilisateurs } from '../../db/schema/index.js';
import { ErreurMetier } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';
import { restaurantsSamtrackly } from '../equipe/sync-samtrackly.js';

const estHex = (c: string | null): c is string => !!c && /^#[0-9a-fA-F]{6}$/.test(c);
const slug = (nom: string): string =>
  nom
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'RESTAURANT';

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

  // ---- Configuration de l'identité du restaurant (déploiement multi-restos) ----
  const gardeResto = app.exigePermission('reglages.restaurant');

  app.get('/api/admin/restaurant/config', { preHandler: gardeResto }, async () => {
    const [resto] = await db.select().from(restaurant).limit(1);
    const [p] = await db.select().from(parametresLocaux).where(eq(parametresLocaux.cle, 'samtrackly_restaurant_id'));
    const restaurants = await restaurantsSamtrackly();
    return {
      actuel: resto ? { code: resto.code, nom: resto.nom, marque: resto.marque, couleur_hex: resto.couleur_hex } : null,
      samtrackly_restaurant_id: typeof p?.valeur === 'string' ? p.valeur : '',
      restaurants,
    };
  });

  app.post('/api/admin/restaurant/config', { preHandler: gardeResto }, async (req) => {
    const { samtrackly_restaurant_id } = valider(ConfigRestaurantSchema, req.body);
    const choisi = (await restaurantsSamtrackly()).find((r) => r.id === samtrackly_restaurant_id);
    if (!choisi) throw new ErreurMetier('Restaurant SamerTrackly introuvable (clé/connexion ?)', 404);

    const marque = /al\s*kayan/i.test(choisi.nom) ? 'AL_KAYAN' : 'SAMER';
    const couleur = estHex(choisi.couleur) ? choisi.couleur : marque === 'AL_KAYAN' ? '#2D7D46' : '#EF9F27';
    const code = slug(choisi.nom);

    await db.transaction(async (tx) => {
      const [resto] = await tx.select().from(restaurant).limit(1);
      if (resto) {
        await tx.update(restaurant).set({ code, nom: choisi.nom, marque, couleur_hex: couleur }).where(eq(restaurant.id, resto.id));
      } else {
        await tx.insert(restaurant).values({ code, nom: choisi.nom, marque, couleur_hex: couleur });
      }
      await tx
        .insert(parametresLocaux)
        .values({ cle: 'samtrackly_restaurant_id', valeur: samtrackly_restaurant_id as never })
        .onConflictDoUpdate({ target: parametresLocaux.cle, set: { valeur: samtrackly_restaurant_id as never } });
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_PARAMETRE',
        entite: 'restaurant',
        meta: { detail: 'Configuration restaurant', nom: choisi.nom, marque, samtrackly_restaurant_id },
      });
    });
    return { code, nom: choisi.nom, marque, couleur_hex: couleur };
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
