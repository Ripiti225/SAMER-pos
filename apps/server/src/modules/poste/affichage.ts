/**
 * Réglages d'AFFICHAGE du poste (DESIGN_V2 § 8).
 *
 * Le mode clair/sombre appartient au POSTE, pas au compte : deux caissiers qui
 * se succèdent retrouvent le même affichage, et la caisse en terrasse peut
 * rester en clair pendant que celle du bar est en sombre. D'où
 * `parametres_locaux` et non le localStorage du navigateur.
 *
 * La LECTURE est publique : l'écran de connexion suit le mode, et il s'affiche
 * avant toute session. L'ÉCRITURE n'exige qu'une session (aucune permission
 * particulière) : c'est un confort de travail, pas un paramètre de gestion —
 * il n'a donc rien à faire derrière la garde `reglages.parametres`.
 */
import type { FastifyInstance } from 'fastify';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { parametresLocaux, restaurant } from '../../db/schema/index.js';
import { valider } from '../../lib/valider.js';
import { queuePoste } from '../../printer/escpos.js';
import { etatSync } from '../sync/etat.js';
import { moteurSync } from '../sync/moteur.js';

export const CLE_MODE = 'affichage_mode';
export const CLE_BANDEAU_EQUIPE = 'affichage_bandeau_equipe_deplie';

const AffichageSchema = z.object({
  mode: z.enum(['clair', 'sombre']).optional(),
  bandeau_equipe_deplie: z.boolean().optional(),
});

export interface Affichage {
  mode: 'clair' | 'sombre';
  bandeau_equipe_deplie: boolean;
}

async function lireAffichage(): Promise<Affichage> {
  const lignes = await db
    .select()
    .from(parametresLocaux)
    .where(inArray(parametresLocaux.cle, [CLE_MODE, CLE_BANDEAU_EQUIPE]));
  const parCle = new Map(lignes.map((l) => [l.cle, l.valeur]));
  return {
    mode: parCle.get(CLE_MODE) === 'sombre' ? 'sombre' : 'clair',
    // Replié par défaut : déplié, le bandeau d'équipe repousserait les tuiles
    // de l'accueil hors de l'écran (§ 6.7).
    bandeau_equipe_deplie: parCle.get(CLE_BANDEAU_EQUIPE) === true,
  };
}

async function ecrire(cle: string, valeur: unknown): Promise<void> {
  await db
    .insert(parametresLocaux)
    .values({ cle, valeur: valeur as never })
    .onConflictDoUpdate({
      target: parametresLocaux.cle,
      set: { valeur: valeur as never, updated_at: new Date() },
    });
}

/**
 * État du poste affiché en pied de l'écran de connexion (§ 6.1) : réseau,
 * imprimante, cloud. Public comme la lecture du mode — l'écran s'affiche avant
 * toute session. Volontairement pauvre : un booléen et un compteur, aucune
 * donnée de vente, aucun nom de fichier ni de clé.
 */
async function etatPoste() {
  const imprimante = await queuePoste('CAISSE').catch(() => null);
  const [resto] = await db.select().from(restaurant).limit(1);
  return {
    // Identité du site : l'écran de connexion s'affiche AVANT toute session,
    // sans elle un site Al Kayan ouvrait sur « Chez Samer » en orange.
    restaurant: resto
      ? { nom: resto.nom, marque: resto.marque, couleur_hex: resto.couleur_hex }
      : null,
    // Le poste a répondu : le réseau local fait son travail, par construction.
    reseau: true,
    imprimante_configuree: imprimante !== null,
    cloud: {
      actif: moteurSync.actif,
      en_attente: etatSync.lignes_en_attente,
    },
  };
}

export function routesPoste(app: FastifyInstance): void {
  // Public : lu par la caisse au démarrage, AVANT la connexion.
  app.get('/api/poste/affichage', async () => lireAffichage());

  // Public : pied de l'écran de connexion.
  app.get('/api/poste/etat', async () => etatPoste());

  app.put('/api/poste/affichage', { preHandler: app.exigerAuth }, async (req) => {
    const corps = valider(AffichageSchema, req.body);
    if (corps.mode !== undefined) await ecrire(CLE_MODE, corps.mode);
    if (corps.bandeau_equipe_deplie !== undefined) {
      await ecrire(CLE_BANDEAU_EQUIPE, corps.bandeau_equipe_deplie);
    }
    return lireAffichage();
  });
}
