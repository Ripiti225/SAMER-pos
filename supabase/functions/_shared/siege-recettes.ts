/** Contrôles des écritures du catalogue d'inventaire depuis la console siège. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORIES = new Set(['PAIN', 'POUL', 'APER', 'PLAT', 'FROM', 'BOIS', 'GLAC', 'FRIT']);

export function uuidValide(valeur: unknown): valeur is string {
  return typeof valeur === 'string' && UUID.test(valeur);
}

export function lireProduitInventaire(corps: Record<string, unknown>):
  | { valeur: { restaurant_id: string; nom: string; categorie: string; unite: string; prix: number }; erreur?: never }
  | { erreur: string; valeur?: never } {
  if (!uuidValide(corps.restaurant_id)) return { erreur: 'Restaurant invalide' };
  if (typeof corps.nom !== 'string' || !corps.nom.trim() || corps.nom.trim().length > 120) {
    return { erreur: 'Indiquez un nom de produit de 1 à 120 caractères' };
  }
  if (typeof corps.categorie !== 'string' || !CATEGORIES.has(corps.categorie)) {
    return { erreur: 'Catégorie d’inventaire invalide' };
  }
  if (typeof corps.unite !== 'string' || !corps.unite.trim() || corps.unite.trim().length > 16) {
    return { erreur: 'Indiquez une unité de comptage de 1 à 16 caractères' };
  }
  if (typeof corps.prix !== 'number' || !Number.isSafeInteger(corps.prix) || corps.prix < 0 || corps.prix > 100_000_000) {
    return { erreur: 'Le prix doit être un entier en FCFA' };
  }
  return { valeur: {
    restaurant_id: corps.restaurant_id,
    nom: corps.nom.trim(),
    categorie: corps.categorie,
    unite: corps.unite.trim(),
    prix: corps.prix,
  } };
}

export function lireLiaisonRecette(corps: Record<string, unknown>):
  | { valeur: { restaurant_id: string; produit_id: string; article_id: string; quantite: number }; erreur?: never }
  | { erreur: string; valeur?: never } {
  if (!uuidValide(corps.restaurant_id) || !uuidValide(corps.produit_id) || !uuidValide(corps.article_id)) {
    return { erreur: 'Restaurant, produit ou article invalide' };
  }
  if (typeof corps.quantite !== 'number' || !Number.isFinite(corps.quantite) || corps.quantite <= 0 ||
    corps.quantite > 1000 || Math.round(corps.quantite * 1000) !== corps.quantite * 1000) {
    return { erreur: 'La quantité doit être positive, avec au plus trois décimales' };
  }
  return { valeur: {
    restaurant_id: corps.restaurant_id,
    produit_id: corps.produit_id,
    article_id: corps.article_id,
    quantite: corps.quantite,
  } };
}
