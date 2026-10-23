// Edge Function `maj` — mise à jour à distance des postes, côté SITE.
//
// Contrat : docs/MAJ_CONTRAT.md § 2 (actions `consulter` et `rapporter`).
// Authentifiée par la CLÉ DE SITE, comme `ordres` : c'est le serveur du site
// qui vient demander s'il y a une version pour lui (toutes les 15 min), jamais
// le cloud qui pousse — un mini-PC derrière la box d'un restaurant n'est pas
// joignable de l'extérieur.
//
// Ce que cette fonction NE fait PAS, délibérément : vérifier la signature des
// paquets. Le site et le lanceur la vérifient avec LEUR clé publique ; un
// contrôle ici ne protégerait de rien (un cloud compromis le sauterait) et
// donnerait une fausse impression de sécurité. Le cloud se contente de dire
// QUELLE version servir et de signer des URL de téléchargement d'une heure.
//
// Toute la logique de choix est dans `_shared/maj-cible.ts` (testée sous Node).
import { clientAdmin, ErreurAuth, json, verifierCleSite } from '../_shared/auth.ts';
import {
  BUCKET_PAQUETS,
  cibleAServir,
  cibleDuSite,
  dossierDependances,
  dossierVersion,
  DUREE_URL_SECONDES,
  estTableAbsente,
  lireRapport,
  numeroInstalle,
  numeroLanceur,
  reglagesContrat,
  reglagesDuSite,
  type VersionResumee,
} from '../_shared/maj-cible.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

class MigrationAbsente extends Error {}

/** URL signées (1 h) pour les morceaux d'un paquet, dans l'ordre du manifeste. */
async function urlsMorceaux(
  admin: SupabaseClient,
  dossier: string,
  morceaux: { nom: string }[],
): Promise<{ nom: string; url: string }[]> {
  const chemins = morceaux.map((m) => `${dossier}/${m.nom}`);
  const { data, error } = await admin.storage.from(BUCKET_PAQUETS).createSignedUrls(chemins, DUREE_URL_SECONDES);
  if (error || !data) throw new Error('Signature des liens de téléchargement impossible');
  return morceaux.map((m, i) => {
    const signe = data[i];
    if (!signe || signe.error || !signe.signedUrl) throw new Error(`Morceau introuvable dans le stockage : ${m.nom}`);
    return { nom: m.nom, url: signe.signedUrl };
  });
}

