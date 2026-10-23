'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { ecrireArchive, extraireArchive, verifierMorceaux, verifierArbre, _enteteFichier } = require('../archive.cjs');
const { validerManifeste } = require('../manifeste.cjs');
const { dossierTemp, manifesteApp } = require('./aide.cjs');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Arbre source de test : petits fichiers, un vide, un binaire, un chemin long. */
function arbreSource(racine) {
  const long = `apps/${'dossier-au-nom-assez-long/'.repeat(5)}fichier-final-au-nom-long.ts`;
  const fichiers = {
    'VERSION.json': '{"numero":42}',
    'apps/server/src/index.ts': 'console.log("bonjour");\n'.repeat(200),
    'apps/caisse/dist/vide.txt': '',
    'apps/caisse/dist/image.bin': crypto.randomBytes(5000),
    'docs/accentué é.md': 'éàü',
    [long]: 'long',
  };
  for (const [chemin, contenu] of Object.entries(fichiers)) {
    const abs = path.join(racine, ...chemin.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contenu);
  }
  return Object.keys(fichiers);
}

/** Publie un arbre et renvoie { manifeste, dossierMorceaux }. */
async function publier(t, { tailleMorceau = 1000 } = {}) {
  const source = dossierTemp(t, 'src');
  const dossierMorceaux = dossierTemp(t, 'morceaux');
  const chemins = arbreSource(source);
  const res = await ecrireArchive({ racine: source, chemins, dossierSortie: dossierMorceaux, prefixe: 'paquet-42', tailleMorceau });
  const manifeste = validerManifeste(manifesteApp({ archive: res.archive, morceaux: res.morceaux, fichiers: res.fichiers }));
  return { manifeste, dossierMorceaux, source, chemins };
}

