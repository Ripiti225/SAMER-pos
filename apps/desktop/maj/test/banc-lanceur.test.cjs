'use strict';
// Banc d'essai du lanceur : installation de bout en bout sur un faux dossier
// portable (voir aide-banc.cjs). Chaque scénario vérifie l'invariant qui
// compte sur un site : à la fin, la caisse tourne SOIT entièrement sur
// l'ancienne version (code + base d'avant), SOIT entièrement sur la nouvelle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { ETAPES, lireJournal, ecrireJsonAtomique, nomSauvegarde } = require('../index.cjs');
const { ANCIEN, NOUVEAU, EMPREINTE, EMPREINTE2, ecrire, existe, creerSite, fauxProcessus, coupure, lanceurPour, etatDuSite } = require('./aide-banc.cjs');

// 24h/24 : paquet prêt la veille à 12h00, installation prévue à 06h00.
const A_L_HEURE = () => new Date('2026-10-24T06:00:30.000Z');
const EN_JOURNEE = () => new Date('2026-10-24T08:00:00.000Z');
const LA_VEILLE = () => new Date('2026-10-23T20:00:00.000Z');

function attendNouveau(site, { depsNouvelles = false } = {}) {
  const s = etatDuSite(site);
  assert.equal(s.numero, NOUVEAU.numero);
  assert.equal(s.serveur, '// serveur nouveau\n');
  assert.equal(s.env, 'CLE_SITE=secrete-du-site\n', 'le .env du site doit suivre');
  assert.equal(s.envRacine, 'RACINE=1\n');
  assert.equal(s.fastify, depsNouvelles ? 'fastify v5\n' : 'fastify v4\n');
  assert.equal(s.empreinte, depsNouvelles ? EMPREINTE2 : EMPREINTE);
  assert.equal(s.copiePos, "export const marque = 'nouveau';\n", 'copie @pos/* régénérée depuis packages/');
  assert.equal(s.base, `migree-${NOUVEAU.numero}\n`);
}

function attendAncien(site) {
  const s = etatDuSite(site);
  assert.equal(s.numero, ANCIEN.numero);
  assert.equal(s.serveur, '// serveur ancien\n');
  assert.equal(s.env, 'CLE_SITE=secrete-du-site\n');
  assert.equal(s.fastify, 'fastify v4\n', 'node_modules remis en place');
  assert.equal(s.empreinte, EMPREINTE);
  assert.equal(s.copiePos, "export const marque = 'ancien';\n", 'copie @pos/* de l’ancienne version');
  assert.equal(s.base, 'ventes-avant\n', 'base restaurée');
}

test('installation nominale à 06h00 (site 24h/24)', async (t) => {
  const site = await creerSite(t);
  const p = fauxProcessus(site);
  t.after(() => p.couper());
  const l = lanceurPour(site, p, { horloge: A_L_HEURE });
  const r = await l.verifierCreneau();
  assert.equal(r.action, 'INSTALLATION');
  assert.equal(r.resultat, 'INSTALLEE');
  attendNouveau(site);
  // Ordre des processus : API, Vite, serveur, PostgreSQL ; puis PG, migrations, validation.
  assert.deepEqual(p.appels, ['arreterApi', 'arreterVite', 'arreterServeur', 'arreterPg', 'demarrerPg', 'migrer', 'demarrerServeur(validation)', 'validerServeur']);
  assert.ok(existe(site.racine, 'app.precedente/apps/server/src/index.ts'), 'ancienne version gardée');
  assert.ok(!existe(site.racine, `maj/pret/${NOUVEAU.numero}`), 'dossier de préparation nettoyé');
  const sauvegardes = await fsp.readdir(path.join(site.racine, 'data', 'sauvegardes'));
  assert.equal(sauvegardes.length, 1);
  assert.ok(existe(site.racine, `data/sauvegardes/${sauvegardes[0]}/COMPLET`), 'marqueur COMPLET');
  assert.equal((await lireJournal(path.join(site.racine, 'maj', 'installation.json'))).etat, 'INSTALLEE');
  // Une seconde vérification ne réinstalle pas.
  assert.equal((await l.verifierCreneau()).action, 'RIEN');
});

