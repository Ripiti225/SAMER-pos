import { construireApp } from './app.js';
import { moteurSync } from './modules/sync/moteur.js';

const PORT = Number(process.env.PORT ?? 3001);

const app = await construireApp({ logger: true });

// Recharge les sessions persistées : un redémarrage ne déconnecte personne.
await app.sessions.charger().catch((e) => app.log.error({ e }, 'Rechargement des sessions'));

// 0.0.0.0 : les terminaux de caisse se connectent depuis le réseau local
await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`Serveur POS démarré sur le port ${PORT}`);

// Synchro cloud en tâche de fond (n'empêche jamais la caisse de fonctionner).
void moteurSync.demarrer();
