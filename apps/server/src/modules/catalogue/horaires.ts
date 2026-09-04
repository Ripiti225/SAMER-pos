type CategorieHoraire = {
  heure_debut: string | null;
  heure_fin: string | null;
  disponibilite_forcee: boolean;
};

function minutes(heure: string): number {
  const [h = 0, m = 0] = heure.slice(0, 5).split(':').map(Number);
  return h * 60 + m;
}

/** Début inclus, fin exclue. Une fin à 00:00 permet une plage jusqu'à minuit. */
export function dansPlageHoraire(
  heure: string,
  debut: string | null,
  fin: string | null,
): boolean {
  if (!debut || !fin) return true;
  const courant = minutes(heure);
  const debutMinutes = minutes(debut);
  const finMinutes = minutes(fin);
  if (debutMinutes === finMinutes) return true;
  return debutMinutes < finMinutes
    ? courant >= debutMinutes && courant < finMinutes
    : courant >= debutMinutes || courant < finMinutes;
}

export function heureAbidjan(date = new Date()): string {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Africa/Abidjan',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

export function jourAbidjan(date = new Date()): number {
  const court = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Abidjan', weekday: 'short' }).format(date);
  return ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[court] ?? 1;
}

export function categorieDisponibleMaintenant(categorie: CategorieHoraire, date = new Date()): boolean {
  return categorie.disponibilite_forcee
    || dansPlageHoraire(heureAbidjan(date), categorie.heure_debut, categorie.heure_fin);
}
