import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { routesDisponibilite } from '../src/modules/catalogue/admin-disponibilite.js';

const mocks = vi.hoisted(() => ({ arts: [] as Record<string, unknown>[] }));
vi.mock('../src/db/client.js', () => ({ db: {
  select: () => ({ from: () => ({ leftJoin: () => ({ where: () => ({ orderBy: async () => mocks.arts }) }) }) }),
} }));
vi.mock('../src/modules/catalogue/disponibilite.js', () => ({
  lireDisponibilites: async () => new Map([['plat', true]]),
  articleDisponible: vi.fn(), poserDisponibilite: vi.fn(),
}));

afterEach(() => vi.useRealTimers());

it.each([false, true])('affiche le blocage horaire réel, dérogation = %s', async (forcee) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-19T18:00:00Z'));
  mocks.arts = [{ id: 'plat', categorie_heure_debut: '10:00', categorie_heure_fin: '16:00', categorie_disponibilite_forcee: forcee }];
  const app = Fastify();
  app.decorate('exigePermission', () => async () => {});
  routesDisponibilite(app);
  try {
    const reponse = await app.inject({ method: 'GET', url: '/api/admin/disponibilite' });
    expect(reponse.statusCode).toBe(200);
    expect(reponse.json()[0]).toMatchObject({ disponible: true, categorie_disponible_maintenant: forcee });
  } finally {
    await app.close();
  }
});
