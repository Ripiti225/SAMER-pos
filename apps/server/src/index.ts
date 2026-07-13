import './env.js'; // charge apps/server/.env AVANT tout (imports hoistés)
import { construireApp } from './app.js';
import { moteurSync } from './modules/sync/moteur.js';
import { samtracklyConfigure, synchroniserEquipe } from './modules/equipe/sync-samtrackly.js';

const PORT = Number(process.env.PORT ?? 3001);

const app = await construireApp({ logger: true });

// Recharge les sessions persistées : un redémarrage ne déconnecte personne.
await app.sessions.charger().catch((e) => app.log.error({ e }, 'Rechargement des sessions'));

// 0.0.0.0 : les terminaux de caisse se connectent depuis le réseau local
await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`Serveur POS démarré sur le port ${PORT}`);

// Synchro cloud en tâche de fond (n'empêche jamais la caisse de fonctionner).
void moteurSync.demarrer();

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
      .catch((e) => app.log.warn({ e: String(e) }, 'Synchro équipe SamerTrackly échouée (réessai plus tard)'));
  void lancer();
  if (intervalleS > 0) setInterval(lancer, intervalleS * 1000);
}
