/**
 * Pointeuse restée au fuseau d'usine (Chine, UTC+8) — Samer Maroc, 2026-10-29 :
 * chaque pointage arrivait sur la caisse 8 h après coup (08:04 lu à 16:02,
 * 16:24 lu à 00:23 et rangé dans le shift de nuit). L'appareil compare la
 * fenêtre de recherche à SON heure locale sans tenir compte du décalage
 * envoyé : « jusqu'à 08:05+00:00 » excluait un pointage daté 16:04+08:00.
 * Ici une fausse pointeuse qui se comporte ainsi.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { lireDecalageAppareil, lireEvenements, type ConfigPointeuse } from '../src/modules/pointeuse/isapi.js';

const DECALAGE_MIN = 8 * 60;
/** Heure locale de l'appareil, telle qu'il l'écrit : 2026-10-29T16:04:09+08:00. */
const heureLocale = (d: Date) =>
  new Date(d.getTime() + DECALAGE_MIN * 60_000).toISOString().replace(/\.\d{3}Z$/, '+08:00');

const pointage = new Date(Date.now() - 60_000);
let serveur: Server;
let cfg: ConfigPointeuse;

beforeAll(async () => {
  serveur = createServer((req, res) => {
    let corps = '';
    req.on('data', (c) => (corps += c));
    req.on('end', () => {
      if (req.url === '/ISAPI/System/time') {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(`<Time><timeMode>NTP</timeMode><localTime>${heureLocale(new Date())}</localTime><timeZone>CST-8:00:00</timeZone></Time>`);
        return;
      }
      // Comparaison sur l'heure locale seule : le « +00:00 » envoyé est ignoré.
      const cond = JSON.parse(corps).AcsEventCond as { startTime: string; endTime: string };
      const t = heureLocale(pointage).slice(0, 19);
      const dedans = cond.startTime.slice(0, 19) <= t && t <= cond.endTime.slice(0, 19);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        AcsEvent: {
          responseStatusStrg: 'OK',
          numOfMatches: dedans ? 1 : 0,
          InfoList: dedans
            ? [{ serialNo: 7, employeeNoString: '12', name: 'Awa', time: heureLocale(pointage), attendanceStatus: 'checkIn' }]
            : [],
        },
      }));
    });
  });
  await new Promise<void>((ok) => serveur.listen(0, '127.0.0.1', ok));
  cfg = { url: `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`, utilisateur: 'admin', motDePasse: 'x' };
});

afterAll(() => new Promise<void>((ok) => serveur.close(() => ok())));

it('lit le fuseau de la pointeuse', async () => {
  expect(await lireDecalageAppareil(cfg)).toBe(DECALAGE_MIN);
});

it('voit tout de suite un pointage fait sur une pointeuse à l’heure de Chine', async () => {
  const decalage = await lireDecalageAppareil(cfg);
  const lus = await lireEvenements(cfg, new Date(Date.now() - 10 * 60_000), new Date(), decalage);
  expect(lus).toHaveLength(1);
  // L'heure retenue reste l'heure réelle du pointage.
  expect(lus[0]!.pointe_le.getTime()).toBe(Math.floor(pointage.getTime() / 1000) * 1000);
});
