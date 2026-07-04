import type { promotions } from '../../db/schema/index.js';

export type PromotionDb = typeof promotions.$inferSelect;

/** Jour ISO 1=lundi … 7=dimanche (le schéma stocke 1=lundi). */
function jourIso(date: Date): number {
  const d = date.getDay(); // 0=dimanche
  return d === 0 ? 7 : d;
}

function minutesDepuisMinuit(hhmmss: string): number {
  const [h = 0, m = 0] = hhmmss.split(':').map(Number);
  return h * 60 + m;
}

/** Une promotion s'applique automatiquement si le jour ET la plage horaire correspondent (§5.5). */
export function promotionActive(promo: PromotionDb, quand: Date): boolean {
  if (!promo.actif) return false;
  if (!promo.jours.includes(jourIso(quand))) return false;
  if (promo.heure_debut && promo.heure_fin) {
    const minutes = quand.getHours() * 60 + quand.getMinutes();
    const debut = minutesDepuisMinuit(promo.heure_debut);
    const fin = minutesDepuisMinuit(promo.heure_fin);
    if (minutes < debut || minutes >= fin) return false;
  }
  return true;
}
