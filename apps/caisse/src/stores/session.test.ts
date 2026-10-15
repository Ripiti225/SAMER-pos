import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionInfo } from '@pos/shared';

// Le store touche au DOM (couleur de marque) et au sessionStorage de l'onglet.
const stockage = new Map<string, string>();
beforeAll(() => {
  Object.assign(globalThis, {
    document: { documentElement: { dataset: {}, style: { setProperty: () => undefined } } },
    sessionStorage: {
      getItem: (k: string) => stockage.get(k) ?? null,
      setItem: (k: string, v: string) => void stockage.set(k, v),
      removeItem: (k: string) => void stockage.delete(k),
    },
  });
});

const charger = async () => (await import('./session')).useCaisse;

function session(id: string, proprietaire: boolean): SessionInfo {
  return {
    utilisateur: { id, est_proprietaire: proprietaire, est_superviseur: false },
    permissions: ['caisse.encaisser'],
    restaurant: { marque: 'SAMER', couleur_hex: '#EF9F27' },
  } as unknown as SessionInfo;
}

describe('un gérant en caisse reste en caisse', () => {
  beforeEach(async () => {
    stockage.clear();
    (await charger()).getState().poserSession(null);
  });

  it('une vraie connexion arrive sur la Supervision', async () => {
    const caisse = await charger();
    caisse.getState().poserSession(session('proprio', true));
    expect(caisse.getState().ecran).toBe('supervision');
  });

  it('un rechargement en pleine commande reprend la commande, pas la Supervision', async () => {
    const caisse = await charger();
    caisse.getState().poserSession(session('proprio', true));
    caisse.getState().aller('accueil');
    caisse.getState().aller('commande', 'cmd-1');

    // Rechargement de la page : la mémoire repart de zéro (le sessionStorage de
    // l'onglet, lui, survit), puis la session est relue depuis le serveur.
    const note = new Map(stockage);
    caisse.setState({ session: null, ecran: 'accueil', commandeId: null, modeCaisse: false });
    note.forEach((v, k) => stockage.set(k, v));
    caisse.getState().reprendreSession(session('proprio', true));

    expect(caisse.getState().ecran).toBe('commande');
    expect(caisse.getState().commandeId).toBe('cmd-1');
  });

  it('« Retour » en mode caisse ramène à l’accueil caissier', async () => {
    const caisse = await charger();
    caisse.getState().poserSession(session('proprio', true));
    caisse.getState().aller('accueil');
    caisse.getState().aller('depenses');
    caisse.getState().rentrer();
    expect(caisse.getState().ecran).toBe('accueil');
  });

  it('venu de la Supervision, « Retour » y ramène', async () => {
    const caisse = await charger();
    caisse.getState().poserSession(session('proprio', true));
    caisse.getState().aller('mes-ventes');
    caisse.getState().rentrer();
    expect(caisse.getState().ecran).toBe('supervision');
  });

  it('une autre personne sur le même onglet repart de son propre écran', async () => {
    const caisse = await charger();
    caisse.getState().poserSession(session('proprio', true));
    caisse.getState().aller('accueil');
    caisse.getState().aller('commande', 'cmd-1');
    caisse.getState().reprendreSession(session('caissier', false));
    expect(caisse.getState().ecran).toBe('accueil');
    expect(caisse.getState().commandeId).toBeNull();
  });
});
