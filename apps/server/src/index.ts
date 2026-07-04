import { construireApp } from './app.js';

const PORT = Number(process.env.PORT ?? 3001);

const app = await construireApp({ logger: true });

// 0.0.0.0 : les terminaux de caisse se connectent depuis le réseau local
await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`Serveur POS démarré sur le port ${PORT}`);
