// Actions `maj_*` de la console du siège — mise à jour à distance des postes.
//
// Rangées à part de index.ts (déjà long) mais appelées par son `switch`, avec
// la même authentification et le même journal `siege_audit`.
//
// Droits (plan § 4 et décision du 23/10/2026) :
//   * LECTURE  : voit (maj_historique) ;
//   * ADMIN    : règle les sites (heure, type, anneau, pause, épinglage,
//                « installer maintenant », « réessayer ») ;
//   * PROPRIÉTAIRE (ADMIN + drapeau `proprietaire`) : publie, promeut, retire.
// Publier exige EN PLUS la clé privée hors ligne : le cloud n'accepte qu'un
// manifeste dont la signature est valide pour MAJ_CLE_PUBLIQUE. Un compte
// siège compromis ne peut donc que cibler des versions déjà signées.
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { exigeAdmin, exigeProprietaire, jsonCors, type Siege } from '../_shared/auth.ts';
import {
  BUCKET_PAQUETS,
  cibleDuSite,
  dossierDependances,
  dossierVersion,
  estTableAbsente,
  FICHIER_MANIFESTE,
  FICHIER_SIGNATURE,
  reglagesDuSite,
  type Cible,
  type LigneReglages,
  type StatutVersion,
  type VersionResumee,
} from '../_shared/maj-cible.ts';
import { ErreurCle, octetsClePublique, empreinteCle, verifierAvecTrousseau } from '../_shared/maj-signature.ts';
import {
  ErreurPaquet,
  lireManifestePublie,
  lireModificationReglages,
  nomFichierValide,
  numeroCorrespond,
  piloteRestantMs,
  problemesObjets,
  transitionPermise,
  versionsAPurger,
} from '../_shared/maj-siege.ts';
import { uuidValide } from '../_shared/siege-recettes.ts';

export type Tracer = (
  action: string,
  details: { entite?: string; entiteId?: string; portee?: string[]; meta?: unknown },
) => Promise<void>;

const RE_SHA256 = /^[0-9a-f]{64}$/;
/** Morceaux + manifeste + signature : la limite du manifeste L0 (2000 morceaux) et deux de plus. */
const FICHIERS_MAX = 2002;

/** Colonnes légères d'une version (sans le manifeste, qui peut peser lourd). */
const COLONNES_VERSION =
  'numero, version, commit_git, statut, taille_octets, dependances_empreinte, lanceur_min, migrations, notes, cle_empreinte, publie_le, publie_par, pilote_le, generale_le, retiree_le, retiree_motif, fichiers_purges_le';

/** Le trousseau du cloud, depuis les secrets de la fonction. */
function trousseau(): { actuelle: string; suivante: string | null } {
  return {
    actuelle: Deno.env.get('MAJ_CLE_PUBLIQUE') ?? '',
    suivante: Deno.env.get('MAJ_CLE_PUBLIQUE_SUIVANTE') ?? null,
  };
}

/** Destination d'un paquet dans le bucket, depuis le corps de la requête. */
function lireDestination(
  corps: Record<string, unknown>,
): { type: 'APP'; numero: number; dossier: string } | { type: 'DEPENDANCES'; empreinte: string; dossier: string } | { erreur: string } {
  if (corps.type === 'APP') {
    const n = corps.numero;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) return { erreur: 'Numéro de version invalide' };
    return { type: 'APP', numero: n, dossier: dossierVersion(n) };
  }
  if (corps.type === 'DEPENDANCES') {
    const e = String(corps.empreinte ?? '');
    if (!RE_SHA256.test(e)) return { erreur: 'Empreinte de dépendances invalide' };
    return { type: 'DEPENDANCES', empreinte: e, dossier: dossierDependances(e) };
  }
  return { erreur: 'Type de paquet invalide (APP ou DEPENDANCES)' };
}

