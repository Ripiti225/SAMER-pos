import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { enregistrerGestionErreurs } from './plugins/erreurs.js';
import { enregistrerSessions } from './plugins/sessions.js';
import { enregistrerWs } from './plugins/ws.js';
import { routesAuth } from './modules/auth/routes.js';
import { routesCatalogue } from './modules/catalogue/routes.js';
import { routesCommandes } from './modules/commandes/routes.js';
import { routesPaiements } from './modules/paiements/routes.js';
import { routesServices } from './modules/services/routes.js';
import { routesSequences } from './modules/services/sequences.js';
import { routesRapports } from './modules/rapports/routes.js';
import { routesKds } from './modules/kds/routes.js';
import { routesServeur } from './modules/serveur/routes.js';
import { routesClient } from './modules/client/routes.js';
import { routesSalle } from './modules/salle/routes.js';
import { routesSante } from './modules/sante/routes.js';
import { routesFidelite } from './modules/fidelite/routes.js';
import { routesRoles } from './modules/roles/routes.js';
import { routesEquipe } from './modules/equipe/routes.js';
import { routesSalleAdmin } from './modules/salle/admin.js';
import { routesDisponibilite } from './modules/catalogue/admin-disponibilite.js';
import { routesReglages } from './modules/reglages/routes.js';
import { routesPoste } from './modules/poste/affichage.js';
import { routesDepenses } from './modules/depenses/routes.js';
import { routesPointage } from './modules/pointage/routes.js';
import { routesInventaire } from './modules/inventaire/routes.js';
import { routesCatalogueAdmin } from './modules/catalogue/admin-catalogue.js';
import { routesOptionsAdmin } from './modules/catalogue/admin-options.js';
import { routesPromotionsAdmin } from './modules/catalogue/admin-promotions.js';
import { EscposPrinter } from './printer/escpos.js';
import type { PrinterService } from './printer/PrinterService.js';

declare module 'fastify' {
  interface FastifyInstance {
    imprimante: PrinterService;
  }
}

export async function construireApp(options: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  await app.register(cookie);
  enregistrerGestionErreurs(app);
  enregistrerSessions(app);
  await enregistrerWs(app);

  // ESC/POS si une file d'impression est configurée (Réglages), sinon console.
  app.decorate('imprimante', new EscposPrinter());

  routesAuth(app);
  routesCatalogue(app);
  routesCommandes(app);
  routesPaiements(app);
  routesServices(app);
  routesSequences(app);
  routesRapports(app);
  routesKds(app);
  routesServeur(app);
  routesSalle(app);
  routesClient(app);
  routesSante(app);
  routesFidelite(app);
  routesRoles(app);
  routesEquipe(app);
  routesSalleAdmin(app);
  routesDisponibilite(app);
  routesReglages(app);
  routesPoste(app);
  routesDepenses(app);
  routesPointage(app);
  routesInventaire(app);
  routesCatalogueAdmin(app);
  routesOptionsAdmin(app);
  routesPromotionsAdmin(app);

  // Sert le build de la caisse (apps/caisse/dist) depuis la même origine que
  // l'API : requis par api.ts (fetch relatif + cookie de session same-origin).
  // Absent en dev (Vite sert la caisse séparément avec sa propre proxy).
  // Pas de routing côté client (pas de react-router) : l'index par défaut de
  // @fastify/static suffit, pas besoin de fallback SPA ni d'un 2e setNotFoundHandler
  // (erreurs.ts en a déjà un ; Fastify interdit d'en définir deux sur la même instance).
  const distCaisse = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../caisse/dist',
  );
  if (existsSync(distCaisse)) {
    await app.register(fastifyStatic, { root: distCaisse, prefix: '/' });
  }

  return app;
}
