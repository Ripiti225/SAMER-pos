import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { enregistrerGestionErreurs } from './plugins/erreurs.js';
import { enregistrerSessions } from './plugins/sessions.js';
import { enregistrerWs } from './plugins/ws.js';
import { routesAuth } from './modules/auth/routes.js';
import { routesCatalogue } from './modules/catalogue/routes.js';
import { routesCommandes } from './modules/commandes/routes.js';
import { routesPaiements } from './modules/paiements/routes.js';
import { routesServices } from './modules/services/routes.js';
import { routesRapports } from './modules/rapports/routes.js';
import { ConsolePrinter } from './printer/ConsolePrinter.js';
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

  app.decorate('imprimante', new ConsolePrinter());

  routesAuth(app);
  routesCatalogue(app);
  routesCommandes(app);
  routesPaiements(app);
  routesServices(app);
  routesRapports(app);

  app.get('/api/sante', async () => ({ ok: true }));

  return app;
}
