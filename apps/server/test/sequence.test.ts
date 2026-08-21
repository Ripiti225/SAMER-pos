import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { fermerDb } from '../src/db/client.js';
import {
  ouvrirServiceEtCommande,
  PIN_CAISSIER,
  PIN_MANAGER,
  resetDonnees,
  seConnecter,
  validerInventaire,
  type Donnees,
} from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let caissier: Record<string, string>;
let manager: Record<string, string>;
let service2: string;
let commande2: string;

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  caissier = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  manager = await seConnecter(app, donnees.manager_id, PIN_MANAGER);
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

async function payer(commandeId: string, montant: number, cookies: Record<string, string>) {
  const r = await app.inject({ method: 'POST', url: `/api/commandes/${commandeId}/paiements`, cookies, payload: { mode: 'ESPECES', montant } });
  expect(r.statusCode).toBe(200);
}

describe('réconciliation de shift', () => {
  it('calcule vente_totale, total_systeme et diff (blind count préservé)', async () => {
    const c = await ouvrirServiceEtCommande(app, caissier, donnees, 2); // 6000 F
    await payer(c.commande_id, 6000, caissier);

    // fond 25000 + espèces 6000 − dépenses 1000 → théorique 30000. Compté 31000
    // → écart +1000 (excédent) : la dépense aurait dû sortir 1000 du tiroir.
    // vente_totale = dépenses 1000 + Wave 500 + espèce 31000 − fond 25000 = 7500.
    // Les dépenses viennent du REGISTRE (§ 6.8), plus du corps de la requête.
    const d = await app.inject({
      method: 'POST',
      url: '/api/depenses',
      cookies: caissier,
      payload: { categorie: 'LEGUMES', libelle: 'Légumes du jour', montant: 1000 },
    });
    expect(d.statusCode).toBe(200);
    await validerInventaire(app, caissier);
    const rep = await app.inject({
      method: 'POST',
      url: '/api/services/cloturer',
      cookies: caissier,
      payload: { especes_comptees: 31000, livraisons: {}, modes: { WAVE: 500 } },
    });
    expect(rep.statusCode).toBe(200);
    const z = rep.json();
    expect(z.ecart).toBe(1000);
    expect(z.total_systeme).toBe(6000);
    expect(z.vente_totale).toBe(7500);
    expect(z.diff).toBe(1500);
    expect(z.depenses).toBe(1000);
    expect(z.modes_declares.WAVE).toBe(500);
  });

  it('la preview n’expose ni les espèces ni le total système', async () => {
    const c = await ouvrirServiceEtCommande(app, caissier, donnees, 1); // 3000 F
    service2 = c.service_id;
    commande2 = c.commande_id;
    const rep = await app.inject({ method: 'GET', url: '/api/services/reconciliation-preview', cookies: caissier });
    expect(rep.statusCode).toBe(200);
    const p = rep.json();
    expect(p.fond_de_caisse).toBe(25000);
    expect(p.modes).not.toHaveProperty('ESPECES');
    expect(p).not.toHaveProperty('total_systeme');
    expect(JSON.stringify(p)).not.toContain('theorique');
  });
});

describe('séquence (gérant)', () => {
  it('refuse la vue et la fermeture à un caissier (403)', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/sequences/courante', cookies: caissier })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/sequences/cloturer', cookies: caissier })).statusCode).toBe(403);
  });

  it('le manager voit le détail par caissier et le total', async () => {
    const rep = await app.inject({ method: 'GET', url: '/api/sequences/courante', cookies: manager });
    expect(rep.statusCode).toBe(200);
    const seq = rep.json();
    expect(seq.shifts.length).toBe(2);
    expect(seq.nb_shifts_ouverts).toBe(1); // le 2e shift est encore ouvert
    expect(seq.totaux.vente_totale).toBe(7500); // seul le shift clôturé compte
  });

  it('refuse de raser tant qu’un shift est ouvert', async () => {
    const rep = await app.inject({ method: 'POST', url: '/api/sequences/cloturer', cookies: manager });
    expect(rep.statusCode).toBe(409);
    expect(rep.json().erreur).toContain('ouvert');
  });

  it('rase la séquence une fois tous les shifts clôturés, puis refuse une 2e fois', async () => {
    // Encaisse la commande du 2e shift (3000 F) puis clôture ce shift.
    await payer(commande2, 3000, caissier);
    await validerInventaire(app, caissier);
    const f = await app.inject({
      method: 'POST',
      url: '/api/services/cloturer',
      cookies: caissier,
      payload: { especes_comptees: 28000, livraisons: {}, modes: {} },
    });
    expect(f.statusCode).toBe(200);

    const rep = await app.inject({ method: 'POST', url: '/api/sequences/cloturer', cookies: manager });
    expect(rep.statusCode).toBe(200);
    const r = rep.json();
    expect(r.nb_shifts).toBe(2);
    expect(r.vente_totale).toBe(10500); // 7500 (shift 1) + 3000 (shift 2)

    // Plus de séquence ouverte → 2e rasage refusé.
    const encore = await app.inject({ method: 'POST', url: '/api/sequences/cloturer', cookies: manager });
    expect(encore.statusCode).toBe(409);
    expect(service2).toBeTruthy();
  });
});