test('pas d’installation avant l’heure ; bandeau à H-10', async (t) => {
  const site = await creerSite(t);
  const p = fauxProcessus(site);
  const tot = await lanceurPour(site, p, { horloge: LA_VEILLE }).verifierCreneau();
  assert.equal(tot.action, 'RIEN');
  assert.equal(tot.decision.action, 'ATTENDRE');
  const preavis = await lanceurPour(site, p, { horloge: () => new Date('2026-10-24T05:52:00Z') }).verifierCreneau();
  assert.equal(preavis.decision.action, 'AVERTIR');
  assert.equal(preavis.decision.reportPossible, true);
  assert.deepEqual(p.appels, []);
  attendAncien(site);
});

test('dépendances nouvelles : node_modules du paquet DEPENDANCES, puis retour arrière propre', async (t) => {
  const site = await creerSite(t, { depsNouvelles: true });
  const p = fauxProcessus(site);
  t.after(() => p.couper());
  const r = await lanceurPour(site, p, { horloge: A_L_HEURE }).verifierCreneau();
  assert.equal(r.resultat, 'INSTALLEE');
  attendNouveau(site, { depsNouvelles: true });
  assert.ok(existe(site.racine, 'app/apps/server/node_modules/pino/index.js'));
  assert.equal(etatDuSite({ ...site, app: path.join(site.racine, 'app.precedente') }).fastify, 'fastify v4\n');

  const site2 = await creerSite(t, { depsNouvelles: true });
  const p2 = fauxProcessus(site2, { santeKo: true });
  t.after(() => p2.couper());
  const r2 = await lanceurPour(site2, p2, { horloge: A_L_HEURE }).verifierCreneau();
  assert.equal(r2.resultat, 'REVENUE');
  attendAncien(site2);
});

test('migration qui échoue → retour arrière, base restaurée, version refusée', async (t) => {
  const site = await creerSite(t);
  const p = fauxProcessus(site, { migrationEchoue: true });
  t.after(() => p.couper());
  const l = lanceurPour(site, p, { horloge: A_L_HEURE });
  const r = await l.verifierCreneau();
  assert.equal(r.resultat, 'REVENUE');
  assert.equal(r.journal.erreur.code, 'MIGRATION_ECHOUEE');
  assert.deepEqual(r.journal.refusees, [NOUVEAU.numero]);
  attendAncien(site);
  assert.ok(!existe(site.racine, 'app.precedente'), 'app.precedente redevenue app');
  assert.ok(existe(site.racine, 'data/sauvegardes'), 'sauvegarde conservée');
  // Plus jamais retentée toute seule.
  const ensuite = await l.verifierCreneau();
  assert.equal(ensuite.action, 'RIEN');
  assert.equal(ensuite.raison, 'REFUSEE');
});

test('contrôle de santé raté → retour arrière', async (t) => {
  const site = await creerSite(t);
  const p = fauxProcessus(site, { santeKo: true });
  t.after(() => p.couper());
  const r = await lanceurPour(site, p, { horloge: A_L_HEURE }).verifierCreneau();
  assert.equal(r.resultat, 'REVENUE');
  assert.equal(r.journal.erreur.code, 'SANTE_KO');
  assert.match(r.journal.erreur.message, /api\/sante répond 500/);
  attendAncien(site);
  assert.ok(existe(site.racine, `data/pgdata.echec-${NOUVEAU.numero}-20261024-060030`), 'base ratée mise de côté pour diagnostic');
});

test('serveur qui meurt pendant le contrôle → retour arrière', async (t) => {
  const site = await creerSite(t);
  const p = fauxProcessus(site, { serveurMeurt: true });
  t.after(() => p.couper());
  const r = await lanceurPour(site, p, { horloge: A_L_HEURE }).verifierCreneau();
  assert.equal(r.resultat, 'REVENUE');
  assert.match(r.journal.erreur.message, /s’est arrêté/);
  attendAncien(site);
});

