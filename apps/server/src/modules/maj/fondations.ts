/**
 * Fondations de la mise à jour à distance (lot L0), partagées avec le lanceur.
 *
 * Le code vit en CommonJS pur dans apps/desktop/maj/ parce que le lanceur
 * Electron l'embarque tel quel dans l'asar de PosSamer.exe (aucune étape de
 * compilation, aucune dépendance). Le serveur l'importe d'ici : un seul
 * endroit à changer si l'emplacement bouge, et les types (index.d.cts)
 * s'appliquent à tout le module `maj` du serveur.
 *
 * Sur un site, ce chemin relatif reste valable : apps/desktop fait partie de
 * l'arbre `app/` livré par chaque paquet. Le lanceur, lui, vérifie avec SA
 * copie embarquée (et sa clé publique) : c'est elle qui fait foi.
 */
export * from '../../../../desktop/maj/index.cjs';
