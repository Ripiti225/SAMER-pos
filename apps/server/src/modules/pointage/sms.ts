/**
 * Abstraction SMS (§A3, §14.5). L'opérateur réel (Orange CI, Termii…) sera
 * choisi à la préparation du pilote ; ici une implémentation console.
 * Plafond mensuel + alerte à 80 % gérés dans l'abstraction.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { parametresLocaux } from '../../db/schema/index.js';

export interface SmsService {
  envoyer(telephone: string, message: string): Promise<void>;
}

async function plafondMensuel(): Promise<number> {
  const [p] = await db.select().from(parametresLocaux).where(eq(parametresLocaux.cle, 'sms_plafond_mensuel'));
  return typeof p?.valeur === 'number' ? p.valeur : 2000;
}

/** Implémentation console : affiche le SMS, compte l'usage, alerte à 80 %. */
export class ConsoleSms implements SmsService {
  private compteurMois = { mois: new Date().getMonth(), envoyes: 0 };

  async envoyer(telephone: string, message: string): Promise<void> {
    const moisCourant = new Date().getMonth();
    if (moisCourant !== this.compteurMois.mois) this.compteurMois = { mois: moisCourant, envoyes: 0 };

    const plafond = await plafondMensuel();
    if (this.compteurMois.envoyes >= plafond) {
      console.warn(`[SMS] Plafond mensuel de ${plafond} atteint — envoi bloqué.`);
      throw new Error('Plafond mensuel de SMS atteint — prévenez le siège');
    }
    this.compteurMois.envoyes += 1;
    if (this.compteurMois.envoyes === Math.floor(plafond * 0.8)) {
      console.warn(`[SMS] ⚠ 80 % du plafond mensuel atteint (${this.compteurMois.envoyes}/${plafond}).`);
    }
    console.log(`\n[SMS → ${telephone}] ${message}\n`);
  }
}

export const smsService: SmsService = new ConsoleSms();
