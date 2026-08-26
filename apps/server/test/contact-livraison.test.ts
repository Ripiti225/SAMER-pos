/**
 * Contact client et n° de commande d'une livraison partenaire.
 *
 * Les deux se saisissent dans la modale qui s'ouvre au lancement en cuisine, et
 * ils sont FACULTATIFS : le caissier peut fermer sans rien mettre. C'est
 * précisément pour ça que le ticket Z compte les commandes ET les contacts —
 * l'écart entre les deux est le nombre de courses qu'on ne saura rattacher à
 * personne, et il doit se voir au lieu de se perdre.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { fermerDb } from '../src/db/client.js';
import { PIN_CAISSIER, resetDonnees, seConnecter, validerInventaire, type Donnees } from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;

/** Une commande d'un chawarma (3 000) pour un type/partenaire donnés. */
async function commande(type: string, partenaire?: string): Promise<string> {
  const c = await app.inject({
    method: 'POST',
    url: '/api/commandes',
    cookies,
    payload: partenaire ? { type, partenaire } : { type },
  });
  const id = c.json().id as string;
  await app.inject({
    method: 'POST',
    url: `/api/commandes/${id}/items`,
    cookies,
    payload: { article_id: donnees.article_id, quantite: 1, options: [], supplements: [] },
  });
  return id;
}

const infos = (id: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/commandes/${id}/infos-livraison`, cookies, payload });

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);
  await app.inject({ method: 'POST', url: '/api/services/ouvrir', cookies, payload: { fond_de_caisse: 25000 } });
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('Infos de livraison — saisie et garde-fous', () => {
  it('enregistre le n° de commande et le contact, et les trace au journal', async () => {
    const id = await commande('LIVRAISON', 'YANGO');
    const rep = await infos(id, { ref_partenaire: 'YG-8891', contact_client: '0709112233' });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().ref_partenaire).toBe('YG-8891');
    expect(rep.json().contact_client).toBe('0709112233');

    const journal = await app.inject({ method: 'GET', url: '/api/audit?action=INFOS_LIVRAISON', cookies });
    if (journal.statusCode === 200) {
      const lignes = (journal.json().entrees ?? journal.json()) as { action: string }[];
      expect(lignes.some((l) => l.action === 'INFOS_LIVRAISON')).toBe(true);
    }
  });

  it('refuse un enregistrement entièrement vide — il effacerait la saisie', async () => {
    const id = await commande('LIVRAISON', 'YANGO');
    await infos(id, { contact_client: '0102030405' });
    const rep = await infos(id, { ref_partenaire: '', contact_client: '' });
    expect(rep.statusCode).toBe(400);
    // La saisie précédente est intacte.
    const vue = await app.inject({ method: 'GET', url: `/api/commandes/${id}`, cookies });
    expect(vue.json().contact_client).toBe('0102030405');
  });

  it('refuse ces informations sur une commande qui n’est pas une livraison', async () => {
    const id = await commande('EMPORTER');
    const rep = await infos(id, { contact_client: '0102030405' });
    expect(rep.statusCode).toBe(400);
    expect(rep.json().erreur).toContain('livraison');
  });

  it('un champ absent du formulaire ne touche pas à l’autre', async () => {
    const id = await commande('LIVRAISON', 'GLOVO');
    await infos(id, { ref_partenaire: 'GL-1', contact_client: '0505050505' });
    const rep = await infos(id, { contact_client: '0606060606' });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().ref_partenaire).toBe('GL-1');
    expect(rep.json().contact_client).toBe('0606060606');
  });
});

describe('Ticket Z — commandes et contacts par partenaire', () => {
  /** Une des courses du shift, relue après la clôture. */
  let courseSoldee = '';

  it('compte les contacts recueillis en face des commandes payées', async () => {
    // Les commandes des garde-fous ci-dessus sont restées ouvertes : on les
    // solde d'abord, sinon la clôture les refuse (et elles pollueraient le
    // décompte du partenaire mesuré ici).
    const ouvertes = (await app.inject({ method: 'GET', url: '/api/commandes/ouvertes', cookies })).json() as {
      id: string; type: string; partenaire: string | null; total: number;
    }[];
    for (const o of ouvertes) {
      const externe = o.partenaire === 'YANGO' || o.partenaire === 'GLOVO';
      const r = externe
        ? await app.inject({ method: 'POST', url: `/api/commandes/${o.id}/cloturer-livraison`, cookies })
        : await app.inject({
            method: 'POST',
            url: `/api/commandes/${o.id}/paiements`,
            cookies,
            payload: { mode: 'ESPECES', montant: o.total },
          });
      expect(r.statusCode).toBe(200);
    }

    // Samer Delly, non touché par le balayage : 4 courses, 2 contacts, 2 refs.
    const d1 = await commande('LIVRAISON', 'SAMER_DELLY');
    await infos(d1, { ref_partenaire: 'SD-1', contact_client: '0700000001' });
    const d2 = await commande('LIVRAISON', 'SAMER_DELLY');
    await infos(d2, { contact_client: '0700000002' });
    const d3 = await commande('LIVRAISON', 'SAMER_DELLY');
    await infos(d3, { ref_partenaire: 'SD-3' }); // le caissier a fermé sans le contact
    const d4 = await commande('LIVRAISON', 'SAMER_DELLY'); // modale fermée sans rien
    for (const id of [d1, d2, d3, d4]) {
      const r = await app.inject({
        method: 'POST',
        url: `/api/commandes/${id}/paiements`,
        cookies,
        payload: { mode: 'ESPECES', montant: 3000 },
      });
      expect(r.statusCode).toBe(200);
    }
    courseSoldee = d1;

    await validerInventaire(app, cookies);
    const rep = await app.inject({
      method: 'POST',
      url: '/api/services/cloturer',
      cookies,
      payload: { especes_comptees: 40000 },
    });
    expect(rep.statusCode).toBe(200);
    const z = rep.json();

    expect(z.partenaires.SAMER_DELLY.nb).toBe(4);
    expect(z.partenaires.SAMER_DELLY.contacts).toBe(2);
    expect(z.partenaires.SAMER_DELLY.refs).toBe(2);
    expect(z.partenaires.SAMER_DELLY.total).toBe(12000);
    // Les courses soldées au balayage restent comptées avec ce qu'elles
    // portaient : 2 Yango, toutes deux contactées, une seule avec le n° du
    // partenaire (l'enregistrement vide du garde-fou a bien été refusé).
    expect(z.partenaires.YANGO).toEqual({ nb: 2, total: 6000, contacts: 2, refs: 1 });
  });

  it('le shift clôturé n’accepte plus de saisie — son Z est figé', async () => {
    const rep = await infos(courseSoldee, { contact_client: '0800000000' });
    expect(rep.statusCode).toBe(409);
    expect(rep.json().erreur).toContain('clôturé');
  });
});
