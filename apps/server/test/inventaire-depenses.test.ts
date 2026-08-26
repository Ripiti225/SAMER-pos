/**
 * DESIGN_V2 § 6.7 à § 6.10 — pointage, dépenses, inventaire et verrou de clôture.
 *
 * Ce fichier seede son PROPRE catalogue de comptage : `resetDonnees` vide
 * `produits_inventaire` (TRUNCATE ... CASCADE le fait tomber avec `articles`),
 * ce qui laisse les autres tests avec un inventaire vide — ici on veut au
 * contraire exercer les formules dérivées, que le portage ne doit pas rater.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { construireApp } from '../src/app.js';
import { db, fermerDb } from '../src/db/client.js';
import { auditLog, inventaireConsommations, produitsInventaire, utilisateurs } from '../src/db/schema/index.js';
import {
  ouvrirServiceEtCommande,
  PIN_CAISSIER,
  PIN_MANAGER,
  resetDonnees,
  seConnecter,
  type Donnees,
} from './aide.js';

let app: FastifyInstance;
let donnees: Donnees;
let cookies: Record<string, string>;
/** Ids du catalogue de comptage seedé pour ce fichier. */
let pain: string;
let manaiche: string;
let totalFromage: string;

const inventaire = async () =>
  (await app.inject({ method: 'GET', url: '/api/inventaire', cookies })).json();

const ligne = (etat: { lignes: { code: string }[] }, code: string) =>
  etat.lignes.find((l) => l.code === code) as unknown as {
    produit_id: string;
    sorties: number;
    entrees: number;
    theorique: number;
    ecart: number | null;
    manque_chiffre: number;
    a_compter: boolean;
    calcul: string;
  };

const compter = (produitId: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: `/api/inventaire/lignes/${produitId}`, cookies, payload });

beforeAll(async () => {
  donnees = await resetDonnees();
  app = await construireApp();
  cookies = await seConnecter(app, donnees.caissier_id, PIN_CAISSIER);

  // Catalogue de comptage minimal, calqué sur SamerTrackly :
  //  - un produit simple compté, consommé par l'article Chawarma (sorties auto) ;
  //  - une consommation de fromage (100 g par Manaïche), par la Pizza ;
  //  - le total dérivé, seul à être compté, dont les sorties viennent d'elle.
  const [p, f2, f10] = await db
    .insert(produitsInventaire)
    .values([
      { code: 'p1', categorie: 'PAIN', nom: 'Pain chawarma', prix: 2500, role: 'COMPTE', ordre: 1 },
      { code: 'f2', categorie: 'FROM', nom: 'Manaïche (100g)', prix: 0, unite: 'g', role: 'CONSO_FROMAGE', ratio: '100', ordre: 1 },
      { code: 'f10', categorie: 'FROM', nom: 'Total Fromage', prix: 5, unite: 'g', role: 'TOTAL_FROMAGE', ordre: 9 },
    ])
    .returning();
  pain = p!.id;
  manaiche = f2!.id;
  totalFromage = f10!.id;

  // Recettes (migration 0022) : le pont produit ↔ articles vendus.
  await db.insert(inventaireConsommations).values([
    { produit_id: pain, article_id: donnees.article_id, quantite: '1' },
    { produit_id: manaiche, article_id: donnees.pizza_id, quantite: '1' },
  ]);
});

afterAll(async () => {
  await app.close();
  await fermerDb();
});

