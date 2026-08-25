/**
 * Republie les RÔLES et leurs PERMISSIONS vers le cloud : `pnpm roles:republier`.
 *
 * Pourquoi ce script existe. Les rôles naissent dans des MIGRATIONS SQL
 * (`INSERT INTO roles ...`, migrations 0006 et 0024), qui n'écrivent pas dans
 * `sync_outbox` — seule une création ou une modification passée par l'écran
 * Réglages → Rôles & accès en écrit une. Un site installé puis enrôlé n'a donc
 * jamais publié ses rôles : le siège les voit vides, et la console
 * d'administration n'a rien à proposer.
 *
 * Ce script rejoue la publication à l'identique, sans rien modifier en local :
 * il n'écrit que dans l'outbox, que le moteur de synchro videra à son prochain
 * cycle de montée (30 s par défaut).
 *
 * Rejouable sans risque : `sync-push` écrit côté cloud en UPSERT sur
 * (restaurant_id, id). Le relancer deux fois republie les mêmes lignes, il n'en
 * crée pas de doubles.
 */
import { db, fermerDb } from '../db/client.js';
import { roles, rolePermissions } from '../db/schema/index.js';
import { ecrireOutbox } from '../db/outbox.js';

async function main(): Promise<void> {
  const lignesRoles = await db.select().from(roles);
  if (lignesRoles.length === 0) {
    console.log('Aucun rôle en base — rien à republier.');
    return;
  }

  const lignesPerms = await db.select().from(rolePermissions);
  const parRole = new Map<string, string[]>();
  for (const p of lignesPerms) {
    parRole.set(p.role_id, [...(parRole.get(p.role_id) ?? []), p.permission_cle]);
  }

  await db.transaction(async (tx) => {
    for (const r of lignesRoles) {
      await ecrireOutbox(tx, 'roles', 'UPDATE', r.id, {
        id: r.id,
        nom: r.nom,
        systeme: r.systeme,
        actif: r.actif,
        created_at: r.created_at,
        updated_at: r.updated_at,
      });
      // Le POS publie la LISTE ENTIÈRE des permissions du rôle, `record_id` =
      // role_id : c'est la forme qu'attend le cloud (un tableau JSONB), et non
      // une ligne par couple comme en local.
      await ecrireOutbox(tx, 'role_permissions', 'UPDATE', r.id, {
        role_id: r.id,
        permissions: parRole.get(r.id) ?? [],
      });
    }
  });

  console.log(
    `${lignesRoles.length} rôle(s) et leurs permissions remis dans l'outbox.\n` +
      'Ils monteront au prochain cycle de synchro (30 s par défaut), puis\n' +
      'apparaîtront dans la console du siège, onglet Paramètres.',
  );
  for (const r of lignesRoles) {
    console.log(`  · ${r.nom} — ${(parRole.get(r.id) ?? []).length} permission(s)`);
  }
}

main()
  .catch((e: unknown) => {
    console.error('Republication impossible :', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => void fermerDb());
