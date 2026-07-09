/**
 * SPRINT 4C — Catalogue (2.4) et barème fidélité (2.5).
 * L'ÉDITION écrit dans le CLOUD (source siège) via l'Edge Function
 * admin-catalogue ; les modifications redescendent par la synchro (< 5 min).
 * Hors ligne : édition indisponible (la vente continue). La disponibilité (2.3)
 * reste, elle, toujours modifiable. Les commandes existantes ne changent jamais
 * (snapshots — règle existante). Guards `reglages.catalogue` / `reglages.fidelite`.
 */
import type { FastifyInstance } from 'fastify';
import { db } from '../../db/client.js';
import { parametresLocaux } from '../../db/schema/index.js';
import { ErreurMetier } from '../../lib/erreurs.js';
import { journaliser } from '../audit/audit.js';
import { chargerConfigSync } from '../sync/config.js';
import { ClientCloud, ErreurSync } from '../sync/cloud-client.js';
import { chargerCatalogue } from './service.js';

const MSG_HORS_LIGNE = 'Modification du menu impossible sans internet. La vente, elle, continue normalement.';
const MSG_DELAI = "Les modifications du catalogue s’appliquent dans les 5 minutes.";
const CLES_BAREME = ['fidelite_points_par_tranche', 'fidelite_valeur_point_fcfa', 'fidelite_seuil_utilisation'];

/** Client cloud si la synchro est configurée, sinon null (hors ligne / non enrôlé). */
async function clientCloud(): Promise<ClientCloud | null> {
  const cfg = await chargerConfigSync();
  if (!cfg.url || !cfg.cleSite) return null;
  return new ClientCloud(cfg.url, cfg.cleSite);
}

/** Envoie une écriture au cloud, en traduisant l'absence de réseau en message FR. */
async function ecrireCloud(entite: string, valeurs: Record<string, unknown>, op = 'upsert'): Promise<void> {
  const client = await clientCloud();
  if (!client) throw new ErreurMetier(MSG_HORS_LIGNE, 503);
  try {
    await client.adminCatalogue(op, entite, valeurs);
  } catch (e) {
    if (e instanceof ErreurSync && e.estReseau) throw new ErreurMetier(MSG_HORS_LIGNE, 503);
    if (e instanceof ErreurSync) throw new ErreurMetier(`Le siège a refusé la modification : ${e.message}`, e.statut || 502);
    throw e;
  }
}

export function routesCatalogueAdmin(app: FastifyInstance): void {
  const gardeCat = app.exigePermission('reglages.catalogue');

  // Lecture pour l'écran d'édition (données locales) + bandeau délai.
  app.get('/api/admin/catalogue', { preHandler: gardeCat }, async () => {
    const cfg = await chargerConfigSync();
    return { ...(await chargerCatalogue()), en_ligne: !!(cfg.url && cfg.cleSite), delai_message: MSG_DELAI };
  });

  // Écriture d'une entité catalogue → cloud (redescend par la synchro).
  app.post('/api/admin/catalogue', { preHandler: gardeCat }, async (req) => {
    const corps = req.body as { op?: string; entite?: string; valeurs?: Record<string, unknown> };
    if (!corps?.entite || typeof corps.valeurs !== 'object') {
      throw new ErreurMetier('Requête catalogue invalide', 400);
    }
    await ecrireCloud(corps.entite, corps.valeurs, corps.op ?? 'upsert');
    await db.transaction(async (tx) => {
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_CATALOGUE',
        entite: corps.entite!,
        meta: { op: corps.op ?? 'upsert', valeurs: corps.valeurs },
      });
    });
    return { ok: true, message: MSG_DELAI };
  });

  // ---- Barème fidélité (2.5) : même circuit cloud → descente ----
  const gardeFid = app.exigePermission('reglages.fidelite');

  app.get('/api/admin/fidelite/bareme', { preHandler: gardeFid }, async () => {
    const lignes = await db.select().from(parametresLocaux);
    const val = (cle: string) => lignes.find((l) => l.cle === cle)?.valeur ?? null;
    return {
      points_par_tranche: val('fidelite_points_par_tranche'),
      valeur_point_fcfa: val('fidelite_valeur_point_fcfa'),
      seuil_utilisation: val('fidelite_seuil_utilisation'),
      delai_message: MSG_DELAI,
    };
  });

  app.put('/api/admin/fidelite/bareme', { preHandler: gardeFid }, async (req) => {
    const corps = req.body as Record<string, unknown>;
    const maj: Record<string, unknown> = {};
    if ('points_par_tranche' in corps) maj.fidelite_points_par_tranche = corps.points_par_tranche;
    if ('valeur_point_fcfa' in corps) maj.fidelite_valeur_point_fcfa = corps.valeur_point_fcfa;
    if ('seuil_utilisation' in corps) maj.fidelite_seuil_utilisation = corps.seuil_utilisation;
    const cles = Object.keys(maj).filter((c) => CLES_BAREME.includes(c));
    if (cles.length === 0) throw new ErreurMetier('Aucune valeur de barème fournie', 400);

    // Chaque clé du barème part au cloud (entité bareme_fidelite).
    for (const cle of cles) {
      await ecrireCloud('bareme_fidelite', { cle, valeur: maj[cle] });
    }
    await db.transaction(async (tx) => {
      await journaliser(tx, {
        user_id: req.session!.utilisateur_id,
        action: 'MODIF_FIDELITE',
        entite: 'parametres_locaux',
        meta: { bareme: maj },
      });
    });
    return { ok: true, message: MSG_DELAI };
  });
}