describe('§ 6.9 — inventaire : sorties automatiques et formules dérivées', () => {
  it('les sorties viennent des ventes, le total dérivé de ses consommations', async () => {
    // 2 chawarmas (6 000) + 3 pizzas (18 000) = 24 000, encaissés en espèces.
    const c = await ouvrirServiceEtCommande(app, cookies, donnees, 2);
    await app.inject({
      method: 'POST',
      url: `/api/commandes/${c.commande_id}/items`,
      cookies,
      payload: { article_id: donnees.pizza_id, quantite: 3, options: [], supplements: [] },
    });
    const paiement = await app.inject({
      method: 'POST',
      url: `/api/commandes/${c.commande_id}/paiements`,
      cookies,
      payload: { mode: 'ESPECES', montant: 24000 },
    });
    expect(paiement.statusCode).toBe(200);

    // Réceptions du service : 100 pains, 1 000 g de fromage.
    for (const [produit_id, quantite] of [
      [pain, 100],
      [totalFromage, 1000],
    ] as const) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/inventaire/entrees',
        cookies,
        payload: { produit_id, quantite, fournisseur: 'Fournisseur test' },
      });
      expect(r.statusCode).toBe(200);
    }

    const etat = await inventaire();
    // Produit simple : 2 chawarmas vendus → 2 sorties, théorique 0 + 100 − 2.
    expect(ligne(etat, 'p1').sorties).toBe(2);
    expect(ligne(etat, 'p1').theorique).toBe(98);

    // La consommation ne se compte jamais : elle se lit (3 Manaïches vendues).
    expect(ligne(etat, 'f2').a_compter).toBe(false);
    expect(ligne(etat, 'f2').sorties).toBe(3);
    expect(ligne(etat, 'f2').calcul).toContain('300');

    // Total Fromage : 3 × 100 g = 300 g consommés, théorique 1 000 − 300.
    expect(ligne(etat, 'f10').sorties).toBe(300);
    expect(ligne(etat, 'f10').theorique).toBe(700);
    expect(etat.bilan.a_compter).toBe(2); // p1 et f10 ; f2 n'en est pas
  });

  /**
   * Migration 0022 — le pont est une RECETTE, pas une colonne : un produit est
   * consommé par plusieurs articles, avec une quantité qui n'est pas toujours 1
   * (un demi-poulet, c'est 0,5 poulet). Sans ça, les sorties restaient à 0.
   */
  it('additionne les ventes de TOUS les articles d’une recette, quantité comprise', async () => {
    const [frites] = await db
      .insert(produitsInventaire)
      .values({ code: 'fr1', categorie: 'FRIT', nom: 'Portions de frites', prix: 0, role: 'CONSO_FRITES', ratio: '8', ordre: 1 })
      .returning();
    // 1 portion par chawarma, une demi par pizza : 2 × 1 + 3 × 0,5 = 3,5.
    await db.insert(inventaireConsommations).values([
      { produit_id: frites!.id, article_id: donnees.article_id, quantite: '1' },
      { produit_id: frites!.id, article_id: donnees.pizza_id, quantite: '0.5' },
    ]);

    const etat = await inventaire();
    expect(ligne(etat, 'fr1').sorties).toBe(3.5);
    // Une consommation ne se compte jamais : elle ne bloque pas la validation.
    expect(ligne(etat, 'fr1').a_compter).toBe(false);
    expect(etat.bilan.a_compter).toBe(2);
  });

  it('chiffre le manquant non expliqué, et le réduit quand on l’explique', async () => {
    const r = await compter(totalFromage, { stock_compte: 650 });
    expect(r.statusCode).toBe(200);
    const apres = await inventaire();
    expect(ligne(apres, 'f10').ecart).toBe(-50);
    expect(ligne(apres, 'f10').manque_chiffre).toBe(250); // 50 g × 5 F

    await compter(totalFromage, {
      stock_compte: 650,
      quantite_expliquee: 20,
      explication: 'Chute de pizza au sol',
    });
    const explique = await inventaire();
    expect(ligne(explique, 'f10').manque_chiffre).toBe(150); // reste 30 g × 5 F
  });

  /**
   * Tirage du stock à l'instant T (§ 6.9). Une PHOTO : elle ne valide rien, ne
   * fige rien, et ne montre que de la marchandise — une consommation calculée
   * (le fromage des Manaïches) n'est pas du stock en réserve.
   */
  it('tire le stock à l’instant T : le compté prime, le théorique est signalé', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/inventaire/etat-stock', cookies });
    expect(r.statusCode).toBe(200);
    const tirage = r.json() as {
      genere_par: string;
      nb_theoriques: number;
      inventaire_valide: boolean;
      lignes: { code: string; nom: string; stock: number; compte: boolean }[];
    };

    // Les lignes de consommation n'y figurent pas : sinon on compterait deux
    // fois le même fromage (la conso ET son total).
    expect(tirage.lignes.map((l) => l.code).sort()).toEqual(['f10', 'p1']);

    // Pain non compté : le théorique (0 + 100 − 2), signalé comme tel.
    const pain1 = tirage.lignes.find((l) => l.code === 'p1')!;
    expect(pain1.stock).toBe(98);
    expect(pain1.compte).toBe(false);

    // Fromage compté 650 : le comptage physique prime sur le théorique (700).
    const fromage = tirage.lignes.find((l) => l.code === 'f10')!;
    expect(fromage.stock).toBe(650);
    expect(fromage.compte).toBe(true);

    expect(tirage.nb_theoriques).toBe(1);
    expect(tirage.inventaire_valide).toBe(false);
    expect(tirage.genere_par).toBeTruthy();

    // Lecture pure : le tirage ne fait avancer ni le comptage ni la clôture.
    const etat = await inventaire();
    expect(etat.bilan.a_compter).toBe(1);
    expect(etat.valide).toBe(false);
  });

  it('imprime le tirage sans rien valider', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/inventaire/etat-stock/imprimer', cookies });
    expect(r.statusCode).toBe(200);
    expect(r.json().lignes).toHaveLength(2);
    expect((await inventaire()).valide).toBe(false);
  });

  it('refuse la validation tant qu’un produit n’est pas compté', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/inventaire/valider', cookies });
    expect(r.statusCode).toBe(409);
    expect(r.json().erreur).toContain('à compter');
  });

  it('valide une fois tout compté, et pose le verrou de clôture', async () => {
    await compter(pain, { stock_compte: 98 });
    const r = await app.inject({ method: 'POST', url: '/api/inventaire/valider', cookies });
    expect(r.statusCode).toBe(200);
    expect(r.json().montant_manquant).toBe(150);

    const apres = await inventaire();
    expect(apres.valide).toBe(true);
    expect(apres.cloture_autorisee).toBe(true);

    // Verrouillé en lecture seule
    const modif = await compter(pain, { stock_compte: 50 });
    expect(modif.statusCode).toBe(409);
  });
});