test('signature invalide → rien n’est touché, version refusée', async (t) => {
  const site = await creerSite(t);
  const etat = JSON.parse(await fsp.readFile(path.join(site.racine, 'maj', 'etat.json'), 'utf8'));
  etat.pret.manifeste = etat.pret.manifeste.replace('Version de test.', 'Version piégée.');
  await ecrireJsonAtomique(path.join(site.racine, 'maj', 'etat.json'), etat);
  const p = fauxProcessus(site);
  const r = await lanceurPour(site, p, { horloge: A_L_HEURE }).verifierCreneau();
  assert.equal(r.resultat, 'REVENUE');
  assert.equal(r.journal.erreur.code, 'SIGNATURE_INVALIDE');
  assert.deepEqual(r.journal.refusees, [NOUVEAU.numero]);
  assert.deepEqual(p.appels, [], 'aucun processus arrêté');
  attendAncien(site);
});

test('fichier modifié dans la version prête → refus avant tout arrêt', async (t) => {
  const site = await creerSite(t);
  ecrire(site.racine, `maj/pret/${NOUVEAU.numero}/app/apps/server/src/index.ts`, '// glissé là\n');
  const p = fauxProcessus(site);
  const r = await lanceurPour(site, p, { horloge: A_L_HEURE }).verifierCreneau();
  assert.equal(r.resultat, 'REVENUE');
  assert.equal(r.journal.erreur.code, 'FICHIER_CORROMPU');
  assert.deepEqual(p.appels, []);
});

test('sans clé publique embarquée : mise à jour désactivée', async (t) => {
  const site = await creerSite(t);
  const p = fauxProcessus(site);
  const l = lanceurPour(site, p, { horloge: A_L_HEURE, trousseau: null });
  const r = await l.verifierCreneau();
  assert.equal(r.action, 'RIEN');
  assert.equal(r.raison, 'CLE_ABSENTE');
  assert.equal((await l.auDemarrage()).action, 'RIEN');
  assert.deepEqual(p.appels, []);
});

test('lanceur trop ancien pour le paquet → refus', async (t) => {
  const site = await creerSite(t);
  const p = fauxProcessus(site);
  const r = await lanceurPour(site, p, { horloge: A_L_HEURE, numeroLanceur: 0 }).verifierCreneau();
  assert.equal(r.resultat, 'REVENUE');
  assert.equal(r.journal.erreur.code, 'INCOMPATIBLE');
});

test('disque plein → pas d’installation, seconde chance plus tard', async (t) => {
  const site = await creerSite(t);
  const p = fauxProcessus(site);
  const plein = lanceurPour(site, p, { horloge: A_L_HEURE, mesurerEspace: async () => 10 });
  const r = await plein.verifierCreneau();
  assert.equal(r.resultat, 'REVENUE');
  assert.equal(r.journal.erreur.code, 'ESPACE_INSUFFISANT');
  assert.deepEqual(r.journal.refusees, [], 'échec passager : pas de refus');
  attendAncien(site);
  // Place libérée : la seconde tentative passe.
  t.after(() => p.couper());
  const r2 = await lanceurPour(site, p, { horloge: A_L_HEURE }).verifierCreneau();
  assert.equal(r2.resultat, 'INSTALLEE');
  assert.equal(r2.journal.tentative, 2);
  attendNouveau(site);
});

test('fichier verrouillé (EBUSY) : renommage retenté puis réussi', async (t) => {
  const site = await creerSite(t);
  const p = fauxProcessus(site);
  t.after(() => p.couper());
  const renommerOrigine = fsp.rename;
  let refus = 0;
  fsp.rename = async (src, dst) => {
    if (path.basename(dst) === 'app.precedente' && refus < 3) {
      refus += 1;
      const e = new Error('EBUSY: resource busy or locked');
      e.code = 'EBUSY';
      throw e;
    }
    return renommerOrigine(src, dst);
  };
  t.after(() => (fsp.rename = renommerOrigine));
  const r = await lanceurPour(site, p, { horloge: A_L_HEURE, renommageEssais: 6 }).verifierCreneau();
  assert.equal(refus, 3);
  assert.equal(r.resultat, 'INSTALLEE');
  attendNouveau(site);
});

