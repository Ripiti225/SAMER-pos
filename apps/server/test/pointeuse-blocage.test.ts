/**
 * Mot de passe de la pointeuse refusé (2026-10-28) : le POS retentait toutes
 * les 20 s, l'appareil bloquait alors son adresse une demi-heure et refusait
 * même le bon mot de passe — en boucle, même sur une pointeuse neuve. Ici une
 * fausse pointeuse sur le réseau local de la machine de test.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { construireApp } from '../src/app.js';
import { fermerDb } from '../src/db/client.js';
import { enregistrerEmploye, ErreurAuthPointeuse, messageRefus, type ConfigPointeuse } from '../src/modules/pointeuse/isapi.js';
import { etatPointeuse, lirePointeuse, reinitialiserPointeuse, tourAutomatique } from '../src/modules/pointeuse/moteur.js';
import { PIN_PROPRIO, resetDonnees, seConnecter } from './aide.js';

const VERROU = `<?xml version="1.0" encoding="UTF-8"?>
<userCheck version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
<statusValue>401</statusValue>
<statusString>Unauthorized</statusString>
<isActivated>true</isActivated>
<lockStatus>lock</lockStatus>
<unlockTime>1738</unlockTime>
<retryLoginTime>0</retryLoginTime>
</userCheck>`;

let serveur: Server;
let cfg: ConfigPointeuse;
/** Requêtes portant des identifiants : chacune compte comme un essai pour l'appareil. */
let essais = 0;
let reponse = VERROU;

beforeAll(async () => {
  serveur = createServer((req, res) => {
    if (req.headers.authorization) essais++;
    res.writeHead(401, { 'WWW-Authenticate': 'Digest realm="DS-K1T320", qop="auth", nonce="abc"', 'Content-Type': 'application/xml' });
    res.end(req.headers.authorization ? reponse : '');
  });
  await new Promise<void>((ok) => serveur.listen(0, '127.0.0.1', ok));
  cfg = { url: `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`, utilisateur: 'admin', motDePasse: 'faux' };
});

beforeEach(() => {
  essais = 0;
  reponse = VERROU;
  reinitialiserPointeuse();
});

afterAll(async () => {
  await new Promise((ok) => serveur.close(ok));
  await fermerDb();
});

it('dit que le poste est bloqué, et pour combien de temps, plutôt que « mot de passe incorrect »', () => {
  expect(messageRefus(VERROU)).toMatch(/bloqué ce poste.*encore 29 min.*débranchez/);
  expect(messageRefus('<userCheck><lockStatus>unlock</lockStatus><retryLoginTime>3</retryLoginTime></userCheck>'))
    .toBe('Mot de passe de la pointeuse refusé — encore 3 essai(s) avant qu’elle bloque ce poste');
  expect(messageRefus('{"lockStatus":"lock","unlockTime":90}')).toMatch(/encore 2 min/);
  expect(messageRefus('')).toBe('Mot de passe de la pointeuse refusé');
});

it('arrête la lecture automatique au premier refus, jusqu’à une action à l’écran', async () => {
  await expect(lirePointeuse(undefined, cfg)).rejects.toBeInstanceOf(ErreurAuthPointeuse);
  expect(essais).toBe(1);
  expect(etatPointeuse().en_pause).toBe(true);
  expect(etatPointeuse().derniere_erreur).toMatch(/bloqué ce poste/);

  // Les tours suivants de la boucle ne touchent plus l'appareil.
  for (let i = 0; i < 5; i++) expect(await tourAutomatique()).toBe(0);
  expect(essais).toBe(1);

  // « Enregistrer et tester » (nouveau mot de passe) relance la lecture.
  reinitialiserPointeuse();
  expect(etatPointeuse().en_pause).toBe(false);
});

it('« Lire maintenant » essaie une fois même en pause (mot de passe changé sur l’appareil)', async () => {
  await expect(lirePointeuse(undefined, cfg)).rejects.toThrow();
  await expect(lirePointeuse(undefined, cfg)).rejects.toThrow();
  expect(essais).toBe(2);
});

it('l’envoi d’un employé ne retente pas les autres adresses avec un mot de passe refusé', async () => {
  reponse = '<userCheck><lockStatus>unlock</lockStatus><retryLoginTime>4</retryLoginTime></userCheck>';
  await expect(enregistrerEmploye(cfg, '1', 'Awa')).rejects.toThrow(/encore 4 essai/);
  expect(essais).toBe(1);
});

it('« Enregistrer et tester » raté : le badge ne peut plus dire « Connectée »', async () => {
  const donnees = await resetDonnees();
  const app = await construireApp();
  try {
    const proprio = await seConnecter(app, donnees.proprio_id, PIN_PROPRIO);
    const tester = (url: string) =>
      app.inject({ method: 'PUT', url: '/api/admin/pointeuse', cookies: proprio, payload: { url, utilisateur: 'admin', mot_de_passe: 'faux' } });
    const etat = async () => (await app.inject({ method: 'GET', url: '/api/admin/pointeuse', cookies: proprio })).json().etat;

    // Personne n'écoute sur ce port : injoignable, sans mise en pause.
    expect((await tester('http://127.0.0.1:1')).statusCode).toBe(502);
    expect((await etat()).derniere_erreur).toMatch(/injoignable/);
    expect((await etat()).en_pause).toBe(false);

    // Mot de passe refusé : l'erreur est visible et la lecture s'arrête.
    expect((await tester(cfg.url)).statusCode).toBe(502);
    expect((await etat()).derniere_erreur).toMatch(/bloqué ce poste/);
    expect((await etat()).en_pause).toBe(true);
  } finally {
    await app.close();
  }
});
