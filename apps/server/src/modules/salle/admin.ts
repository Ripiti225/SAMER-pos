/**
 * SPRINT 4C — Salle & QR (2.2). Guard : permission `reglages.salle`.
 * Zones et tables gérées depuis l'app (effet immédiat via WebSocket). Une table
 * avec une commande en cours ne peut pas être désactivée. QR : voir, régénérer,
 * imprimer (PDF prêt à imprimer).
 */
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, notInArray } from 'drizzle-orm';
import {
  CreerTableSchema,
  CreerZoneSchema,
  ModifierTableSchema,
  ModifierZoneSchema,
} from '@pos/shared';
import { db } from '../../db/client.js';
import { commandes, parametresLocaux, restaurant, tablesSalle, zones } from '../../db/schema/index.js';
import { ErreurMetier, introuvable } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { adresseReseauLocale, PORT_CLIENT_DEFAUT, resoudreBaseClient } from '../../lib/reseau.js';
import { journaliser } from '../audit/audit.js';
import { genererQrToken, pdfQrTables, qrDataUrl, urlQr } from './qr.js';

/** Valeur brute du paramètre `url_base_client` (vide si non défini). */
async function baseClientConfiguree(): Promise<string> {
  const [p] = await db.select().from(parametresLocaux).where(eq(parametresLocaux.cle, 'url_base_client'));
  return typeof p?.valeur === 'string' ? p.valeur : '';
}

/**
 * Adresse réellement encodée dans les QR : le paramètre configuré, ou l'IP LAN
 * détectée si le paramètre est vide/localhost (un `localhost` sur un QR n'est
 * pas joignable depuis un téléphone).
 */
async function baseClient(): Promise<string> {
  return resoudreBaseClient(await baseClientConfiguree());
}

/** true si la table porte une commande non terminée. */
async function tableOccupee(tableId: string): Promise<boolean> {
  const [c] = await db
    .select({ id: commandes.id })
    .from(commandes)
    .where(and(eq(commandes.table_id, tableId), notInArray(commandes.statut, ['PAYEE', 'ANNULEE'])))
    .limit(1);
  return !!c;
}