async function consulter(admin: SupabaseClient, restaurantId: string, corps: Record<string, unknown>): Promise<Response> {
  const installe = numeroInstalle(corps.installee);
  const lanceur = numeroLanceur(corps.lanceur_numero);

  // Trace de consultation, au mieux : sert au siège à voir qu'un site interroge
  // bien le cloud (et avec quel lanceur) même s'il n'a rien à installer.
  // UPDATE et non UPSERT : créer la ligne ferait passer `recu_le` (l'heure du
  // dernier battement) pour une descente qui n'a pas eu lieu.
  try {
    await admin
      .from('sites_sante')
      .update({ maj_lanceur_numero: lanceur, maj_consulte_le: new Date().toISOString() })
      .eq('restaurant_id', restaurantId);
  } catch {
    // Colonnes absentes (migration pas passée) : sans conséquence.
  }

  let reglages;
  let versions: VersionResumee[];
  try {
    const [r, v] = await Promise.all([
      admin.from('maj_reglages_site').select('*').eq('restaurant_id', restaurantId).maybeSingle(),
      admin
        .from('maj_versions')
        .select('numero, version, statut, pilote_le, generale_le, fichiers_purges_le')
        .in('statut', ['PILOTE', 'GENERALE']),
    ]);
    if (r.error) throw estTableAbsente(r.error) ? new MigrationAbsente() : new Error('Lecture des réglages impossible');
    if (v.error) throw estTableAbsente(v.error) ? new MigrationAbsente() : new Error('Lecture des versions impossible');
    reglages = reglagesDuSite(r.data);
    versions = (v.data ?? []) as VersionResumee[];
  } catch (e) {
    // Contrat § 2 : tables absentes → défauts, jamais une erreur.
    if (e instanceof MigrationAbsente) {
      return json({ cible: null, reglages: reglagesContrat(reglagesDuSite(null)), migration_absente: true });
    }
    throw e;
  }

  const cible = cibleAServir(cibleDuSite(versions, reglages), installe);
  if (!cible) return json({ cible: null, reglages: reglagesContrat(reglages), migration_absente: false });

  const { data: ligne, error } = await admin
    .from('maj_versions')
    .select('numero, version, manifeste, signature, morceaux, dependances_empreinte')
    .eq('numero', cible.numero)
    .maybeSingle();
  if (error || !ligne) throw new Error('Lecture de la version cible impossible');

  // Toujours renvoyées quand le paquet existe (contrat § 2) : c'est le site qui
  // compare avec `node_modules/.empreinte-deps` et décide de télécharger.
  // Pas de paquet publié pour cette empreinte : `null` — le pnpm-lock.yaml n'a
  // pas changé depuis que les sites ont leurs dépendances.
  let dependances = null;
  const { data: deps, error: errDeps } = await admin
    .from('maj_dependances')
    .select('empreinte, manifeste, signature, morceaux, fichiers_purges_le')
    .eq('empreinte', ligne.dependances_empreinte)
    .maybeSingle();
  if (errDeps && !estTableAbsente(errDeps)) throw new Error('Lecture des dépendances impossible');
  if (deps && !deps.fichiers_purges_le) {
    dependances = {
      empreinte: deps.empreinte as string,
      manifeste: deps.manifeste as string,
      signature: deps.signature as string,
      morceaux: await urlsMorceaux(admin, dossierDependances(deps.empreinte as string), deps.morceaux as { nom: string }[]),
    };
  }

  return json({
    cible: {
      numero: Number(ligne.numero),
      version: ligne.version as string,
      manifeste: ligne.manifeste as string,
      signature: ligne.signature as string,
      morceaux: await urlsMorceaux(admin, dossierVersion(Number(ligne.numero)), ligne.morceaux as { nom: string }[]),
      dependances,
    },
    reglages: reglagesContrat(reglages),
    migration_absente: false,
  });
}

async function rapporter(admin: SupabaseClient, restaurantId: string, corps: Record<string, unknown>): Promise<Response> {
  const rapport = lireRapport(corps);
  if ('erreur' in rapport) return json({ erreur: rapport.erreur }, 400);
  const { error } = await admin.from('maj_rapports').insert({
    restaurant_id: restaurantId,
    numero: rapport.numero,
    evenement: rapport.evenement,
    detail: rapport.detail,
  });
  if (error) {
    // Migration pas encore passée : le compte rendu est perdu, mais le site ne
    // doit pas boucler dessus. On le dit dans la réponse, sans erreur.
    if (estTableAbsente(error)) return json({ ok: true, migration_absente: true });
    throw new Error('Enregistrement du compte rendu impossible');
  }
  return json({ ok: true });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ erreur: 'Méthode non autorisée' }, 405);
  const admin = clientAdmin();

  let restaurantId: string;
  let corps: Record<string, unknown>;
  try {
    corps = await req.json();
    restaurantId = await verifierCleSite(admin, corps.cle_site);
  } catch (e) {
    if (e instanceof ErreurAuth) return json({ erreur: e.message }, 401);
    return json({ erreur: 'Requête invalide' }, 400);
  }

  try {
    const action = String(corps.action ?? '');
    if (action === 'consulter') return await consulter(admin, restaurantId, corps);
    if (action === 'rapporter') return await rapporter(admin, restaurantId, corps);
    return json({ erreur: `Action inconnue : ${action}` }, 400);
  } catch (e) {
    return json({ erreur: e instanceof Error ? e.message : 'Erreur interne' }, 500);
  }
});
