# DESIGN — remplacé par « Duo contrasté »

> **Ce document ne fait plus foi.** La référence de design du POS est
> [`DESIGN_V2.md`](DESIGN_V2.md) — « Duo contrasté » — accompagné de la maquette
> cliquable [`maquette_nouveau_design_caisse.html`](maquette_nouveau_design_caisse.html).

Le thème **« Culinary Commerce »** décrit ici (palette Material sable et brun,
jetons `surface-container-*`, `on-primary-container`…) a été **refusé par le
client**, puis remplacé le **2026-08-15/16** par le design v2 : ossature ardoise
+ plan de travail clair, aplats francs, couleur porteuse d'information.

Le fichier est conservé vide de ses valeurs pour une seule raison : ne pas
laisser traîner deux palettes contradictoires dans `docs/`. Un jeton
« Culinary Commerce » retrouvé dans du code est un **reste à porter**, pas une
référence — les anciens noms (`--fond-page`, `--surface-carte`, `--texte-fort`…)
survivent uniquement comme **alias de compatibilité** en tête de
`packages/theme/theme.css`, le temps que le KDS, la tablette serveur et l'app
client passent eux aussi aux jetons v2.

Historique complet des décisions et des couleurs : `DESIGN_V2.md` § 8 et § 10.
