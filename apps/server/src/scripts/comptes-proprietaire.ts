/**
 * Met une base EXISTANTE en conformité avec les deux comptes propriétaire de
 * l'image de déploiement : `SAMER Zreik` (PIN 852741) et `Admin Willy`
 * (PIN 2212, l'administrateur qui installe et dépanne les 7 sites).
 *
 * Le seed (`db/seed.ts`) crée déjà ces deux comptes sur une base NEUVE. Ce
 * script existe pour les postes déjà déployés, dont la base porte encore
 * l'ancien compte unique : on ne peut pas les reseeder sans effacer leur
 * catalogue, leur plan de salle et leurs ventes.
 *
 * Idempotent — rejouable sans dommage :
 *   - renomme l'ancien propriétaire en « SAMER Zreik » SANS toucher à son PIN
 *     ni à son id (ses ventes, ses lignes d'audit et ses shifts y sont
 *     rattachés : créer un nouveau compte les orphelinerait) ;
 *   - crée « Admin Willy » s'il manque, réactive-le et remet son PIN s'il
 *     existe déjà ;
 *   - ne touche à aucun autre employé.
 *
 * Usage (sur un poste déployé, où pnpm n'existe pas) :
 *   node node_modules\tsx\dist\cli.mjs src\scripts\comptes-proprietaire.ts
 */
import '../env.js';
import argon2 from 'argon2';
import { eq, inArray } from 'drizzle-orm';
import { db, fermerDb } from '../db/client.js';
import { roles, utilisateurs } from '../db/schema/index.js';

const ANCIENS_NOMS = ['Samer El Khoury', 'Samer ElKhoury'];
const PATRON = 'SAMER Zreik';
const ADMIN = 'Admin Willy';
const PIN_ADMIN = '2212';

async function principal(): Promise<void> {
  const [rolePropr] = await db.select().from(roles).where(eq(roles.nom, 'PROPRIETAIRE'));
  if (!rolePropr) throw new Error('Rôle PROPRIETAIRE introuvable : base non migrée ?');

  // 1. L'ancien compte devient SAMER Zreik (même id, même PIN).
  const anciens = await db.select().from(utilisateurs).where(inArray(utilisateurs.nom_complet, ANCIENS_NOMS));
  for (const u of anciens) {
    await db
      .update(utilisateurs)
      .set({ nom_complet: PATRON, role: 'PROPRIETAIRE', role_id: rolePropr.id, actif: true })
      .where(eq(utilisateurs.id, u.id));
    console.log(`Renommé : « ${u.nom_complet} » → « ${PATRON} » (PIN inchangé).`);
  }
  if (anciens.length === 0) {
    const [patron] = await db.select().from(utilisateurs).where(eq(utilisateurs.nom_complet, PATRON));
    console.log(patron ? `« ${PATRON} » est déjà en place.` : `Aucun ancien compte à renommer.`);
  }

  // 2. Admin Willy : créé s'il manque, remis d'aplomb sinon.
  const hash = await argon2.hash(PIN_ADMIN, { type: argon2.argon2id });
  const [admin] = await db.select().from(utilisateurs).where(eq(utilisateurs.nom_complet, ADMIN));
  if (admin) {
    await db
      .update(utilisateurs)
      .set({
        role: 'PROPRIETAIRE',
        role_id: rolePropr.id,
        pin_hash: hash,
        actif: true,
        // Un compte de dépannage verrouillé par des essais ratés serait
        // exactement inutile au moment où on en a besoin.
        verrou_jusqua: null,
        tentatives_pin: 0,
        doit_definir_pin: false,
      })
      .where(eq(utilisateurs.id, admin.id));
    console.log(`« ${ADMIN} » existait : rôle, PIN et activation remis à jour.`);
  } else {
    await db.insert(utilisateurs).values({
      nom_complet: ADMIN,
      role: 'PROPRIETAIRE',
      role_id: rolePropr.id,
      pin_hash: hash,
      telephone: '+2250700000002',
    });
    console.log(`« ${ADMIN} » créé (PIN ${PIN_ADMIN}).`);
  }

  const finaux = await db.select().from(utilisateurs).where(eq(utilisateurs.role, 'PROPRIETAIRE'));
  console.log(`Propriétaires en base : ${finaux.map((u) => u.nom_complet).join(', ')}`);
}

await principal();
await fermerDb();