describe('§ 6.8 — dépenses, salaires et départs', () => {
  it('refuse un salaire sans motif quand la fiche n’a pas de taux', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/depenses/payer',
      cookies,
      payload: { agent_id: donnees.serveur_id, montant: 5000 },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().erreur).toContain('motif');
  });

  it('paie au taux de la fiche, une seule fois par service, et la ligne est indélébile', async () => {
    await db
      .update(utilisateurs)
      .set({ taux_journalier: 5000 })
      .where(eq(utilisateurs.id, donnees.serveur_id));

    const paye = await app.inject({
      method: 'POST',
      url: '/api/depenses/payer',
      cookies,
      payload: { agent_id: donnees.serveur_id, montant: 5000 },
    });
    expect(paye.statusCode).toBe(200);
    expect(paye.json().auto).toBe(true);

    const encore = await app.inject({
      method: 'POST',
      url: '/api/depenses/payer',
      cookies,
      payload: { agent_id: donnees.serveur_id, montant: 5000 },
    });
    expect(encore.statusCode).toBe(409);

    const suppression = await app.inject({
      method: 'DELETE',
      url: `/api/depenses/${paye.json().id}`,
      cookies,
    });
    expect(suppression.statusCode).toBe(409);
    expect(suppression.json().erreur).toContain('paiement réel');
  });

  it('additionne le registre : le total ne se saisit plus', async () => {
    const marche = await app.inject({
      method: 'POST',
      url: '/api/depenses',
      cookies,
      payload: { categorie: 'MARCHE', libelle: 'Tomates', montant: 3000 },
    });
    expect(marche.statusCode).toBe(200);

    const registre = (await app.inject({ method: 'GET', url: '/api/depenses', cookies })).json();
    expect(registre.total).toBe(8000); // 5 000 de salaire + 3 000 de marché
    expect(registre.par_categorie.SALAIRES).toBe(5000);
    expect(registre.par_categorie.MARCHE).toBe(3000);
  });

  it('pointe une arrivée et enregistre comme PARTI qui n’est pas marqué « reste »', async () => {
    const pointe = await app.inject({
      method: 'POST',
      url: '/api/pointage',
      cookies,
      payload: { utilisateur_id: donnees.serveur_id, poste_jour: 'SERVEUR' },
    });
    expect(pointe.statusCode).toBe(200);
    expect(pointe.json().pointe_le).not.toBeNull();

    const cuisine = await app.inject({
      method: 'POST',
      url: '/api/pointage',
      cookies,
      payload: { utilisateur_id: donnees.cuisine_id },
    });
    expect(cuisine.statusCode).toBe(200);

    // Le serveur reste, le cuisinier n'est pas marqué → parti à la clôture.
    const depart = await app.inject({
      method: 'PATCH',
      url: `/api/pointage/${donnees.serveur_id}/depart`,
      cookies,
      payload: { reste: true },
    });
    expect(depart.statusCode).toBe(200);

    const bandeau = (await app.inject({ method: 'GET', url: '/api/pointage', cookies })).json();
    expect(bandeau.presents).toBe(2);
    expect(bandeau.duree_service_heures).toBe(8);
  });

  it('la clôture reprend le total des dépenses et le bloc inventaire', async () => {
    // Théorique = fond 25 000 + espèces 24 000 − dépenses 8 000 = 41 000.
    const rep = await app.inject({
      method: 'POST',
      url: '/api/services/cloturer',
      cookies,
      payload: { especes_comptees: 41000 },
    });
    expect(rep.statusCode).toBe(200);
    const z = rep.json();
    expect(z.depenses).toBe(8000);
    expect(z.especes_theorique).toBe(41000);
    expect(z.ecart).toBe(0);
    // Information manager : le manquant d'inventaire n'entre pas dans l'écart.
    expect(z.inventaire.valide).toBe(true);
    expect(z.inventaire.montant_manquant).toBe(150);
    expect(z.inventaire.manquants).toBe(1);
    expect(z.equipe).toEqual({ presents: 2, restent: 1, partis: 1 });
  });
});

