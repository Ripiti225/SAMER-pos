/**
 * RETOURS — articles déjà lancés en cuisine puis supprimés par un manager.
 *
 * La règle métier tient en une phrase : le plat a été produit, il n'est pas
 * vendu. Il ne pèse donc ni sur la vente, ni sur le tiroir, ni sur l'inventaire
 * — mais il doit rester VISIBLE, sinon personne ne sait qu'un site refait
 * souvent ses plats. Ces tests verrouillent les deux moitiés : l'absence
 * d'incidence, et la présence dans le rapport.
 */
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
let cookies: Record<string, string>;
let commandeId: string;

interface ItemVue { id: string; nom_snapshot: string; statut_cuisine: string; envoye: boolean }
interface CommandeVue { id: string; total: number; items: ItemVue[] }

const commande = async (): Promise<CommandeVue> =>
  (await app.inject({ method: 'GET', url: `/api/commandes/${commandeId}`, cookies })).json();

const preview = async () =>
  (await app.inject({ method: 'GET', url: '/api/services/reconciliation-preview', cookies })).json();

/** Ajoute une ligne et renvoie SON id (jamais celui d'une ligne voisine). */
async function ajouter(quantite: number): Promise<string> {
  const avant = new Set((await commande()).items.map((i) => i.id));
  const rep = await app.inject({
    method: 'POST',
    url: `/api/commandes/${commandeId}/items`,
    cookies,
    payload: { article_id: donnees.article_id, quantite, options: [], supplements: [] },
  });
  if (rep.statusCode !== 200) throw new Error(`Ajout item: ${rep.body}`);
  const neuf = (rep.json() as CommandeVue).items.find((i) => !avant.has(i.id));
  if (!neuf) throw new Error('Ligne ajoutée introuvable');
  return neuf.id;
}

