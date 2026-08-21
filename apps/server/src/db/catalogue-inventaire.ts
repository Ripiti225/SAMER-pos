/**
 * Catalogue de COMPTAGE de l'inventaire (DESIGN_V2 § 6.9) — celui de
 * SamerTrackly, identique sur les 7 sites : noms, prix, grammages et ratios
 * repris tels quels.
 *
 * POURQUOI IL EST AUSSI ICI, alors que la migration 0021 l'insère déjà :
 * `seed.ts` fait un `TRUNCATE ... articles ... CASCADE`, et `produits_inventaire`
 * référence `articles` — un TRUNCATE CASCADE emporte les tables référençantes
 * quelles que soient leurs règles ON DELETE. Sans ce module, la séquence
 * d'installation `db:migrate && db:seed` laissait un catalogue de comptage VIDE :
 * l'écran Inventaire n'affichait rien et la validation passait sans rien compter,
 * ce qui vidait de sens le verrou de clôture.
 *
 * La migration reste la source pour les bases déjà installées ; ce module l'est
 * pour toute base neuve. Les deux doivent rester identiques.
 *
 * Le pont vers le catalogue de VENTE (qui porte les sorties automatiques) n'est
 * pas ici : c'est la table `inventaire_consommations` (migration 0022), remplie
 * par `appliquerRecettesDefaut()` au seed puis corrigée dans
 * Réglages › Recettes d'inventaire.
 */
export interface ProduitInventaireSeed {
  code: string;
  categorie: string;
  nom: string;
  prix: number;
  unite: string;
  role: string;
  ratio: string | null;
  ordre: number;
}