/**
 * Le bucket doit exister et rester PRIVÉ. La migration le crée ; on le recrée
 * au besoin (projet où la migration a été passée sans le schéma storage),
 * mais on REFUSE d'écrire dans un bucket devenu public : les paquets y seraient
 * téléchargeables par n'importe qui connaissant le chemin.
 */
async function bucketPrive(admin: SupabaseClient): Promise<void> {
  const { data } = await admin.storage.getBucket(BUCKET_PAQUETS);
  if (data) {
    if (data.public) throw new Error('Le stockage des paquets est PUBLIC : rendez le bucket « paquets-pos » privé avant de publier');
    return;
  }
  const { error } = await admin.storage.createBucket(BUCKET_PAQUETS, { public: false, fileSizeLimit: 50 * 1024 * 1024 });
  if (error && !/exist/i.test(error.message)) throw new Error(`Espace de stockage indisponible : ${error.message}`);
}

async function lireObjet(admin: SupabaseClient, chemin: string): Promise<Uint8Array | null> {
  const { data, error } = await admin.storage.from(BUCKET_PAQUETS).download(chemin);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

/** Objets d'un dossier du bucket, avec leur taille (paginé). */
async function listerObjets(admin: SupabaseClient, dossier: string): Promise<{ name: string; taille: number | null }[]> {
  const out: { name: string; taille: number | null }[] = [];
  for (let offset = 0; offset < 10_000; offset += 1000) {
    const { data, error } = await admin.storage.from(BUCKET_PAQUETS).list(dossier, { limit: 1000, offset });
    if (error) throw new Error('Lecture du stockage impossible');
    for (const o of data ?? []) {
      const taille = (o.metadata as { size?: unknown } | null)?.size;
      out.push({ name: o.name, taille: typeof taille === 'number' ? taille : null });
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** Plus haut numéro déjà enregistré (0 si aucun). */
async function numeroMax(admin: SupabaseClient): Promise<number> {
  const { data, error } = await admin.from('maj_versions').select('numero').order('numero', { ascending: false }).limit(1);
  if (error) throw new Error(estTableAbsente(error) ? 'Migration de mise à jour à distance pas encore appliquée' : 'Lecture des versions impossible');
  return data && data.length ? Number(data[0].numero) : 0;
}

/**
 * La cible de chaque site enrôlé, avec ses réglages. `null` si les tables
 * manquent (migration pas passée) : la Santé des sites s'affiche sans.
 */
export async function ciblesParSite(
  admin: SupabaseClient,
): Promise<Map<string, { cible: Cible | null; reglages: LigneReglages }> | null> {
  const [sites, versions, reglages] = await Promise.all([
    admin.from('sites_autorises').select('restaurant_id'),
    admin.from('maj_versions').select('numero, version, statut, pilote_le, generale_le, fichiers_purges_le'),
    admin.from('maj_reglages_site').select('*'),
  ]);
  if (sites.error || versions.error || reglages.error) return null;
  type Brute = LigneReglages & { installer_maintenant_le?: string | null; reessayer_le?: string | null; maj_par?: string | null };
  const parSite = new Map(((reglages.data ?? []) as Brute[]).map((r) => [r.restaurant_id as string, r]));
  const out = new Map<string, { cible: Cible | null; reglages: LigneReglages }>();
  for (const s of (sites.data ?? []) as { restaurant_id: string }[]) {
    const brute = parSite.get(s.restaurant_id) ?? null;
    // Les dates des jetons et l'auteur du dernier réglage ne servent qu'à
    // l'affichage : on les garde à côté des réglages normalisés.
    const r = {
      ...reglagesDuSite(brute),
      installer_maintenant_le: brute?.installer_maintenant_le ?? null,
      reessayer_le: brute?.reessayer_le ?? null,
      maj_par: brute?.maj_par ?? null,
    };
    out.set(s.restaurant_id, { cible: cibleDuSite((versions.data ?? []) as VersionResumee[], r), reglages: r });
  }
  return out;
}

/**
 * Rétention du bucket : efface les morceaux des versions sorties des 3
 * dernières et qui ne sont la cible d'aucun site, puis les paquets de
 * dépendances qu'aucune version restante n'utilise. Au mieux : un échec ici
 * ne doit pas défaire la promotion qui l'a déclenchée.
 */
async function purgerAnciennes(admin: SupabaseClient): Promise<number[]> {
  const cibles = await ciblesParSite(admin);
  if (!cibles) return [];
  const { data: versions } = await admin.from('maj_versions').select('numero, dependances_empreinte, fichiers_purges_le');
  if (!versions) return [];
  const aGarder = [...cibles.values()].flatMap((c) => [c.cible?.numero, c.reglages.version_epinglee]).filter((n): n is number => !!n);
  const purgees: number[] = [];
  for (const numero of versionsAPurger(versions as { numero: number }[], aGarder)) {
    const dossier = dossierVersion(numero);
    const objets = await listerObjets(admin, dossier);
    if (objets.length) {
      const { error } = await admin.storage.from(BUCKET_PAQUETS).remove(objets.map((o) => `${dossier}/${o.name}`));
      if (error) continue;
    }
    await admin.from('maj_versions').update({ fichiers_purges_le: new Date().toISOString() }).eq('numero', numero);
    purgees.push(numero);
  }
  // Dépendances : gardées tant qu'une version non purgée y renvoie.
  const utiles = new Set(
    (versions as { numero: number; dependances_empreinte: string; fichiers_purges_le: string | null }[])
      .filter((v) => !v.fichiers_purges_le && !purgees.includes(Number(v.numero)))
      .map((v) => v.dependances_empreinte),
  );
  const { data: deps } = await admin.from('maj_dependances').select('empreinte, fichiers_purges_le').is('fichiers_purges_le', null);
  for (const d of (deps ?? []) as { empreinte: string }[]) {
    if (utiles.has(d.empreinte)) continue;
    const dossier = dossierDependances(d.empreinte);
    const objets = await listerObjets(admin, dossier);
    if (objets.length) {
      const { error } = await admin.storage.from(BUCKET_PAQUETS).remove(objets.map((o) => `${dossier}/${o.name}`));
      if (error) continue;
    }
    await admin.from('maj_dependances').update({ fichiers_purges_le: new Date().toISOString() }).eq('empreinte', d.empreinte);
  }
  return purgees;
}

/**
 * Point d'entrée depuis le `switch` de index.ts. Renvoie `null` si l'action
 * n'est pas une action `maj_*` connue.
 */
export async function actionMaj(
  admin: SupabaseClient,
  siege: Siege,
  action: string,
  corps: Record<string, unknown>,
  tracer: Tracer,
): Promise<Response | null> {
  switch (action) {
    // -- Préparer l'envoi d'un paquet : une URL de téléversement signée par
    // -- fichier (manifeste, signature, morceaux). Comme `photo_signer`, le
    // -- fichier ne transite PAS par la fonction — 40 Mo par morceau.
    case 'maj_preparer_envoi': {
      exigeProprietaire(siege);
      const dest = lireDestination(corps);
      if ('erreur' in dest) return jsonCors({ erreur: dest.erreur }, 400);
      const fichiers = corps.fichiers;
      if (!Array.isArray(fichiers) || fichiers.length < 3 || fichiers.length > FICHIERS_MAX) {
        return jsonCors({ erreur: 'Liste de fichiers invalide' }, 400);
      }
      if (!fichiers.every(nomFichierValide) || new Set(fichiers).size !== fichiers.length) {
        return jsonCors({ erreur: 'Nom de fichier invalide ou en double' }, 400);
      }
      if (!fichiers.includes(FICHIER_MANIFESTE) || !fichiers.includes(FICHIER_SIGNATURE)) {
        return jsonCors({ erreur: 'Le manifeste et sa signature doivent faire partie de l’envoi' }, 400);
      }

      // Un numéro ne resert jamais, et ne recule jamais (plan § 2).
      if (dest.type === 'APP') {
        const max = await numeroMax(admin);
        if (dest.numero <= max) {
          return jsonCors({ erreur: `Le numéro ${dest.numero} est déjà pris ou dépassé (dernier : ${max})` }, 409);
        }
      } else {
        const { data } = await admin.from('maj_dependances').select('empreinte').eq('empreinte', dest.empreinte).maybeSingle();
        if (data) return jsonCors({ erreur: 'Ce paquet de dépendances est déjà publié' }, 409);
      }

      await bucketPrive(admin);
      const sortie: { nom: string; chemin: string; url: string; jeton: string }[] = [];
      for (const nom of fichiers as string[]) {
        // `upsert` : un envoi interrompu se relance sans renuméroter. Sans
        // risque — la version n'est servie à personne avant `maj_enregistrer`,
        // qui revérifie la signature sur ce qui est réellement stocké.
        const { data, error } = await admin.storage
          .from(BUCKET_PAQUETS)
          .createSignedUploadUrl(`${dest.dossier}/${nom}`, { upsert: true });
        if (error || !data) throw new Error(`Impossible de préparer l’envoi de ${nom}`);
        sortie.push({ nom, chemin: data.path, url: data.signedUrl, jeton: data.token });
      }
      await tracer('MAJ_PREPARER_ENVOI', {
        entite: dest.type === 'APP' ? 'maj_versions' : 'maj_dependances',
        entiteId: dest.type === 'APP' ? String(dest.numero) : dest.empreinte,
        meta: { fichiers: fichiers.length },
      });
      return jsonCors({ bucket: BUCKET_PAQUETS, dossier: dest.dossier, fichiers: sortie });
    }

    // -- Enregistrer un paquet téléversé. Tout est relu DANS LE STOCKAGE, pas
    // -- dans la requête : c'est ce qui y est qui sera servi aux sites.
    case 'maj_enregistrer': {
      exigeProprietaire(siege);
      const dest = lireDestination(corps);
      if ('erreur' in dest) return jsonCors({ erreur: dest.erreur }, 400);

      const cles = trousseau();
      if (!cles.actuelle.trim()) {
        return jsonCors({ erreur: 'Clé publique de mise à jour non configurée (secret MAJ_CLE_PUBLIQUE de la fonction siege)' }, 500);
      }
      const octets = await lireObjet(admin, `${dest.dossier}/${FICHIER_MANIFESTE}`);
      const sigOctets = await lireObjet(admin, `${dest.dossier}/${FICHIER_SIGNATURE}`);
      if (!octets || !sigOctets) return jsonCors({ erreur: 'Manifeste ou signature absent du stockage : relancez l’envoi' }, 400);
      const signature = new TextDecoder().decode(sigOctets).trim();

      let verif;
      try {
        verif = await verifierAvecTrousseau(octets, signature, cles);
      } catch (e) {
        if (e instanceof ErreurCle) return jsonCors({ erreur: `Secret MAJ_CLE_PUBLIQUE invalide : ${e.message}` }, 500);
        throw e;
      }
      if (!verif) {
        await tracer('MAJ_SIGNATURE_REFUSEE', {
          entite: dest.type === 'APP' ? 'maj_versions' : 'maj_dependances',
          entiteId: dest.type === 'APP' ? String(dest.numero) : dest.empreinte,
        });
        return jsonCors({ erreur: 'Signature invalide : ce paquet n’est pas signé par la clé de mise à jour du groupe' }, 400);
      }

      let m;
      try {
        m = lireManifestePublie(octets, dest.type === 'APP' ? { type: 'APP', numero: dest.numero } : { type: 'DEPENDANCES', empreinte: dest.empreinte });
      } catch (e) {
        if (e instanceof ErreurPaquet) return jsonCors({ erreur: e.message }, 400);
        throw e;
      }
      if (m.type === 'APP' && !numeroCorrespond(dest.type === 'APP' ? dest.numero : 0, m.version ?? '')) {
        return jsonCors({ erreur: 'Le numéro ne correspond pas à la version (AAAAMMJJnn ↔ AAAA.MM.JJ-n)' }, 400);
      }
      const problemes = problemesObjets(m.morceaux, await listerObjets(admin, dest.dossier));
      if (problemes.length) return jsonCors({ erreur: `Envoi incomplet : ${problemes.slice(0, 5).join(' ; ')}` }, 400);

      const manifesteTexte = new TextDecoder('utf-8', { fatal: true }).decode(octets);
      const commun = {
        manifeste: manifesteTexte,
        signature,
        cle_empreinte: verif.empreinte,
        morceaux: m.morceaux,
        taille_octets: m.taille_octets,
        publie_par: siege.nomComplet,
        publie_par_id: siege.userId,
      };

      if (dest.type === 'DEPENDANCES') {
        const { error } = await admin.from('maj_dependances').insert({ empreinte: dest.empreinte, ...commun });
        if (error) throw new Error(`Enregistrement impossible : ${error.message}`);
        await tracer('MAJ_PUBLIER_DEPENDANCES', {
          entite: 'maj_dependances',
          entiteId: dest.empreinte,
          meta: { taille_octets: m.taille_octets, cle: verif.cle, cle_empreinte: verif.empreinte },
        });
        return jsonCors({ ok: true, empreinte: dest.empreinte, cle: verif.cle });
      }

      const max = await numeroMax(admin);
      if (dest.numero <= max) return jsonCors({ erreur: `Le numéro ${dest.numero} est déjà pris ou dépassé (dernier : ${max})` }, 409);
      const { error } = await admin.from('maj_versions').insert({
        numero: dest.numero,
        version: m.version,
        commit_git: m.commit,
        statut: 'BROUILLON',
        dependances_empreinte: m.dependances_empreinte,
        lanceur_min: m.lanceur_min,
        migrations: m.migrations,
        notes: m.notes,
        ...commun,
      });
      if (error) throw new Error(`Enregistrement impossible : ${error.message}`);

      // Pas de paquet pour cette empreinte : normal si le pnpm-lock.yaml n'a pas
      // bougé depuis le dernier paquet de dépendances des sites. On le signale.
      const { data: deps } = await admin.from('maj_dependances').select('empreinte').eq('empreinte', m.dependances_empreinte).maybeSingle();
      await tracer('MAJ_PUBLIER', {
        entite: 'maj_versions',
        entiteId: String(dest.numero),
        meta: { version: m.version, commit: m.commit, cle: verif.cle, cle_empreinte: verif.empreinte, dependances: m.dependances_empreinte },
      });
      return jsonCors({
        ok: true,
        numero: dest.numero,
        version: m.version,
        statut: 'BROUILLON',
        cle: verif.cle,
        avertissement: deps
          ? null
          : `Aucun paquet de dépendances publié pour l’empreinte ${m.dependances_empreinte?.slice(0, 12)}… : les sites doivent déjà avoir ces dépendances.`,
      });
    }

    case 'maj_promouvoir': {
      exigeProprietaire(siege);
      const numero = Number(corps.numero);
      const vers = String(corps.vers ?? '') as StatutVersion;
      if (!Number.isSafeInteger(numero) || numero <= 0) return jsonCors({ erreur: 'Version non précisée' }, 400);
      const { data: v, error } = await admin.from('maj_versions').select('numero, version, statut, pilote_le').eq('numero', numero).maybeSingle();
      if (error) throw new Error('Lecture de la version impossible');
      if (!v) return jsonCors({ erreur: 'Version inconnue' }, 404);
      if (!transitionPermise(v.statut as StatutVersion, vers)) {
        return jsonCors({ erreur: `Passage ${v.statut} → ${vers} impossible (BROUILLON → PILOTE → GENERALE)` }, 409);
      }
      // Pilote de 48 h sur Angré 7E (décision du 23/10/2026) : la console
      // demande une confirmation explicite pour passer outre.
      const reste = vers === 'GENERALE' ? piloteRestantMs(v.pilote_le as string | null, new Date()) : 0;
      if (reste > 0 && corps.forcer !== true) {
        return jsonCors(
          {
            erreur: `Le pilote n’a pas encore tourné 48 h (reste ${Math.ceil(reste / 3_600_000)} h). Confirmez pour promouvoir quand même.`,
            pilote_restant_ms: reste,
          },
          409,
        );
      }
      const maintenant = new Date().toISOString();
      const { data: maj, error: e2 } = await admin
        .from('maj_versions')
        .update(vers === 'PILOTE' ? { statut: vers, pilote_le: maintenant } : { statut: vers, generale_le: maintenant })
        .eq('numero', numero)
        .eq('statut', v.statut)
        .select('numero');
      if (e2) throw new Error('Promotion impossible');
      if (!maj || maj.length === 0) return jsonCors({ erreur: 'La version a changé entre-temps : rechargez' }, 409);

      let purgees: number[] = [];
      try {
        purgees = await purgerAnciennes(admin);
      } catch {
        // La rétention attendra la prochaine promotion.
      }
      await tracer('MAJ_PROMOUVOIR', {
        entite: 'maj_versions',
        entiteId: String(numero),
        meta: { version: v.version, de: v.statut, vers, forcer: reste > 0, purgees },
      });
      return jsonCors({ ok: true, numero, statut: vers, purgees });
    }

    case 'maj_retirer': {
      exigeProprietaire(siege);
      const numero = Number(corps.numero);
      const motif = String(corps.motif ?? '').trim();
      if (!Number.isSafeInteger(numero) || numero <= 0) return jsonCors({ erreur: 'Version non précisée' }, 400);
      if (motif.length < 3) return jsonCors({ erreur: 'Le motif du retrait est obligatoire' }, 400);
      const { data, error } = await admin
        .from('maj_versions')
        .update({ statut: 'RETIREE', retiree_le: new Date().toISOString(), retiree_motif: motif.slice(0, 500) })
        .eq('numero', numero)
        .neq('statut', 'RETIREE')
        .select('numero, version');
      if (error) throw new Error('Retrait impossible');
      if (!data || data.length === 0) return jsonCors({ erreur: 'Version inconnue ou déjà retirée' }, 404);
      await tracer('MAJ_RETIRER', { entite: 'maj_versions', entiteId: String(numero), meta: { version: data[0].version, motif } });
      return jsonCors({ ok: true, numero, statut: 'RETIREE' });
    }

    // -- Réglages d'UN site. « Installer maintenant » et « réessayer » posent
    // -- chacun un jeton NEUF : le site agit une fois par jeton (contrat § 2).
    case 'maj_reglages_site': {
      exigeAdmin(siege);
      const restaurantId = corps.restaurant_id;
      if (!uuidValide(restaurantId)) return jsonCors({ erreur: 'Restaurant non précisé' }, 400);
      const modif = lireModificationReglages(corps.modifications);
      if ('erreur' in modif) return jsonCors({ erreur: modif.erreur }, 400);
      const installer = corps.installer_maintenant === true;
      const reessayer = corps.reessayer === true;
      if (!Object.keys(modif).length && !installer && !reessayer) return jsonCors({ erreur: 'Rien à modifier' }, 400);

      const { data: site } = await admin.from('sites_autorises').select('restaurant_id, code').eq('restaurant_id', restaurantId).maybeSingle();
      if (!site) return jsonCors({ erreur: 'Site inconnu (pas enrôlé)' }, 404);

      if (typeof modif.version_epinglee === 'number') {
        const { data: v } = await admin.from('maj_versions').select('statut').eq('numero', modif.version_epinglee).maybeSingle();
        if (!v || (v.statut !== 'PILOTE' && v.statut !== 'GENERALE')) {
          return jsonCors({ erreur: 'On ne peut épingler qu’une version pilote ou générale' }, 400);
        }
      }

      const { data: actuel, error: eLect } = await admin.from('maj_reglages_site').select('*').eq('restaurant_id', restaurantId).maybeSingle();
      if (eLect) throw new Error(estTableAbsente(eLect) ? 'Migration de mise à jour à distance pas encore appliquée' : 'Lecture des réglages impossible');
      const base = reglagesDuSite(actuel);
      const maintenant = new Date().toISOString();
      const ligne: Record<string, unknown> = {
        restaurant_id: restaurantId,
        type_site: base.type_site,
        heure_installation: base.heure_installation,
        heure_filet: base.heure_filet,
        anneau: base.anneau,
        pause: base.pause,
        version_epinglee: base.version_epinglee,
        ...modif,
        maj_le: maintenant,
        maj_par: siege.nomComplet,
      };
      if (installer) {
        ligne.installer_maintenant = crypto.randomUUID();
        ligne.installer_maintenant_le = maintenant;
      }
      if (reessayer) {
        ligne.reessayer = crypto.randomUUID();
        ligne.reessayer_le = maintenant;
      }
      const { data, error } = await admin.from('maj_reglages_site').upsert(ligne, { onConflict: 'restaurant_id' }).select('*').single();
      if (error) throw new Error(`Enregistrement des réglages impossible : ${error.message}`);
      await tracer('MAJ_REGLAGES_SITE', {
        entite: 'maj_reglages_site',
        entiteId: String(restaurantId),
        portee: [String(restaurantId)],
        meta: { code: site.code, modifications: modif, installer_maintenant: installer, reessayer },
      });
      return jsonCors({ reglages: data });
    }

    // -- Tout ce que l'écran « Mises à jour » affiche, en une requête.
    case 'maj_historique': {
      const filtre = corps.restaurant_id;
      if (filtre !== undefined && filtre !== null && filtre !== '' && !uuidValide(filtre)) {
        return jsonCors({ erreur: 'Restaurant invalide' }, 400);
      }
      let rapports = admin.from('maj_rapports').select('id, restaurant_id, numero, evenement, detail, recu_le').order('recu_le', { ascending: false }).limit(300);
      if (filtre) rapports = rapports.eq('restaurant_id', filtre);
      const [versions, deps, rap, sites, cibles] = await Promise.all([
        admin.from('maj_versions').select(COLONNES_VERSION).order('numero', { ascending: false }).limit(100),
        admin.from('maj_dependances').select('empreinte, taille_octets, publie_le, publie_par, fichiers_purges_le').order('publie_le', { ascending: false }).limit(20),
        rapports,
        admin.from('sites_autorises').select('restaurant_id, code, actif'),
        ciblesParSite(admin),
      ]);
      const absente = [versions.error, deps.error, rap.error].some((e) => estTableAbsente(e));
      if (!absente && (versions.error || deps.error || rap.error || sites.error)) throw new Error('Lecture des mises à jour impossible');

      // L'empreinte de la clé publique configurée : le propriétaire la compare
      // à celle que `generer-cle.mjs` lui a donnée et à celle du lanceur.
      let cle: string | null = null;
      try {
        const t = trousseau();
        if (t.actuelle.trim()) cle = await empreinteCle(octetsClePublique(t.actuelle));
      } catch {
        cle = 'invalide';
      }

      return jsonCors({
        migration_absente: absente,
        proprietaire: siege.proprietaire,
        cle_publique_empreinte: cle,
        versions: absente ? [] : versions.data ?? [],
        dependances: absente ? [] : deps.data ?? [],
        rapports: absente ? [] : rap.data ?? [],
        sites: ((sites.data ?? []) as { restaurant_id: string; code: string; actif: boolean }[]).map((s) => ({
          ...s,
          reglages: cibles?.get(s.restaurant_id)?.reglages ?? reglagesDuSite(null),
          cible: cibles?.get(s.restaurant_id)?.cible ?? null,
        })),
      });
    }

    default:
      return null;
  }
}
