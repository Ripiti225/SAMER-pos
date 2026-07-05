import type { FastifyInstance } from 'fastify';
import type { CatalogueVue, TableVue } from '@pos/shared';
import { chargerCatalogue } from './service.js';
import { chargerTables } from '../tables/etat.js';

export function routesCatalogue(app: FastifyInstance): void {
  app.get('/api/catalogue', { preHandler: app.exigerAuth }, async (): Promise<CatalogueVue> => {
    return chargerCatalogue();
  });

  // Plan de salle : liste des tables avec état DÉRIVÉ (point 4)
  app.get('/api/tables', { preHandler: app.exigerAuth }, async (): Promise<TableVue[]> => {
    return chargerTables();
  });
}
