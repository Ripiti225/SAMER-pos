// ──────────────────────────────────────────────────────────────────────────────
// Rattrapage automatique des présences écartées faute de fiche RH.
//
// Cas visé : un employé créé directement sur la caisse (`utilisateurs_site.
// externe_id` vide) n'a pas de fiche RH côté SamerTrackly. Sa présence n'est
// écrite nulle part sur ce shift, et le service est quand même marqué
// transféré — perdre l'attribution vaut mieux que perdre la recette. La liste
// de qui a été écarté vit dans `samtrackly_transferts.presences_ignorees`.
//
// Dès que le siège crée la fiche manquante, `externe_id` se remplit côté POS
// (par la synchro équipe déjà en place) et ce module le détecte tout seul, à
// chaque passage du cron : le service repasse en file, sans qu'un humain
// lance `rejouer_transferts()` à la main.
//
// ⚠ CE MODULE NE COUVRE PAS LE CAS DU 2026-08-18 (caissier_id vide). Celui-là
// venait d'un bridge différent (`SamerTrackly.utilisateurs.travailleur_id`,
// vide pour TOUS les comptes caissier existants) et a été réparé une fois par
// une liaison manuelle massive — pas par ce mécanisme.
//
// Fonctions PURES, testées (`samtrackly-rattrapage.test.ts`).
// ──────────────────────────────────────────────────────────────────────────────

/** Un service déjà transféré, dont des présences ont été écartées. */
export interface TransfertPresencesIgnorees {
  service_id: string;
  restaurant_id: string;
  point_id: string | null;
  journee: string | null;
  presences_ignorees: string[] | null;
}

/**
 * Parmi les services dont des présences ont été écartées, lesquels ont
 * maintenant au moins une personne devenue reconnue par la RH — donc à
 * rejouer. Un service repris dès qu'UNE personne est résolue : le prochain
 * passage rejouera le reste dès que les autres fiches arriveront à leur tour.
 */
export function servicesARattraper(
  transferts: TransfertPresencesIgnorees[] | null | undefined,
  maintenantResolues: Set<string>,
): TransfertPresencesIgnorees[] {
  return (transferts || []).filter((t) =>
    (t.presences_ignorees || []).some((id) => maintenantResolues.has(id)),
  );
}

export interface LigneJournalRattrapage {
  action: string;
  details: { service_id: string; journee: string | null; presences_recuperees: number };
  restaurant_id: string;
  point_id: string | null;
  user_nom: string;
}

/**
 * La trace laissée dans `journal_activite` de SamerTrackly. Signée « Pont
 * POS » plutôt qu'un nom de personne : un vérificateur qui voit une ligne de
 * présence changer après coup doit pouvoir savoir immédiatement que c'est la
 * machine qui a rejoué le service, pas quelqu'un qui a retouché les données.
 */
export function construireJournalRattrapage(
  t: TransfertPresencesIgnorees,
  presencesRecuperees: number,
): LigneJournalRattrapage {
  return {
    action: 'rattrapage_presences_pos',
    details: {
      service_id: t.service_id,
      journee: t.journee,
      presences_recuperees: Math.max(0, presencesRecuperees),
    },
    restaurant_id: t.restaurant_id,
    point_id: t.point_id,
    user_nom: 'Pont POS',
  };
}