export const CATALOGUE_INVENTAIRE: ProduitInventaireSeed[] = [
  // Pains
  { code: 'p1', categorie: 'PAIN', nom: 'Pain chawarma', prix: 2500, unite: 'u', role: 'COMPTE', ratio: null, ordre: 1 },
  { code: 'p2', categorie: 'PAIN', nom: 'Pain burger', prix: 3500, unite: 'u', role: 'COMPTE', ratio: null, ordre: 2 },
  { code: 'p3', categorie: 'PAIN', nom: 'Pain fahita', prix: 3000, unite: 'u', role: 'COMPTE', ratio: null, ordre: 3 },

  // Poulet : po1 alimente po7 et po8 ; po2→po6 sont des sorties
  { code: 'po1', categorie: 'POUL', nom: 'Poulet frais', prix: 0, unite: 'u', role: 'ENTREE', ratio: null, ordre: 1 },
  { code: 'po2', categorie: 'POUL', nom: 'Pané', prix: 0, unite: 'u', role: 'CONSO_POULET', ratio: '1', ordre: 2 },
  { code: 'po3', categorie: 'POUL', nom: 'Rôti', prix: 0, unite: 'u', role: 'CONSO_POULET', ratio: '1', ordre: 3 },
  { code: 'po4', categorie: 'POUL', nom: 'Braise', prix: 0, unite: 'u', role: 'CONSO_POULET', ratio: '1', ordre: 4 },
  { code: 'po5', categorie: 'POUL', nom: 'Désossé', prix: 0, unite: 'u', role: 'CONSO_POULET', ratio: '1', ordre: 5 },
  { code: 'po6', categorie: 'POUL', nom: 'Cuisses de poulet', prix: 0, unite: 'u', role: 'CONSO_POULET', ratio: '1', ordre: 6 },
  { code: 'po7', categorie: 'POUL', nom: 'Pâte de poulet', prix: 1000, unite: 'u', role: 'AUTO_ENT', ratio: '10', ordre: 7 },
  { code: 'po8', categorie: 'POUL', nom: 'Total poulet', prix: 8000, unite: 'u', role: 'TOTAL_POULET', ratio: null, ordre: 8 },

  // Apéritifs
  { code: 'a1', categorie: 'APER', nom: 'Nems', prix: 2000, unite: 'u', role: 'COMPTE', ratio: null, ordre: 1 },
  { code: 'a2', categorie: 'APER', nom: 'Kébbé', prix: 1000, unite: 'u', role: 'COMPTE', ratio: null, ordre: 2 },
  { code: 'a3', categorie: 'APER', nom: 'Bourak', prix: 2000, unite: 'u', role: 'COMPTE', ratio: null, ordre: 3 },
  { code: 'a4', categorie: 'APER', nom: 'Fatayer viande', prix: 1000, unite: 'u', role: 'COMPTE', ratio: null, ordre: 4 },
  { code: 'a5', categorie: 'APER', nom: 'Fatayer légumes', prix: 1000, unite: 'u', role: 'COMPTE', ratio: null, ordre: 5 },
  { code: 'a6', categorie: 'APER', nom: 'Fatayer maison', prix: 1500, unite: 'u', role: 'COMPTE', ratio: null, ordre: 6 },
  { code: 'a7', categorie: 'APER', nom: 'Fatayer JFromage', prix: 1500, unite: 'u', role: 'COMPTE', ratio: null, ordre: 7 },
  { code: 'a8', categorie: 'APER', nom: 'Mini tacos', prix: 2000, unite: 'u', role: 'COMPTE', ratio: null, ordre: 8 },
  { code: 'a9', categorie: 'APER', nom: 'Francisco', prix: 0, unite: 'u', role: 'COMPTE', ratio: null, ordre: 9 },
  { code: 'f1', categorie: 'APER', nom: 'Philadelphia', prix: 2500, unite: 'u', role: 'COMPTE', ratio: null, ordre: 10 },

  // Plats
  { code: 'pl1', categorie: 'PLAT', nom: 'Steak', prix: 6000, unite: 'u', role: 'COMPTE', ratio: null, ordre: 1 },
  { code: 'pl2', categorie: 'PLAT', nom: 'Escalope plats', prix: 5000, unite: 'u', role: 'COMPTE', ratio: null, ordre: 2 },
  { code: 'pl3', categorie: 'PLAT', nom: 'Chicken burger', prix: 0, unite: 'u', role: 'COMPTE', ratio: null, ordre: 3 },
  { code: 'pl4', categorie: 'PLAT', nom: 'Viande burger', prix: 0, unite: 'u', role: 'COMPTE', ratio: null, ordre: 4 },
  { code: 'pl5', categorie: 'PLAT', nom: 'Crispy 5pcs', prix: 5000, unite: 'u', role: 'COMPTE', ratio: null, ordre: 5 },
  { code: 'a10', categorie: 'PLAT', nom: 'Brochette poulet', prix: 5000, unite: 'u', role: 'COMPTE', ratio: null, ordre: 6 },
  { code: 'a11', categorie: 'PLAT', nom: 'Brochette viande', prix: 5000, unite: 'u', role: 'COMPTE', ratio: null, ordre: 7 },

  // Fromage : chaque produit consomme des grammes, f10 est le stock réel
  { code: 'f2', categorie: 'FROM', nom: 'Manaïche (100g)', prix: 0, unite: 'g', role: 'CONSO_FROMAGE', ratio: '100', ordre: 1 },
  { code: 'f3', categorie: 'FROM', nom: 'Pizza spéciale (130g)', prix: 0, unite: 'g', role: 'CONSO_FROMAGE', ratio: '130', ordre: 2 },
  { code: 'f4', categorie: 'FROM', nom: 'Pizza moyenne (160g)', prix: 0, unite: 'g', role: 'CONSO_FROMAGE', ratio: '160', ordre: 3 },
  { code: 'f5', categorie: 'FROM', nom: 'Pizza grande (200g)', prix: 0, unite: 'g', role: 'CONSO_FROMAGE', ratio: '200', ordre: 4 },
  { code: 'f6', categorie: 'FROM', nom: 'Mini pizza (20g)', prix: 0, unite: 'g', role: 'CONSO_FROMAGE', ratio: '20', ordre: 5 },
  { code: 'f7', categorie: 'FROM', nom: 'Fatayer JF 30g', prix: 0, unite: 'g', role: 'CONSO_FROMAGE', ratio: '30', ordre: 6 },
  { code: 'f8', categorie: 'FROM', nom: 'Sandwich/Tacos (50g)', prix: 0, unite: 'g', role: 'CONSO_FROMAGE', ratio: '50', ordre: 7 },
  { code: 'f9', categorie: 'FROM', nom: 'Mini tacos (30g)', prix: 0, unite: 'g', role: 'CONSO_FROMAGE', ratio: '30', ordre: 8 },
  { code: 'f10', categorie: 'FROM', nom: 'Total Fromage', prix: 5, unite: 'g', role: 'TOTAL_FROMAGE', ratio: null, ordre: 9 },

  // Boissons
  { code: 'b1', categorie: 'BOIS', nom: 'Nespresso', prix: 1000, unite: 'u', role: 'COMPTE', ratio: null, ordre: 1 },
  { code: 'b2', categorie: 'BOIS', nom: 'Eau G', prix: 1000, unite: 'u', role: 'COMPTE', ratio: null, ordre: 2 },
  { code: 'b3', categorie: 'BOIS', nom: 'Eau P', prix: 500, unite: 'u', role: 'COMPTE', ratio: null, ordre: 3 },
  { code: 'b4', categorie: 'BOIS', nom: 'Boisson 1000f', prix: 1000, unite: 'u', role: 'COMPTE', ratio: null, ordre: 4 },
  { code: 'b5', categorie: 'BOIS', nom: 'Boisson 1500f', prix: 1500, unite: 'u', role: 'COMPTE', ratio: null, ordre: 5 },
  { code: 'b6', categorie: 'BOIS', nom: 'Pot Fresco', prix: 1000, unite: 'u', role: 'COMPTE', ratio: null, ordre: 6 },
  { code: 'b7', categorie: 'BOIS', nom: 'Darina', prix: 0, unite: 'u', role: 'DARINA', ratio: null, ordre: 7 },
  { code: 'b8', categorie: 'BOIS', nom: 'Thé', prix: 1000, unite: 'u', role: 'COMPTE', ratio: null, ordre: 8 },

  // Glaces
  { code: 'g1', categorie: 'GLAC', nom: 'Glace 2 boules', prix: 0, unite: 'u', role: 'CONSO_GLACE', ratio: '2', ordre: 1 },
  { code: 'g2', categorie: 'GLAC', nom: 'Milkshake/Spéciale', prix: 0, unite: 'u', role: 'CONSO_GLACE', ratio: '3', ordre: 2 },
  { code: 'g3', categorie: 'GLAC', nom: 'Pot de glace', prix: 6000, unite: 'pot', role: 'TOTAL_GLACE', ratio: '38', ordre: 3 },
  { code: 'g4', categorie: 'GLAC', nom: 'Cornets', prix: 1000, unite: 'u', role: 'COMPTE', ratio: null, ordre: 4 },

  // Frites
  { code: 'fr1', categorie: 'FRIT', nom: 'Portions de frites', prix: 0, unite: 'u', role: 'CONSO_FRITES', ratio: '8', ordre: 1 },
  { code: 'fr2', categorie: 'FRIT', nom: 'Tacos vendus', prix: 0, unite: 'u', role: 'CONSO_FRITES', ratio: '15', ordre: 2 },
  { code: 'fr3', categorie: 'FRIT', nom: 'Sachet de frites', prix: 2500, unite: 'sachet', role: 'TOTAL_FRITES', ratio: null, ordre: 3 },
];
