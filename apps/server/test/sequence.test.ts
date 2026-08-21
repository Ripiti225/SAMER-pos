import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { fermerDb } from '../src/db/client.js';
import {
  ouvrirServiceEtCommande,
  PIN_CAISSIER,
  PIN_CAISSIER2,
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

  /**
   * L'aperçu suit les cases cochées par le gérant. Il est calculé SERVEUR :
   * la caisse n'additionne aucun montant, même pour un simple affichage.
   */
  it('l’aperçu ne totalise que les shifts cochés, et jamais un shift ouvert', async () => {
    const courante = await app.inject({ method: 'GET', url: '/api/sequences/courante', cookies: manager });
    const shifts = courante.json().shifts as { service_id: string; statut: string }[];
    const cloture = shifts.find((s) => s.statut === 'CLOTURE')!;

    const tout = await app.inject({ method: 'POST', url: '/api/sequences/apercu', cookies: manager });
    expect(tout.statusCode).toBe(200);
    expect(tout.json().vente_totale).toBe(7500);

    const rien = await app.inject({
      method: 'POST', url: '/api/sequences/apercu', cookies: manager, payload: { service_ids: [] },
    });
    expect(rien.json().vente_totale).toBe(0);

    const choisi = await app.inject({
      method: 'POST', url: '/api/sequences/apercu', cookies: manager, payload: { service_ids: [cloture.service_id] },
    });
    expect(choisi.json().vente_totale).toBe(7500);

    // Un shift encore ouvert coché ne peut rien gonfler : il n'a pas de Z.
    const ouvertCoche = await app.inject({
      method: 'POST', url: '/api/sequences/apercu', cookies: manager, payload: { service_ids: [service2] },
    });
    expect(ouvertCoche.json().vente_totale).toBe(0);

    // Et un caissier n'y a pas accès (même garde que le rasage).
    const interdit = await app.inject({ method: 'POST', url: '/api/sequences/apercu', cookies: caissier });
    expect(interdit.statusCode).toBe(403);
  });

  /**
   * Une séquence est une JOURNÉE de travail, pas « tout ce qui est fermé » : le
   * gérant doit pouvoir raser la journée même si le shift de nuit tourne
   * encore. Le shift ouvert n'est pas rasé — il repart dans la séquence
   * suivante, qui démarre aussitôt.
   */
  it('rase même avec un shift encore ouvert : celui-ci est reporté', async () => {
    const rep = await app.inject({ method: 'POST', url: '/api/sequences/cloturer', cookies: manager });
    expect(rep.statusCode).toBe(200);
    const r = rep.json();
    expect(r.nb_shifts).toBe(1); // seul le shift clôturé est rasé
    expect(r.shifts_reportes).toBe(1);
    expect(r.vente_totale).toBe(7500);

    // La séquence suivante existe déjà et porte le shift encore ouvert.
    const suivante = await app.inject({ method: 'GET', url: '/api/sequences/courante', cookies: manager });
    expect(suivante.statusCode).toBe(200);
    const seq = suivante.json();
    expect(seq.shifts).toHaveLength(1);
    expect(seq.shifts[0].service_id).toBe(service2);
    expect(seq.nb_shifts_ouverts).toBe(1);
    expect(seq.totaux.vente_totale).toBe(0); // rien de clôturé encore
    // Journée de travail = jour d'OUVERTURE du shift (logique SamerTrackly).
    expect(seq.shifts[0].journee).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('refuse une sélection vide et un shift ouvert dans la sélection', async () => {
    const vide = await app.inject({
      method: 'POST', url: '/api/sequences/cloturer', cookies: manager, payload: { service_ids: [] },
    });
    expect(vide.statusCode).toBe(409);
    expect(vide.json().erreur).toContain('Aucun shift clôturé');

    const ouvert = await app.inject({
      method: 'POST', url: '/api/sequences/cloturer', cookies: manager, payload: { service_ids: [service2] },
    });
    expect(ouvert.statusCode).toBe(409);
    expect(ouvert.json().erreur).toContain('encore ouvert');
  });

  it('le gérant choisit les shifts de sa journée : le reste attend', async () => {
    // Shift 2 (3000 F) fermé…
    await payer(commande2, 3000, caissier);
    await validerInventaire(app, caissier);
    const f = await app.inject({
      method: 'POST',
      url: '/api/services/cloturer',
      cookies: caissier,
      payload: { especes_comptees: 28000, livraisons: {}, modes: {} },
    });
    expect(f.statusCode).toBe(200);

    // …puis un 3e shift, chez un autre caissier, également fermé : le gérant a
    // donc deux shifts clôturés sous la main mais n'en veut qu'un dans sa
    // journée (l'autre appartient déjà au lendemain).
    const caissier2 = await seConnecter(app, donnees.caissier2_id, PIN_CAISSIER2);
    const c3 = await ouvrirServiceEtCommande(app, caissier2, donnees, 1); // 3000 F
    await payer(c3.commande_id, 3000, caissier2);
    await validerInventaire(app, caissier2);
    const f3 = await app.inject({
      method: 'POST',
      url: '/api/services/cloturer',
      cookies: caissier2,
      payload: { especes_comptees: 28000, livraisons: {}, modes: {} },
    });
    expect(f3.statusCode).toBe(200);

    const avant = await app.inject({ method: 'GET', url: '/api/sequences/courante', cookies: manager });
    expect(avant.json().shifts).toHaveLength(2);

    const rep = await app.inject({
      method: 'POST', url: '/api/sequences/cloturer', cookies: manager, payload: { service_ids: [service2] },
    });
    expect(rep.statusCode).toBe(200);
    const r = rep.json();
    expect(r.nb_shifts).toBe(1);
    expect(r.shifts_reportes).toBe(1);
    expect(r.vente_totale).toBe(3000); // le 3e shift n'est PAS compté

    // Le 3e shift attend, seul, dans la séquence suivante.
    const apres = await app.inject({ method: 'GET', url: '/api/sequences/courante', cookies: manager });
    const seq = apres.json();
    expect(seq.shifts).toHaveLength(1);
    expect(seq.shifts[0].service_id).toBe(c3.service_id);
    expect(seq.totaux.vente_totale).toBe(3000);

    // Et cette dernière séquence se rase normalement (plus rien à reporter).
    const dernier = await app.inject({ method: 'POST', url: '/api/sequences/cloturer', cookies: manager });
    expect(dernier.statusCode).toBe(200);
    expect(dernier.json().shifts_reportes).toBe(0);

    // Plus de séquence ouverte → rasage suivant refusé.
    const encore = await app.inject({ method: 'POST', url: '/api/sequences/cloturer', cookies: manager });
    expect(encore.statusCode).toBe(409);
  });
});