const annuler = (itemId: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/commandes/${commandeId}/items/${itemId}/annuler`, cookies, payload });

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  // 2 chawarmas à 3 000 = 6 000 F.
  const c = await ouvrirServiceEtCommande(app, cookies, donnees, 2);
  commandeId = c.commande_id;
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('retours (articles lancés en cuisine puis annulés)', () => {
  it('un article annulé AVANT la cuisine n’est pas un retour', async () => {
    const itemId = await ajouter(1); // 3 000 F, jamais envoyé

    // Pas encore parti en cuisine : le caissier corrige seul, sans PIN manager.
    const rep = await annuler(itemId, { motif: 'Erreur de frappe' });
    expect(rep.statusCode).toBe(200);

    const p = await preview();
    expect(p.retours.nb).toBe(0);
    expect(p.retours.par_produit).toEqual([]);
  });

  it('exige le PIN manager pour annuler un article déjà en cuisine', async () => {
    await app.inject({ method: 'POST', url: `/api/commandes/${commandeId}/envoyer`, cookies, payload: {} });
    const item = (await commande()).items.find((i) => i.statut_cuisine !== 'ANNULE')!;
    expect(item.envoye).toBe(true);

    const sansPin = await annuler(item.id, { motif: 'Le client a changé d’avis' });
    expect(sansPin.statusCode).toBe(403);
    expect(sansPin.json().erreur).toContain('PIN manager');
  });

  it('compte le retour, avec son motif et le manager qui l’a autorisé', async () => {
    const item = (await commande()).items.find((i) => i.statut_cuisine !== 'ANNULE')!;
    const avant = (await commande()).total;

    const rep = await annuler(item.id, { motif: 'Le client a changé d’avis', pin_manager: PIN_MANAGER });
    expect(rep.statusCode).toBe(200);

    // La vente perd la ligne : un retour ne se vend pas.
    expect(rep.json().total).toBeLessThan(avant);

    const p = await preview();
    expect(p.retours.nb).toBe(2); // les 2 chawarmas de la ligne
    expect(p.retours.montant).toBe(6000);
    expect(p.retours.par_produit).toHaveLength(1);
    expect(p.retours.par_produit[0].quantite).toBe(2);
    expect(p.retours.detail[0].motif).toBe('Le client a changé d’avis');
    expect(p.retours.detail[0].par_nom).toBeTruthy(); // le manager, nommé
  });

  /**
   * LE point de contrôle : supprimer la TABLE ENTIÈRE ne doit pas être une
   * porte de sortie. Sinon un manager encaisse, annule la commande complète, et
   * le plat produit ne laisse plus aucune trace nulle part.
   */
  it('compte aussi une commande ANNULÉE EN ENTIER après envoi en cuisine', async () => {
    const rep = await app.inject({ method: 'POST', url: '/api/commandes', cookies, payload: { type: 'EMPORTER' } });
    const autre = rep.json() as { id: string };
    await app.inject({
      method: 'POST',
      url: `/api/commandes/${autre.id}/items`,
      cookies,
      payload: { article_id: donnees.article_id, quantite: 1, options: [], supplements: [] },
    });
    await app.inject({ method: 'POST', url: `/api/commandes/${autre.id}/envoyer`, cookies, payload: {} });

    const annulation = await app.inject({
      method: 'POST',
      url: `/api/commandes/${autre.id}/annuler`,
      cookies,
      payload: { motif: 'Table repartie', pin_manager: PIN_MANAGER },
    });
    expect(annulation.statusCode).toBe(200);

    const p = await preview();
    // Les 2 chawarmas de la ligne annulée + celui de la commande annulée.
    expect(p.retours.nb).toBe(3);
    expect(p.retours.montant).toBe(9000);
    const surCommande = p.retours.detail.find((d: { motif: string | null }) =>
      d.motif?.startsWith('Commande annulée'),
    );
    expect(surCommande).toBeTruthy();
    expect(surCommande.motif).toContain('Table repartie');
    expect(surCommande.par_nom).toBeTruthy(); // le manager qui a validé
  });

  it('ne compte PAS une commande annulée qui n’était jamais partie en cuisine', async () => {
    const rep = await app.inject({ method: 'POST', url: '/api/commandes', cookies, payload: { type: 'EMPORTER' } });
    const jamais = rep.json() as { id: string };
    await app.inject({
      method: 'POST',
      url: `/api/commandes/${jamais.id}/items`,
      cookies,
      payload: { article_id: donnees.article_id, quantite: 4, options: [], supplements: [] },
    });
    await app.inject({
      method: 'POST',
      url: `/api/commandes/${jamais.id}/annuler`,
      cookies,
      payload: { motif: 'Client parti avant de commander', pin_manager: PIN_MANAGER },
    });

    // Rien n'a été produit : le compteur ne bouge pas.
    const p = await preview();
    expect(p.retours.nb).toBe(3);
  });

  it('fige les retours dans le rapport Z, sans toucher la vente ni l’écart', async () => {
    // La commande est vide après le retour : on vend un chawarma pour de bon.
    await ajouter(1);
    const restant = (await commande()).total;
    expect(restant).toBe(3000);
    const paiement = await app.inject({
      method: 'POST',
      url: `/api/commandes/${commandeId}/paiements`,
      cookies,
      payload: { mode: 'ESPECES', montant: restant },
    });
    expect(paiement.statusCode).toBe(200);

    await validerInventaire(app, cookies);
    const cloture = await app.inject({
      method: 'POST',
      url: '/api/services/cloturer',
      cookies,
      payload: { especes_comptees: 28000 }, // 25 000 de fond + 3 000 encaissés
    });
    expect(cloture.statusCode).toBe(200);
    const z = cloture.json().rapport_z ?? cloture.json();

    expect(z.retours.nb).toBe(3); // 2 de la ligne annulée + 1 de la commande annulée
    expect(z.retours.montant).toBe(9000);
    // Le retour ne gonfle NI la vente NI le théorique espèces : il est
    // seulement à côté, pour information.
    expect(z.total_ventes).toBe(3000);
    expect(z.especes_theorique).toBe(28000);
    expect(z.ecart).toBe(0);
  });
});
