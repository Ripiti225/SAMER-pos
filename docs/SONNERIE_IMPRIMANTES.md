# Sonnerie des bons de préparation

Dans Réglages → Imprimantes, enregistrer d’abord l’imprimante du poste.
Choisir un mode sonore, cliquer sur « Tester la sonnerie », puis sur
« J’ai entendu : enregistrer » si le son a été entendu. Sinon essayer le mode
suivant. L’acceptation du test par Windows ne prouve pas que le son a retenti.

Le mode est conservé localement par poste et nom de file d’impression.
Il prend effet sur les prochains bons de préparation, après la coupe,
sans redémarrage. Les reçus clients et rapports ne déclenchent pas cette commande.
« Désactivée » supprime la commande sonore du POS ; elle ne désactive pas une
sonnerie automatique configurée directement dans l’imprimante.
Un autre nom d’imprimante impose une nouvelle calibration. Si le matériel est
remplacé en gardant le même nom Windows, refaire le test manuellement.

Les modes ne couvrent pas toutes les imprimantes. Si aucun ne fonctionne,
vérifier le modèle, son avertisseur et les réglages du fabricant.
Le premier correctif (mode 1 en cuisine, silence ailleurs) reste le défaut
tant qu’aucun réglage de sonnerie n’a été enregistré.

## Protocoles

- Modes 1 et 2 : ESC B / ESC C, deux répétitions, son sans voyant pour ESC C.
  [Manuel EC/GP-80XXX, pages 54–55](https://eclinepos.com/Descargas/ControladoresZip/Impresoras/EC-PM-80340/EC-80XXX%20Programmer%20Manual%20V6_1.pdf).
- Modes 3 et 4 : ESC ( A, fonction 97, variantes interne et externe,
  deux répétitions. [Référence Epson](https://download4.epson.biz/sec_pubs/pos/reference_en/escpos/esc_lparen_ca_fn97.html).

Aucune impulsion de tiroir ni modification permanente du firmware n’est envoyée.
Les routes de test et d’enregistrement exigent la permission des paramètres ;
l’enregistrement est audité. Aucun changement de schéma SQL n’est nécessaire.

## Vérification

Depuis `apps/server` : `pnpm exec vitest run --config vitest.printer.config.ts`.
Ces tests ne touchent ni la base ni les imprimantes. La validation physique
reste à faire sur chaque modèle avec le bouton de test, puis un bon cuisine.
