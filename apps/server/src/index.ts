import './env.js'; // charge apps/server/.env AVANT tout (imports hoistés)
import { construireApp } from './app.js';
import { moteurSync } from './modules/sync/moteur.js';
import { samtracklyConfigure, synchroniserEquipe } from './modules/equipe/sync-samtrackly.js';
import { enregistrerIncident } from './modules/sante/incidents.js';
import { etatMode } from './modules/maj/mode.js';
import { INTERVALLE_CONSULTATION_MS } from './modules/maj/config.js';
import { moteurMajDuSite } from './modules/maj/moteur.js';
import { demarrerPointeuse } from './modules/pointeuse/moteur.js';
import { appliquerMigrations } from './db/migrate.js';

const PORT = Number(process.env.PORT ?? 3001);

// Le code et la base avancent ENSEMBLE, quel que soit le lanceur. Les anciens
// PosSamer.exe ne migrent pas : une mise à jour copiée par clé USB démarrait
// alors le nouveau code sur l'ancienne base, et plus personne ne pouvait se
// connecter (2026-10-26, colonne pointeuse_no absente). Sans effet si la base
// est déjà à jour ; en cas d'échec, tout est annulé et le serveur ne démarre
// pas — mieux vaut l'écran d'erreur du lanceur qu'une caisse à moitié cassée.
try {
  await appliquerMigrations();
} catch (e) {
  console.error('Mise à jour de la base impossible :', e);
  process.exit(1);
}

const app = await construireApp({ logger: true });

// Recharge les sessions persistées : un redémarrage ne déconnecte personne.
await app.sessions.charger().catch((e) => app.log.error({ e }, 'Rechargement des sessions'));

// 0.0.0.0 : les terminaux de caisse se connectent depuis le réseau local
await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`Serveur POS démarré sur le port ${PORT}${etatMode.mode === 'VALIDATION' ? ' (mode validation de mise à jour)' : ''}`);

// Ordres du siège : le moteur ne connaît pas Fastify, on lui passe de quoi
// sortir le papier du gérant et rafraîchir les écrans. AVANT demarrer().
moteurSync.brancherOrdres({
  imprimerRapportSequence: (rapport) => app.imprimante.imprimerRapportSequence(rapport as never),
  diffuser: (canal, id) => app.diffuser(canal as never, id),
});

// Mise à jour à distance : construit dès maintenant (le battement et le
// bandeau en ont besoin), boucles démarrées avec les autres tâches de fond.
// Inactif sans POS_RACINE (poste de développement).
const moteurMaj = await moteurMajDuSite((type) => app.diffuser(type));

/**
 * Tâches de fond. En mode validation (juste après l'échange de code par le
 * lanceur), AUCUNE ne démarre : si la nouvelle version est refusée, la base
 * est restaurée, et rien ne doit être parti au cloud ni chez SamerTrackly
 * entre-temps. Elles démarrent quand le lanceur valide la version.
 */
function demarrerTachesDeFond(): void {
  // Synchro cloud en tâche de fond (n'empêche jamais la caisse de fonctionner).
  void moteurSync.demarrer();

  moteurMaj?.demarrer(INTERVALLE_CONSULTATION_MS);

  // Pointeuse Hikvision : lue toutes les 20 s si une adresse est réglée
  // (Réglages › Pointeuse). Sans adresse, la boucle ne fait rien.
  demarrerPointeuse(() => app.diffuser('pointage'), app.log);

  // Synchro automatique de l'équipe depuis SamerTrackly (si clé configurée) :
  // au démarrage puis à intervalle régulier, quand la caisse est en ligne.
  if (samtracklyConfigure()) {
    const intervalleS = Number(process.env.SAMTRACKLY_INTERVALLE ?? 300);
    const lancer = () =>
      synchroniserEquipe(null)
        .then((r) => {
          if (!r.saute && (r.crees || r.maj || r.desactives)) {
            app.log.info({ r }, 'Synchro équipe SamerTrackly');
          }
        })
        .catch((e) => {
          app.log.warn({ e: String(e) }, 'Synchro équipe SamerTrackly échouée (réessai plus tard)');
          void enregistrerIncident(
            'SAMERTRACKLY', e, { operation: 'synchronisation de l’équipe' },
            'La mise à jour automatique de l’équipe depuis SamerTrackly a échoué. Les employés déjà présents dans le POS restent utilisables.',
          );
        });
    void lancer();
    if (intervalleS > 0) setInterval(lancer, intervalleS * 1000);
  }
}

etatMode.quandNormal(demarrerTachesDeFond);
