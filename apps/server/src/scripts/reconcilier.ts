/**
 * Réconciliation à la demande : `pnpm sync:reconcile -- --jour=AAAA-MM-JJ`.
 * Sans --jour, réconcilie la veille.
 */
import { fermerDb } from '../db/client.js';
import { chargerConfigSync } from '../modules/sync/config.js';
import { ClientCloud } from '../modules/sync/cloud-client.js';
import { hier, reconcilierJour } from '../modules/sync/reconcile.js';

function lireJour(): string {
  const arg = process.argv.find((a) => a.startsWith('--jour='));
  const jour = arg ? arg.slice('--jour='.length) : hier();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(jour)) {
    console.error('Format attendu : --jour=AAAA-MM-JJ');
    process.exit(1);
  }
  return jour;
}

async function main(): Promise<void> {
  const cfg = await chargerConfigSync();
  if (!cfg.url || !cfg.cleSite) {
    console.error('Synchro non configurée (SUPABASE_SYNC_URL / cle_site). Voir docs/DEPLOIEMENT_CLOUD.md.');
    process.exit(1);
  }
  const jour = lireJour();
  const client = new ClientCloud(cfg.url, cfg.cleSite);
  console.log(`Réconciliation du ${jour}…`);
  const r = await reconcilierJour(client, jour);
  console.log(`Statut : ${r.statut} — total cloud ${r.total_cloud}, écart ${r.ecart}`);
  await fermerDb();
  process.exit(r.statut === 'OK' ? 0 : 2);
}

await main();