test('fichier verrouillé en permanence → retour arrière, pas de refus', async (t) => {
  const site = await creerSite(t);
  const p = fauxProcessus(site);
  t.after(() => p.couper());
  const renommerOrigine = fsp.rename;
  fsp.rename = async (src, dst) => {
    if (path.basename(dst) === 'app.precedente') {
      const e = new Error('EPERM: operation not permitted');
      e.code = 'EPERM';
      throw e;
    }
    return renommerOrigine(src, dst);
  };
  t.after(() => (fsp.rename = renommerOrigine));
  const r = await lanceurPour(site, p, { horloge: A_L_HEURE, renommageEssais: 3 }).verifierCreneau();
  fsp.rename = renommerOrigine;
  assert.equal(r.resultat, 'REVENUE');
  assert.equal(r.journal.erreur.etape, 'ECHANGE_CODE');
  assert.deepEqual(r.journal.refusees, []);
  attendAncien(site);
});

test('poste éteint à 06h00 (24h/24) → installation au rallumage, avant la caisse', async (t) => {
  const site = await creerSite(t);
  const p = fauxProcessus(site);
  t.after(() => p.couper());
  const r = await lanceurPour(site, p, { horloge: EN_JOURNEE }).auDemarrage();
  assert.equal(r.action, 'INSTALLATION');
  assert.equal(r.resultat, 'INSTALLEE');
  attendNouveau(site);
});

test('24h/24 : simple redémarrage en journée avant l’heure → pas d’installation', async (t) => {
  const site = await creerSite(t, { pretLe: '2026-10-24T07:00:00.000Z' });
  const p = fauxProcessus(site);
  const r = await lanceurPour(site, p, { horloge: EN_JOURNEE }).auDemarrage();
  assert.equal(r.action, 'RIEN');
  assert.equal(r.decision.action, 'ATTENDRE');
  attendAncien(site);
});

test('site « ferme la nuit » : installation au démarrage suivant', async (t) => {
  const site = await creerSite(t, { typeSite: 'FERME_LA_NUIT', pretLe: '2026-10-23T15:00:00.000Z' });
  const p = fauxProcessus(site);
  t.after(() => p.couper());
  const enService = await lanceurPour(site, p, { horloge: LA_VEILLE }).verifierCreneau();
  assert.equal(enService.action, 'RIEN', 'jamais en plein service le jour même');
  const r = await lanceurPour(site, p, { horloge: () => new Date('2026-10-24T09:30:00Z') }).auDemarrage();
  assert.equal(r.resultat, 'INSTALLEE');
  attendNouveau(site);
});

test('« installer maintenant » du siège : une seule fois par jeton', async (t) => {
  const site = await creerSite(t, { installerMaintenant: 'jeton-1', migrationEchoue: true });
  const p = fauxProcessus(site, { migrationEchoue: true });
  t.after(() => p.couper());
  const l = lanceurPour(site, p, { horloge: LA_VEILLE });
  const r = await l.verifierCreneau();
  assert.equal(r.action, 'INSTALLATION');
  const memoire = JSON.parse(await fsp.readFile(path.join(site.racine, 'maj', 'lanceur.json'), 'utf8'));
  assert.equal(memoire.jetons_traites.installer_maintenant, 'jeton-1');
  // « Réessayer » du siège : le refus est levé, la version repart au créneau.
  const etat = JSON.parse(await fsp.readFile(path.join(site.racine, 'maj', 'etat.json'), 'utf8'));
  etat.reglages.reessayer = 'jeton-r';
  await ecrireJsonAtomique(path.join(site.racine, 'maj', 'etat.json'), etat);
  const apres = await l.examiner({ auDemarrage: false });
  assert.equal(apres.raison, null);
  assert.equal(apres.decision.action, 'ATTENDRE');
});

test('rétention : 7 jours, au moins 2 sauvegardes', async (t) => {
  const site = await creerSite(t);
  for (const jours of [10, 9, 8]) {
    const nom = nomSauvegarde(ANCIEN.numero - jours, new Date(A_L_HEURE().getTime() - jours * 86400000));
    ecrire(site.racine, `data/sauvegardes/${nom}/COMPLET`, 'x');
  }
  ecrire(site.racine, 'app.echec-1-20261001-060000/x', 'x');
  const p = fauxProcessus(site);
  t.after(() => p.couper());
  await lanceurPour(site, p, { horloge: A_L_HEURE }).verifierCreneau();
  const reste = (await fsp.readdir(path.join(site.racine, 'data', 'sauvegardes'))).sort();
  assert.equal(reste.length, 2, reste.join(', '));
  assert.ok(reste.some((n) => n.startsWith(`pgdata-${NOUVEAU.numero}-`)));
  assert.ok(reste.some((n) => n.startsWith(`pgdata-${ANCIEN.numero - 8}-`)));
});

