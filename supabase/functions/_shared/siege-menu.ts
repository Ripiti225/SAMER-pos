/** Validation des modifications du menu faites depuis la console siège. */
export interface ModificationArticle {
  restaurant_id: string;
  article_id: string;
  version_attendue: number;
  categorie_id: string;
  nom: string;
  description: string | null;
  prix_base: number;
  image_url: string | null;
  disponible: boolean;
  actif: boolean;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function lireModificationArticle(corps: Record<string, unknown>):
  | { valeur: ModificationArticle; erreur?: never }
  | { erreur: string; valeur?: never } {
  const ids = ['restaurant_id', 'article_id', 'categorie_id'] as const;
  if (ids.some((cle) => {
    const valeur = corps[cle];
    return typeof valeur !== 'string' || !uuid.test(valeur);
  })) {
    return { erreur: 'Restaurant, article ou catégorie invalide' };
  }
  if (typeof corps.version_attendue !== 'number' || !Number.isSafeInteger(corps.version_attendue) ||
    corps.version_attendue < 0) {
    return { erreur: 'Version de l’article invalide : rechargez le menu' };
  }
  if (typeof corps.nom !== 'string' || !corps.nom.trim()) return { erreur: 'Le nom est obligatoire' };
  if (typeof corps.prix_base !== 'number' || !Number.isInteger(corps.prix_base) ||
    corps.prix_base < 0 || corps.prix_base > 2_147_483_647) {
    return { erreur: 'Le prix doit être un entier en FCFA' };
  }
  if (typeof corps.disponible !== 'boolean' || typeof corps.actif !== 'boolean') {
    return { erreur: 'Disponibilité ou état de l’article invalide' };
  }
  if (corps.description !== null && typeof corps.description !== 'string') {
    return { erreur: 'Description invalide' };
  }
  if (corps.image_url !== null && typeof corps.image_url !== 'string') {
    return { erreur: 'Photo invalide' };
  }
  return {
    valeur: {
      restaurant_id: corps.restaurant_id as string,
      article_id: corps.article_id as string,
      version_attendue: corps.version_attendue,
      categorie_id: corps.categorie_id as string,
      nom: corps.nom.trim(),
      description: (corps.description as string | null)?.trim() || null,
      prix_base: corps.prix_base,
      image_url: (corps.image_url as string | null)?.trim() || null,
      disponible: corps.disponible,
      actif: corps.actif,
    },
  };
}