/** Archive « piégée » faite à la main : entrées {chemin, contenu, type}. */
function archivePiegee(dossier, entrees) {
  const blocs = [];
  for (const e of entrees) {
    const contenu = Buffer.from(e.contenu || '');
    const entete = _enteteFichier(e.chemin, contenu.length, 0);
    if (e.type) {
      entete.write(e.type, 156, 1, 'ascii');
      if (e.lien) entete.write(e.lien, 157, 100, 'utf8');
      entete.write('        ', 148, 8, 'ascii');
      let s = 0;
      for (const o of entete) s += o;
      entete.write(`${s.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    }
    blocs.push(entete, contenu, Buffer.alloc((512 - (contenu.length % 512)) % 512));
  }
  blocs.push(Buffer.alloc(1024));
  const gz = zlib.gzipSync(Buffer.concat(blocs));
  fs.writeFileSync(path.join(dossier, 'piege.tar.gz.000'), gz);
  return manifesteApp({
    archive: { sha256: sha(gz), taille: gz.length },
    morceaux: [{ nom: 'piege.tar.gz.000', sha256: sha(gz), taille: gz.length }],
    fichiers: [{ chemin: 'ok.txt', sha256: sha('ok'), taille: 2 }],
  });
}

test('aller-retour : archive découpée en morceaux puis extraite à l’identique', async (t) => {
  const { manifeste, dossierMorceaux, source, chemins } = await publier(t);
  assert.ok(manifeste.morceaux.length > 2, 'plusieurs morceaux attendus');
  assert.ok(manifeste.morceaux.slice(0, -1).every((m) => m.taille === 1000));
  assert.deepEqual(manifeste.fichiers.map((f) => f.chemin), [...chemins].sort());
  const dest = path.join(dossierTemp(t, 'dest'), 'pret');
  await extraireArchive({ dossierMorceaux, manifeste, destination: dest });
  for (const c of chemins) {
    const a = fs.readFileSync(path.join(source, ...c.split('/')));
    const b = fs.readFileSync(path.join(dest, ...c.split('/')));
    assert.ok(a.equals(b), c);
  }
  await verifierArbre(dest, manifeste);
});

test('archive déterministe : même arbre, mêmes empreintes', async (t) => {
  const source = dossierTemp(t, 'src');
  const chemins = arbreSource(source);
  const a = await ecrireArchive({ racine: source, chemins, dossierSortie: dossierTemp(t), tailleMorceau: 40 * 1024 * 1024 });
  const b = await ecrireArchive({ racine: source, chemins: [...chemins].reverse(), dossierSortie: dossierTemp(t) });
  assert.equal(a.archive.sha256, b.archive.sha256);
  assert.equal(a.morceaux.length, 1);
  assert.equal(a.morceaux[0].nom, 'paquet.tar.gz.000');
});

test('morceau corrompu : détecté, rien n’est extrait', async (t) => {
  const { manifeste, dossierMorceaux } = await publier(t);
  const cible = path.join(dossierMorceaux, manifeste.morceaux[1].nom);
  const octets = fs.readFileSync(cible);
  octets[100] ^= 0xff;
  fs.writeFileSync(cible, octets);
  fs.unlinkSync(path.join(dossierMorceaux, manifeste.morceaux[2].nom));
  const { invalides, valides } = await verifierMorceaux(dossierMorceaux, manifeste);
  assert.deepEqual(invalides, [
    { nom: manifeste.morceaux[1].nom, raison: 'EMPREINTE' },
    { nom: manifeste.morceaux[2].nom, raison: 'ABSENT' },
  ]);
  assert.ok(valides.includes(manifeste.morceaux[0].nom));
  const dest = path.join(dossierTemp(t, 'dest'), 'pret');
  await assert.rejects(extraireArchive({ dossierMorceaux, manifeste, destination: dest }), { code: 'MORCEAU_CORROMPU' });
  assert.equal(fs.existsSync(dest), false);
});

test('morceau tronqué : taille refusée', async (t) => {
  const { manifeste, dossierMorceaux } = await publier(t);
  const cible = path.join(dossierMorceaux, manifeste.morceaux[0].nom);
  fs.truncateSync(cible, 10);
  const { invalides } = await verifierMorceaux(dossierMorceaux, manifeste);
  assert.deepEqual(invalides, [{ nom: manifeste.morceaux[0].nom, raison: 'TAILLE' }]);
});

test('fichier extrait différent du manifeste : refusé et nettoyé', async (t) => {
  const { manifeste, dossierMorceaux } = await publier(t);
  // manifeste « signé » qui annonce une autre empreinte pour un fichier
  const fichiers = manifeste.fichiers.map((f) => (f.chemin === 'VERSION.json' ? { ...f, sha256: sha('autre') } : f));
  const dest = path.join(dossierTemp(t, 'dest'), 'pret');
  await assert.rejects(extraireArchive({ dossierMorceaux, manifeste: { ...manifeste, fichiers }, destination: dest }), {
    code: 'FICHIER_CORROMPU',
  });
  assert.equal(fs.existsSync(dest), false);
});

test('fichier absent de l’archive ou en trop : refusé', async (t) => {
  const { manifeste, dossierMorceaux } = await publier(t);
  const enPlus = [...manifeste.fichiers, { chemin: 'manquant.txt', sha256: sha(''), taille: 0 }];
  await assert.rejects(
    extraireArchive({ dossierMorceaux, manifeste: { ...manifeste, fichiers: enPlus }, destination: path.join(dossierTemp(t), 'p') }),
    { code: 'FICHIER_MANQUANT' },
  );
  const enMoins = manifeste.fichiers.filter((f) => f.chemin !== 'VERSION.json');
  await assert.rejects(
    extraireArchive({ dossierMorceaux, manifeste: { ...manifeste, fichiers: enMoins }, destination: path.join(dossierTemp(t), 'p') }),
    { code: 'FICHIER_INATTENDU' },
  );
});

test('destination non vide : refusée', async (t) => {
  const { manifeste, dossierMorceaux } = await publier(t);
  const dest = dossierTemp(t, 'dest');
  fs.writeFileSync(path.join(dest, 'deja.txt'), 'x');
  await assert.rejects(extraireArchive({ dossierMorceaux, manifeste, destination: dest }), { code: 'DESTINATION_OCCUPEE' });
  assert.ok(fs.existsSync(path.join(dest, 'deja.txt')), 'le dossier existant n’est pas touché');
});

const pieges = [
  ['chemin « .. »', [{ chemin: '../hors.txt', contenu: 'x' }], 'CHEMIN_INTERDIT'],
  ['chemin « .. » au milieu', [{ chemin: 'a/../../hors.txt', contenu: 'x' }], 'CHEMIN_INTERDIT'],
  ['chemin absolu', [{ chemin: '/etc/hors.txt', contenu: 'x' }], 'CHEMIN_INTERDIT'],
  ['lecteur Windows', [{ chemin: 'C:/hors.txt', contenu: 'x' }], 'CHEMIN_INTERDIT'],
  ['lien symbolique', [{ chemin: 'lien', type: '2', lien: '../../Windows' }], 'LIEN_INTERDIT'],
  ['lien dur', [{ chemin: 'lien', type: '1', lien: 'ok.txt' }], 'LIEN_INTERDIT'],
  ['périphérique', [{ chemin: 'dev', type: '3' }], 'TYPE_INTERDIT'],
  ['en-tête pax', [{ chemin: 'pax', type: 'x', contenu: '30 path=../../hors.txt\n' }], 'TYPE_INTERDIT'],
  ['fichier hors manifeste', [{ chemin: 'intrus.js', contenu: 'x' }], 'FICHIER_INATTENDU'],
  ['fichier en double', [{ chemin: 'ok.txt', contenu: 'ok' }, { chemin: 'ok.txt', contenu: 'ok' }], 'FICHIER_EN_DOUBLE'],
];
for (const [nom, entrees, code] of pieges) {
  test(`archive piégée (${nom}) : refusée, rien ne sort du dossier`, async (t) => {
    const racine = dossierTemp(t, 'piege');
    const dossierMorceaux = path.join(racine, 'morceaux');
    fs.mkdirSync(dossierMorceaux);
    const manifeste = archivePiegee(dossierMorceaux, entrees);
    const dest = path.join(racine, 'pret');
    await assert.rejects(extraireArchive({ dossierMorceaux, manifeste, destination: dest }), { code });
    assert.equal(fs.existsSync(dest), false);
    assert.equal(fs.existsSync(path.join(racine, 'hors.txt')), false);
  });
}

test('en-tête altéré : somme de contrôle refusée', async (t) => {
  const racine = dossierTemp(t, 'piege');
  const entete = _enteteFichier('ok.txt', 2, 0);
  entete[0] = 'X'.charCodeAt(0); // nom modifié sans recalculer la somme
  const gz = zlib.gzipSync(Buffer.concat([entete, Buffer.from('ok'), Buffer.alloc(510 + 1024)]));
  fs.writeFileSync(path.join(racine, 'p.tar.gz.000'), gz);
  const manifeste = manifesteApp({
    archive: { sha256: sha(gz), taille: gz.length },
    morceaux: [{ nom: 'p.tar.gz.000', sha256: sha(gz), taille: gz.length }],
    fichiers: [{ chemin: 'ok.txt', sha256: sha('ok'), taille: 2 }],
  });
  await assert.rejects(extraireArchive({ dossierMorceaux: racine, manifeste, destination: path.join(racine, 'pret') }), {
    code: 'ARCHIVE_INVALIDE',
  });
});

test('archive tronquée (sans fin) : refusée', async (t) => {
  const racine = dossierTemp(t, 'piege');
  const gz = zlib.gzipSync(Buffer.concat([_enteteFichier('ok.txt', 2, 0), Buffer.from('ok'), Buffer.alloc(510)]));
  fs.writeFileSync(path.join(racine, 'p.tar.gz.000'), gz);
  const manifeste = manifesteApp({
    archive: { sha256: sha(gz), taille: gz.length },
    morceaux: [{ nom: 'p.tar.gz.000', sha256: sha(gz), taille: gz.length }],
    fichiers: [{ chemin: 'ok.txt', sha256: sha('ok'), taille: 2 }],
  });
  await assert.rejects(extraireArchive({ dossierMorceaux: racine, manifeste, destination: path.join(racine, 'pret') }), {
    code: 'ARCHIVE_TRONQUEE',
  });
});

test('écriture : chemin dangereux et lien symbolique de la source refusés', async (t) => {
  const source = dossierTemp(t, 'src');
  fs.writeFileSync(path.join(source, 'a.txt'), 'a');
  await assert.rejects(ecrireArchive({ racine: source, chemins: ['../a.txt'], dossierSortie: dossierTemp(t) }), { code: 'CHEMIN_INTERDIT' });
  try {
    fs.symlinkSync(path.join(source, 'a.txt'), path.join(source, 'lien.txt'), 'file');
  } catch {
    t.diagnostic('liens symboliques non autorisés sur ce Windows : partie du test sautée');
    return;
  }
  await assert.rejects(ecrireArchive({ racine: source, chemins: ['lien.txt'], dossierSortie: dossierTemp(t) }), { code: 'LIEN_INTERDIT' });
});

test('revérification de l’arbre préparé : modification, ajout, suppression détectés', async (t) => {
  const { manifeste, dossierMorceaux } = await publier(t);
  const dest = path.join(dossierTemp(t, 'dest'), 'pret');
  await extraireArchive({ dossierMorceaux, manifeste, destination: dest });

  fs.mkdirSync(path.join(dest, 'node_modules'));
  fs.writeFileSync(path.join(dest, 'node_modules', 'x.js'), 'x');
  await assert.rejects(verifierArbre(dest, manifeste), { code: 'FICHIER_INATTENDU' });
  await verifierArbre(dest, manifeste, { ignorer: ['node_modules'] });

  fs.writeFileSync(path.join(dest, 'VERSION.json'), '{"numero":43}');
  await assert.rejects(verifierArbre(dest, manifeste, { ignorer: ['node_modules'] }), { code: 'FICHIER_CORROMPU' });
  fs.unlinkSync(path.join(dest, 'VERSION.json'));
  await assert.rejects(verifierArbre(dest, manifeste, { ignorer: ['node_modules'] }), { code: 'FICHIER_MANQUANT' });
});