export function routesSalleAdmin(app: FastifyInstance): void {
  const garde = app.exigePermission('reglages.salle');

  // Adresse réseau des QR : IP LAN détectée + adresse effectivement encodée,
  // pour que Réglages montre où pointe un QR et propose de figer cette adresse.
  app.get('/api/admin/reseau', { preHandler: garde }, async () => {
    const configuree = await baseClientConfiguree();
    const ip = adresseReseauLocale();
    return {
      ip_detectee: ip,
      adresse_detectee: ip ? `http://${ip}:${PORT_CLIENT_DEFAUT}` : null,
      adresse_configuree: configuree,
      base_effective: resoudreBaseClient(configuree),
    };
  });

  // Plan : zones + tables
  app.get('/api/admin/salle', { preHandler: garde }, async () => {
    const zs = await db.select().from(zones).orderBy(asc(zones.ordre), asc(zones.nom));
    const ts = await db.select().from(tablesSalle).orderBy(asc(tablesSalle.numero));
    return zs.map((z) => ({
      ...z,
      tables: ts
        .filter((t) => t.zone_id === z.id)
        .map((t) => ({ id: t.id, numero: t.numero, partenaire: t.partenaire, statut: t.statut, actif: t.actif, qr_token: t.qr_token })),
    }));
  });

  // Zones
  app.post('/api/admin/zones', { preHandler: garde }, async (req) => {
    const corps = valider(CreerZoneSchema, req.body);
    const [z] = await db.insert(zones).values({ nom: corps.nom, ordre: corps.ordre ?? 0 }).returning();
    await db.transaction(async (tx) => {
      await journaliser(tx, { user_id: req.session!.utilisateur_id, action: 'MODIF_ZONE', entite: 'zones', entite_id: z!.id, meta: { creation: z!.nom } });
    });
    app.diffuser('table:changee');
    return z;
  });

  app.patch('/api/admin/zones/:id', { preHandler: garde }, async (req) => {
    const { id } = req.params as { id: string };
    const corps = valider(ModifierZoneSchema, req.body);
    const [z] = await db.select().from(zones).where(eq(zones.id, id));
    if (!z) throw introuvable('Zone');
    const [maj] = await db
      .update(zones)
      .set({ nom: corps.nom ?? z.nom, ordre: corps.ordre ?? z.ordre })
      .where(eq(zones.id, id))
      .returning();
    await db.transaction(async (tx) => {
      await journaliser(tx, { user_id: req.session!.utilisateur_id, action: 'MODIF_ZONE', entite: 'zones', entite_id: id, meta: { avant: z.nom, apres: maj!.nom } });
    });
    app.diffuser('table:changee');
    return maj;
  });

  // Tables
  app.post('/api/admin/tables', { preHandler: garde }, async (req) => {
    const corps = valider(CreerTableSchema, req.body);
    const [z] = await db.select().from(zones).where(eq(zones.id, corps.zone_id));
    if (!z) throw new ErreurMetier('Zone inconnue', 400);
    const [doublon] = await db
      .select({ id: tablesSalle.id })
      .from(tablesSalle)
      .where(and(eq(tablesSalle.zone_id, corps.zone_id), eq(tablesSalle.numero, corps.numero)));
    if (doublon) throw new ErreurMetier('Une table porte déjà ce numéro dans cette zone', 409);

    // Les tables sont locales (plan de salle) : pas d'outbox de sync, seulement
    // une notification WebSocket pour un effet immédiat sur caisse et tablettes.
    const t = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(tablesSalle)
        .values({ zone_id: corps.zone_id, numero: corps.numero, partenaire: corps.partenaire ?? null, qr_token: genererQrToken() })
        .returning();
      await journaliser(tx, { user_id: req.session!.utilisateur_id, action: 'MODIF_TABLE', entite: 'tables_salle', entite_id: row!.id, meta: { creation: row!.numero } });
      return row!;
    });
    app.diffuser('table:changee');
    return t;
  });

  app.patch('/api/admin/tables/:id', { preHandler: garde }, async (req) => {
    const { id } = req.params as { id: string };
    const corps = valider(ModifierTableSchema, req.body);
    const [t] = await db.select().from(tablesSalle).where(eq(tablesSalle.id, id));
    if (!t) throw introuvable('Table');
    if (corps.actif === false && (await tableOccupee(id))) {
      throw new ErreurMetier('Cette table a une commande en cours — elle ne peut pas être désactivée', 409);
    }
    const [maj] = await db
      .update(tablesSalle)
      .set({
        numero: corps.numero ?? t.numero,
        zone_id: corps.zone_id ?? t.zone_id,
        actif: corps.actif ?? t.actif,
      })
      .where(eq(tablesSalle.id, id))
      .returning();
    await db.transaction(async (tx) => {
      await journaliser(tx, { user_id: req.session!.utilisateur_id, action: 'MODIF_TABLE', entite: 'tables_salle', entite_id: id, meta: { avant: { numero: t.numero, actif: t.actif }, apres: { numero: maj!.numero, actif: maj!.actif } } });
    });
    app.diffuser('table:changee');
    return maj;
  });

  // QR : voir
  app.get('/api/admin/tables/:id/qr', { preHandler: garde }, async (req) => {
    const { id } = req.params as { id: string };
    const [t] = await db.select().from(tablesSalle).where(eq(tablesSalle.id, id));
    if (!t || !t.qr_token) throw introuvable('Table');
    const contenu = urlQr(await baseClient(), t.qr_token);
    return { qr_token: t.qr_token, contenu, image: await qrDataUrl(contenu) };
  });

  // QR : tout régénérer d'un clic (invalide TOUS les anciens QR imprimés).
  // Une seule transaction + une entrée d'audit récapitulative.
  app.post('/api/admin/tables/regenerer-qr', { preHandler: garde }, async (req) => {
    const ts = await db.select().from(tablesSalle).where(eq(tablesSalle.actif, true)).orderBy(asc(tablesSalle.numero));
    await db.transaction(async (tx) => {
      for (const t of ts) {
        await tx.update(tablesSalle).set({ qr_token: genererQrToken() }).where(eq(tablesSalle.id, t.id));
      }
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'REGEN_QR',
        entite: 'tables_salle',
        meta: { toutes: true, nombre: ts.length },
      });
    });
    app.diffuser('table:changee');
    return { nombre: ts.length };
  });

  // QR : régénérer (invalide l'ancien)
  app.post('/api/admin/tables/:id/regenerer-qr', { preHandler: garde }, async (req) => {
    const { id } = req.params as { id: string };
    const [t] = await db.select().from(tablesSalle).where(eq(tablesSalle.id, id));
    if (!t) throw introuvable('Table');
    const nouveau = genererQrToken();
    await db.transaction(async (tx) => {
      await tx.update(tablesSalle).set({ qr_token: nouveau }).where(eq(tablesSalle.id, id));
      await journaliser(tx, { user_id: req.session!.utilisateur_id, action: 'REGEN_QR', entite: 'tables_salle', entite_id: id, meta: { ancien: t.qr_token, nouveau } });
    });
    app.diffuser('table:changee');
    const contenu = urlQr(await baseClient(), nouveau);
    return { qr_token: nouveau, contenu, image: await qrDataUrl(contenu) };
  });

  // QR : PDF prêt à imprimer (toutes les tables, ou une zone si ?zone_id=)
  app.get('/api/admin/tables/qr.pdf', { preHandler: garde }, async (req, reply) => {
    const { zone_id } = req.query as { zone_id?: string };
    const zs = await db.select().from(zones);
    const nomZone = new Map(zs.map((z) => [z.id, z.nom]));
    const base = await baseClient();
    const ts = await db
      .select()
      .from(tablesSalle)
      .where(zone_id ? and(eq(tablesSalle.zone_id, zone_id), eq(tablesSalle.actif, true)) : eq(tablesSalle.actif, true))
      .orderBy(asc(tablesSalle.numero));
    const [resto] = await db.select().from(restaurant).limit(1);
    const items = ts
      .filter((t) => t.qr_token)
      .map((t) => ({ numero: t.numero, zone: nomZone.get(t.zone_id) ?? '', contenu: urlQr(base, t.qr_token!) }));
    if (items.length === 0) throw new ErreurMetier('Aucune table à imprimer', 400);
    const pdf = await pdfQrTables(items, { nom: resto?.nom ?? 'Restaurant', couleur: resto?.couleur_hex ?? '#EF9F27' });
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', 'inline; filename="qr-tables.pdf"');
    return reply.send(pdf);
  });
}