describe('§ 6.10 — dépenses et livraisons ne sont plus saisissables', () => {
  it('ignore un total de dépenses et un montant de livraison envoyés par la caisse', async () => {
    const c = await ouvrirServiceEtCommande(app, cookies, donnees, 1); // 3 000 F
    await app.inject({
      method: 'POST',
      url: `/api/commandes/${c.commande_id}/paiements`,
      cookies,
      payload: { mode: 'ESPECES', montant: 3000 },
    });
    const d = await app.inject({
      method: 'POST',
      url: '/api/depenses',
      cookies,
      payload: { categorie: 'FRUITS', libelle: 'Ananas', montant: 1000 },
    });
    expect(d.statusCode).toBe(200);

    // Débloqué (le catalogue de comptage a bougé au fil du fichier).
    await app.inject({
      method: 'POST',
      url: '/api/inventaire/debloquer',
      cookies,
      payload: { pin_manager: PIN_MANAGER, motif: 'Test de non-modifiabilité' },
    });

    // La caisse ment sur les deux champs : le serveur ne les lit pas.
    const rep = await app.inject({
      method: 'POST',
      url: '/api/services/cloturer',
      cookies,
      payload: { especes_comptees: 27000, depenses: 50000, livraisons: { YANGO: 42000 } },
    });
    expect(rep.statusCode).toBe(200);
    const z = rep.json();
    expect(z.depenses).toBe(1000); // le registre, pas les 50 000 annoncés
    expect(z.livraisons.YANGO).toBeUndefined(); // aucune livraison Yango réelle
    // Théorique = fond 25 000 + espèces 3 000 − dépenses 1 000 = 27 000.
    expect(z.especes_theorique).toBe(27000);
    expect(z.ecart).toBe(0);
  });
});

describe('§ 6.10 — verrou de clôture et issue de secours', () => {
  it('refuse la clôture sans inventaire validé', async () => {
    // La commande est encaissée : seul l'inventaire doit rester bloquant.
    const c = await ouvrirServiceEtCommande(app, cookies, donnees, 1); // 3 000 F
    const paiement = await app.inject({
      method: 'POST',
      url: `/api/commandes/${c.commande_id}/paiements`,
      cookies,
      payload: { mode: 'ESPECES', montant: 3000 },
    });
    expect(paiement.statusCode).toBe(200);

    const rep = await app.inject({
      method: 'POST',
      url: '/api/services/cloturer',
      cookies,
      payload: { especes_comptees: 25000 },
    });
    expect(rep.statusCode).toBe(409);
    expect(rep.json().erreur).toContain('Inventaire non validé');
  });

  it('le déblocage manager (PIN + motif) autorise la clôture et laisse une trace', async () => {
    const sansMotif = await app.inject({
      method: 'POST',
      url: '/api/inventaire/debloquer',
      cookies,
      payload: { pin_manager: PIN_MANAGER },
    });
    expect(sansMotif.statusCode).toBe(400);

    const mauvaisPin = await app.inject({
      method: 'POST',
      url: '/api/inventaire/debloquer',
      cookies,
      payload: { pin_manager: '0000', motif: 'Fin de service, comptage impossible' },
    });
    expect(mauvaisPin.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/inventaire/debloquer',
      cookies,
      payload: { pin_manager: PIN_MANAGER, motif: 'Fin de service, comptage impossible' },
    });
    expect(ok.statusCode).toBe(200);

    const trace = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'DEBLOCAGE_INVENTAIRE'), eq(auditLog.entite, 'inventaires_service')));
    // Ce fichier débloque plus d'une fois : on vérifie CETTE trace, pas le
    // total du journal (qu'un test ajouté plus bas ferait varier).
    expect(trace.some((t) => (t.motif ?? '').includes('comptage impossible'))).toBe(true);

    // Débloquée, la caisse se ferme — et le ticket Z le dit.
    const cloture = await app.inject({
      method: 'POST',
      url: '/api/services/cloturer',
      cookies,
      payload: { especes_comptees: 28000 }, // fond 25 000 + 3 000 encaissés
    });
    expect(cloture.statusCode).toBe(200);
    const z = cloture.json();
    expect(z.ecart).toBe(0);
    expect(z.inventaire.valide).toBe(false);
    expect(z.inventaire.debloque).toBe(true);
  });
});
