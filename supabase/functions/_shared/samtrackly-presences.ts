export interface ApiPresences {
  lire(chemin: string): Promise<{ id: string }[]>;
  inserer(table: string, lignes: Record<string, unknown>[]): Promise<unknown[]>;
  upsert(
    table: string,
    lignes: Record<string, unknown>[],
    surConflit: string,
  ): Promise<unknown[]>;
  patch(table: string, id: string, champs: Record<string, unknown>): Promise<void>;
}

export async function ecrirePresences(
  lignes: Record<string, unknown>[],
  api: ApiPresences,
): Promise<void> {
  // La clé multi-shift fonctionne seulement quand le caissier SamerTrackly est
  // connu. Dans ce cas, l'UPSERT habituel reste atomique et groupé.
  const avecCaissier = lignes.filter((ligne) => ligne.caissier_id != null);
  if (avecCaissier.length > 0) {
    await api.upsert(
      'presences',
      avecCaissier,
      'point_id,caissier_id,travailleur_id',
    );
  }

  // SamerTrackly conserve un index partiel historique pour les lignes sans
  // caissier : UNIQUE (point_id, travailleur_id) WHERE caissier_id IS NULL.
  // PostgreSQL considère pourtant les NULL distincts dans la contrainte à
  // trois colonnes utilisée ci-dessus. Un rejeu tenterait donc un INSERT et
  // heurterait `presences_legacy_unique`. On retrouve puis met à jour la ligne
  // historique explicitement afin que le transfert reste idempotent.
  for (const ligne of lignes.filter((presence) => presence.caissier_id == null)) {
    const pointId = encodeURIComponent(String(ligne.point_id ?? ''));
    const travailleurId = encodeURIComponent(String(ligne.travailleur_id ?? ''));
    const [existante] = await api.lire(
      `presences?point_id=eq.${pointId}&travailleur_id=eq.${travailleurId}`
      + '&caissier_id=is.null&select=id&limit=1',
    );

    if (existante) {
      await api.patch('presences', existante.id, ligne);
    } else {
      await api.inserer('presences', [ligne]);
    }
  }
}
