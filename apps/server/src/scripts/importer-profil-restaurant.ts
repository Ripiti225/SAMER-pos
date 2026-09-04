import { fermerDb } from '../db/client.js';
import { importerProfilRestaurant } from '../profils/importer.js';

const code = process.argv.find((arg) => arg.startsWith('--code='))?.slice('--code='.length) ?? '';
if (!code) throw new Error('Indiquez le profil avec --code=ALA_BRAISE.');

try {
  await importerProfilRestaurant(code);
  console.log(`Profil ${code} importé.`);
} finally {
  await fermerDb();
}
