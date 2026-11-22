/** Télécharge un CSV. Il part en UTF-8 avec BOM : sans lui, Excel abîme les accents. */
export function telechargerCsv(nom: string, contenu: string) {
  const url = URL.createObjectURL(new Blob(['﻿', contenu], { type: 'text/csv;charset=utf-8' }));
  const lien = document.createElement('a');
  lien.href = url;
  lien.download = nom;
  lien.click();
  URL.revokeObjectURL(url);
}

/** Nom de fichier tiré d'un libellé : lettres et chiffres, le reste en tirets. */
export function nomFichier(libelle: string): string {
  return libelle.replace(/[^\p{L}\d]+/gu, '-');
}
