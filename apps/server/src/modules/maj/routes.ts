/**
 * Routes de la mise à jour à distance (contrat § 5).
 *
 * Lanceur (localhost + jeton `POS_JETON_LANCEUR`, que seul le lanceur qui a
 * démarré ce serveur connaît) :
 * - `POST /api/maj/lanceur/arret`   : 503 « Mise à jour en cours » pour toute
 *   l'API, `maj_debut` aux caisses, réponse quand les requêtes en cours sont
 *   finies ;
 * - `POST /api/maj/lanceur/valider` : sortie du mode validation, démarrage
 *   des boucles, `maj_terminee`, compte rendu INSTALLE.
 *
 * Caisse :
 * - `GET  /api/sante/version` : version qui tourne (contrôle de santé du lanceur) ;
 * - `GET  /api/maj/etat`      : ce qu'affiche le bandeau ;
 * - `POST /api/maj/reporter`  : « Pas maintenant », PIN gérant, une seule fois.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { ErreurMetier } from '../../lib/erreurs.js';
import { valider } from '../../lib/valider.js';
import { journaliser } from '../audit/audit.js';
import { verifierPinManager } from '../auth/pin.js';
import { VERSION_DEMARREE, jetonLanceur } from './config.js';
import { etatMode } from './mode.js';
import { moteurMajCourant, type VueMaj } from './moteur.js';

const LOCALES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function exigerLanceur(req: FastifyRequest): void {
  const attendu = jetonLanceur();
  const recu = req.headers['x-jeton-lanceur'];
  const ok =
    attendu !== null &&
    typeof recu === 'string' &&
    recu.length === attendu.length &&
    timingSafeEqual(Buffer.from(recu), Buffer.from(attendu)) &&
    LOCALES.has(req.socket.remoteAddress ?? '');
  // 404 et non 403 : depuis le réseau, ces routes n'existent pas.
  if (!ok) throw new ErreurMetier('Page ou ressource introuvable', 404);
}

const ReporterSchema = z.object({ pin_manager: z.string().min(4, 'PIN gérant obligatoire') });

/** Vue quand le module est inactif (poste de développement) : rien à afficher. */
function vueInactive(): VueMaj {
  return {
    actif: false,
    mode: etatMode.mode,
    etat: 'A_JOUR',
    installee: { numero: VERSION_DEMARREE.numero, version: VERSION_DEMARREE.version },
    prete: null,
    decision: null,
  };
}

export function routesMaj(app: FastifyInstance): void {
  app.get('/api/sante/version', async () => ({
    numero: VERSION_DEMARREE.numero,
    version: VERSION_DEMARREE.version,
    commit: VERSION_DEMARREE.commit,
  }));

  app.post('/api/maj/lanceur/arret', async (req) => {
    exigerLanceur(req);
    const deja = etatMode.mode === 'ARRET';
    etatMode.mode = 'ARRET';
    if (!deja) {
      app.diffuser('maj_debut');
      moteurMajCourant()?.arreter();
      void moteurMajCourant()?.surArret().catch(() => {});
    }
    // La requête d'arrêt elle-même n'est pas comptée (route exemptée).
    const termine = await etatMode.attendreRequetesFinies(20_000);
    return { ok: true, requetes_terminees: termine };
  });

  app.post('/api/maj/lanceur/valider', async (req) => {
    exigerLanceur(req);
    if (etatMode.valider()) {
      app.diffuser('maj_terminee');
      void moteurMajCourant()?.surValidation().catch(() => {});
    }
    return { ok: true, mode: etatMode.mode };
  });

  // Public (comme /api/sante) : le bandeau peut s'afficher dès l'écran de
  // connexion, et rien ici n'est sensible (numéros de version, heure prévue).
  app.get('/api/maj/etat', async () => {
    const moteur = moteurMajCourant();
    return moteur ? moteur.vue() : vueInactive();
  });

  app.post('/api/maj/reporter', { preHandler: app.exigerAuth }, async (req) => {
    const corps = valider(ReporterSchema, req.body);
    const moteur = moteurMajCourant();
    if (!moteur) throw new ErreurMetier('Aucune mise à jour n’est prévue sur ce poste', 409);
    if (etatMode.mode !== 'NORMAL') throw new ErreurMetier('La mise à jour est déjà en cours', 409);
    // Situation vérifiée AVANT le PIN : un refus « déjà reporté » ne doit pas
    // coûter un essai de PIN au gérant.
    const avant = await moteur.vue();
    if (!avant.decision || avant.decision.action !== 'AVERTIR' || !avant.decision.report_possible) {
      throw new ErreurMetier(
        avant.decision?.rappel || avant.etat === 'REPORTEE'
          ? 'La mise à jour a déjà été reportée une fois : elle ne peut plus l’être'
          : 'La mise à jour ne peut être reportée que dans les 10 minutes qui précèdent son heure',
        409,
      );
    }
    const gerant = await verifierPinManager(corps.pin_manager, 'REPORT_MAJ');
    const vue = await moteur.reporter({ nom: gerant.nom_complet, id: gerant.id });
    await db.transaction(async (tx) => {
      await journaliser(tx, {
        user_id: gerant.id,
        action: 'REPORT_MAJ',
        entite: 'maj',
        motif: 'Pas maintenant',
        meta: {
          version: vue.prete?.version ?? null,
          numero: vue.prete?.numero ?? null,
          nouvelle_echeance: vue.decision?.echeance ?? null,
          demande_par: req.session!.utilisateur_id,
        },
      });
    });
    return vue;
  });
}