// ---------------------------------------------------------------- coupures

const POINTS_INSTALLATION = [
  ...ETAPES.flatMap((e) => [`${e}:debut`, `${e}:fin`]),
  'ARRET_API',
  'ARRET_SERVEUR',
  'SAUVEGARDE_COPIEE',
  'ECHANGE_DEPS',
  'ECHANGE_AVANT_RENOMMAGE',
  'ECHANGE_ENTRE_RENOMMAGES',
  'ECHANGE_FIN',
  'MIGRATIONS_PG',
  'VALIDATION_DEMARRE',
  'FINALISATION_SERVEUR',
];

for (const point of POINTS_INSTALLATION) {
  test(`coupure de courant à « ${point} » → reprise cohérente au démarrage suivant`, async (t) => {
    const site = await creerSite(t);
    const p = fauxProcessus(site);
    const c = coupure(point);
    void lanceurPour(site, p, { horloge: A_L_HEURE, pointCoupure: c.pointCoupure }).verifierCreneau();
    await c.coupee;
    await p.couper();
    // Redémarrage : nouveau lanceur, processus arrêtés.
    const p2 = fauxProcessus(site);
    t.after(() => p2.couper());
    const r = await lanceurPour(site, p2, { horloge: A_L_HEURE }).auDemarrage();
    assert.ok(['REPRISE', 'RETOUR', 'INSTALLATION'].includes(r.action), JSON.stringify(r.action));
    const journal = await lireJournal(path.join(site.racine, 'maj', 'installation.json'));
    assert.ok(journal.tentative <= 2);
    if (journal.etat === 'INSTALLEE') attendNouveau(site);
    else {
      assert.equal(journal.etat, 'REVENUE');
      attendAncien(site);
    }
  });
}

const POINTS_RETOUR = [
  'RETOUR_ARRET:debut',
  'RETOUR_CODE:debut',
  'RETOUR_CODE_ECARTE',
  'RETOUR_CODE_REMIS',
  'RETOUR_CODE:fin',
  'RETOUR_BASE:debut',
  'RETOUR_BASE_COPIEE',
  'RETOUR_BASE_ECARTEE',
  'RETOUR_BASE:fin',
];

for (const point of POINTS_RETOUR) {
  test(`coupure pendant le retour arrière à « ${point} » → retour rejoué au démarrage`, async (t) => {
    const site = await creerSite(t);
    const p = fauxProcessus(site, { migrationEchoue: true });
    const c = coupure(point);
    void lanceurPour(site, p, { horloge: A_L_HEURE, pointCoupure: c.pointCoupure }).verifierCreneau();
    await c.coupee;
    await p.couper();
    const p2 = fauxProcessus(site);
    const r = await lanceurPour(site, p2, { horloge: A_L_HEURE }).auDemarrage();
    assert.equal(r.action, 'RETOUR');
    assert.equal(r.resultat, 'REVENUE');
    assert.deepEqual(r.journal.refusees, [NOUVEAU.numero]);
    attendAncien(site);
  });
}

test('deux coupures pendant les migrations → la version est abandonnée, ancien code et ancienne base', async (t) => {
  const site = await creerSite(t);
  for (let i = 0; i < 2; i++) {
    const p = fauxProcessus(site);
    const c = coupure('MIGRATIONS:fin');
    const l = lanceurPour(site, p, { horloge: A_L_HEURE, pointCoupure: c.pointCoupure });
    void (i === 0 ? l.verifierCreneau() : l.auDemarrage());
    await c.coupee;
    await p.couper();
  }
  const p3 = fauxProcessus(site);
  const r = await lanceurPour(site, p3, { horloge: A_L_HEURE }).auDemarrage();
  assert.equal(r.action, 'RETOUR');
  assert.deepEqual(r.journal.refusees, [NOUVEAU.numero]);
  attendAncien(site);
});
