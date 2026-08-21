# État du projet — POS Chez Samer / Al Kayan

> Fichier de reprise, **actualisé à chaque compaction** de la conversation.
> Il résume l'état courant pour repartir sans relire tout l'historique.
> Dernière mise à jour : 2026-08-16.

## Session 2026-08-16 — Fin du design v2 : écran de connexion, couleurs de catégorie, doc

Les tâches **9 et 10** de la feuille de route sont terminées : le portage du
design v2 est **complet pour la caisse**. 210/210 tests verts, typecheck caisse
et serveur OK, `dist` de la caisse reconstruit.

**Écran de connexion (§ 6.1)** — `screens/Login.tsx` réécrit en écran
« vitrine » (il SUIT le mode clair/sombre, contrairement à l'ossature des écrans
de travail) :

- Deux colonnes `1fr 380px` : profils à gauche (grille de 3, cartes de 152 px,
  avatar de 54 px teinté), bloc PIN de 380 px à droite. Halo de marque en fond.
- **Pavé conforme à la maquette** : 1-9, retour arrière, 0, **✓ en aplat de
  marque** (plus de gros bouton « Se connecter » sous le pavé), et **six points**
  fixes — la longueur du PIN ne se lit pas à l'écran.
- Le pavé **se tape toujours**, c'est la VALIDATION qui refuse sans profil.
  Tout refus (profil manquant, PIN faux, PIN trop facile, confirmation
  différente) **fait trembler le bloc** (`.secousse`, `index.css`) et vide la
  saisie. Le premier accès (code temporaire → PIN → confirmation) tient dans le
  même bloc, avec un titre d'étape.
- **Pied** : réseau / imprimante / cloud à gauche, **réglage Affichage
  (Clair · Sombre) + miniature** à droite. La miniature est peinte avec les
  jetons réels, elle change donc avec le choix.
- Couleur d'avatar par profil, **tirée du nom** (une embauche ne repeint pas
  l'équipe) ; les encadrants prennent l'accent de marque —
  **jamais `--marque` brut en texte** (≈ 2:1 sur fond clair), toujours
  `--marque-sur-plan`. Le badge de rôle est enfin en français (« Propriétaire »
  et non « PROPRIETAIRE ») ; un rôle sur mesure garde son libellé saisi.
- Bouton « Fermer l'application » (kiosque) conservé, déplacé dans le pied.

**Nouvelle route publique `GET /api/poste/etat`** (`modules/poste/affichage.ts`,
publique comme la lecture du mode : l'écran s'affiche avant toute session).
Renvoie l'identité du site, `imprimante_configuree`, `cloud {actif, en_attente}`.
Volontairement pauvre : un booléen et un compteur, aucune donnée de vente.
Elle corrige au passage un vrai défaut : sans identité avant la session, les
**deux sites Al Kayan (KMS et Yop) ouvraient sur « Chez Samer » en orange** — le
nom, la marque et `--marque` sont désormais posés dès la connexion.
`moteurSync` expose un getter `actif` pour ce voyant.

**Couleurs de catégorie (§ 4.1 / § 7)** — `couleurCategorie()` dans
`packages/shared/src/constantes.ts`, à côté du routage d'impression et pour la
même raison : **la table `categories` n'a pas de colonne couleur**, la teinte se
déduit du nom. Les 4 couleurs du document telles quelles, les 10 autres
catégories du catalogue réel écartées en teinte, **aucune orange** (famille de la
marque), et une palette de repli **hachée sur le nom** pour une catégorie créée à
la main — stable d'un poste et d'un écran à l'autre, ce qu'un index de liste ne
serait pas. Appliqué dans `Commande.tsx` aux quatre endroits prévus : pastille de
la colonne (qui remplace l'icône, comme la maquette, avec le compteur
d'articles), **liseré gauche de 4 px** de la carte, fond du visuel à 11 %, et
**point sur chaque ligne d'addition** (via `article_id` → catalogue déjà chargé,
aucun appel serveur en plus). La fiche article reçoit le bandeau visuel de 156 px
prévu au § 6.4. Le combo n'a pas de catégorie : il prend la marque, et son entête
passe en **aplat** (le dégradé restant contredisait le § 2).

⚠️ **Un écart assumé à la maquette** : la grille d'articles est en
`auto-fill minmax(150px, 1fr)` et non `168px`. À 168 px, l'écran du poste
(1024) ne tient que **deux** colonnes — un catalogue de 128 articles se
parcourrait au défilement. À 150 px on garde trois colonnes ici, et la grille en
ajoute d'elle-même sur un écran plus large. Même raisonnement que le `clamp` de
la colonne d'addition.

**Tâche 10 — documentation** : `DESIGN_V2.md` passe en statut *validé et porté*,
avec la règle de travail (maquette à la lettre, vérification à 1024 × 768) ;
**le point « livraisons partenaires saisissables » du § 6.10 est corrigé** (elles
ne le sont pas — décision du 2026-08-15, appliquée côté serveur) ; le § 6.2
annonce enfin 6 tuiles et non 4 ; le § 8 note l'entorse comme tranchée ; le § 4.1
documente les 14 catégories et le repli. `docs/DESIGN.md` (« Culinary Commerce »)
est réduit à un renvoi : plus deux palettes contradictoires dans `docs/`.

**Reste au chantier design** : rien pour la caisse. Le KDS, la tablette serveur
et l'app client tournent toujours sur les alias de compatibilité de
`packages/theme/theme.css` — à porter le jour où on les reprend.

## Session 2026-08-16 (suite 4) — Tout ce que saisit le caissier monte au siège

Demande du boss : **fini la double saisie** — l'inventaire, le point et le reste
doivent arriver dans SamerTrackly sans être retapés. Granularité choisie :
**dépenses ET inventaire ligne à ligne** (pas les recettes ni le catalogue de
comptage, que le siège connaît déjà). Code écrit et testé — **217/217** — mais
**rien n'est déployé** : le cloud doit passer en premier (voir l'ordre plus bas).

### Le défaut trouvé en chemin : la synchro aurait gelé au premier shift

`sync-push` acquitte de façon **contiguë** : `ligneAutorisee()` renvoie `null`
pour une table absente de `COLONNES_VENTES` → `break`, seq jamais acquitté. La
file locale étant strictement ordonnée, **tout ce qui suit est bloqué à jamais**.

Or le POS publiait déjà **huit tables absentes du cloud** (`equipe_service`,
`sequences_caisse`, `roles`, `role_permissions`, `utilisateurs` — présente mais
en descente seulement —, `disponibilite_locale`, `options_catalogue`,
`options_liaisons`), et trois autres (`clients_fidelite`, `points_fidelite`,
`pointages`) étaient autorisées **sans avoir de table**. `equipe_service` étant
écrite à chaque ouverture de service, **le premier site enrôlé aurait gelé sa
synchro dès son premier shift, ventes comprises.** Jamais vu : aucun site n'est
enrôlé.

### Ce qui a été écrit

- **`supabase/migrations/20260816000000_tables_manquantes_et_saisies_caissier.sql`**
  — les 9 tables manquantes + les 4 nouvelles (`depenses`,
  `inventaires_service`, `inventaire_lignes`, `entrees_stock`) + `sync_rejets`.
  Conventions reprises : `restaurant_id` obligatoire, **PK composite
  (restaurant_id, id)**, RLS forcée. Idempotent.
- **`_shared/tables.ts`** — colonnes autorisées pour les 13 tables. **Vérifiées
  une par une contre le schéma local** : plusieurs de mes suppositions étaient
  fausses (`poste_jour` et non `poste` ; `cloturee_le`/`cloturee_par` et non
  `fermee_*` ; `systeme` et non `verrouille` ; `role_permissions` publie la
  LISTE entière avec `record_id = role_id`, pas une ligne par permission ;
  `disponibilite_locale` a `article_id` pour identifiant). Une colonne mal
  nommée serait passée en silence — `ligneAutorisee` ignore ce qu'elle ne
  connaît pas.
- **`sync-push`** — une table inconnue est désormais **garée dans
  `sync_rejets`** puis acquittée, au lieu de geler le site. La donnée reste
  rejouable. Repli conservé : si le rebut lui-même échoue (cloud pas à jour),
  on bloque plutôt que perdre.
- **POS** — `depenses`, `inventaires_service`, `inventaire_lignes` et
  `entrees_stock` publiés dans la même transaction que la donnée métier :
  création de l'inventaire et de ses lignes, saisie du compté, entrées reçues,
  **validation** (les chiffres figés partent tels quels) et **déblocage
  manager**.
- **Suppressions** : l'outbox n'a pas de DELETE. Une dépense ou une entrée
  effacée est **republiée marquée `supprime: true`** — sans ça elle resterait au
  siège et gonflerait charges ou stock pour toujours. **SamerTrackly doit
  exclure ces lignes de ses totaux.**

### Ordre à respecter, sans exception

1. Appliquer la migration cloud (éditeur SQL Supabase ou `supabase db push`).
2. Redéployer `sync-push` (il connaît les nouvelles tables et le rebut).
3. **Seulement ensuite**, déployer le POS. Publier avant, c'était geler les
   sites ; depuis le rebut, c'est « seulement » perdre la destination — la
   donnée s'entasse dans `sync_rejets` au lieu d'arriver.

### Fiche employé : SamerTrackly est maître — tranché le 2026-08-16

`utilisateurs` était descendue par le siège ET remontée par les sites : la même
ligne, écrite des deux bouts, **le dernier écrasant l'autre en silence**. Le
gérant corrige un téléphone à 14 h, la descente le remet à l'ancien à 14 h 05.

Décision du boss : **le siège est maître, toujours** — c'est déjà l'organisation
réelle (embauche, rôle, taux et départ se décident dans SamerTrackly, et la
caisse a son bouton « Synchroniser »).

Appliqué **au point de passage**, pas dans les dix endroits du POS qui écrivent
la fiche : `REDIRECTION_MONTEE` dans `_shared/tables.ts` + `cibleMontee()` dans
`sync-push` envoient ce qu'un site publie vers **`utilisateurs_site`**, jamais
vers `utilisateurs`. Le siège y lit ce que le restaurant a modifié — et surtout
les employés **créés sur place** (`externe_id` NULL) qui, sinon, n'existeraient
nulle part chez lui. Le POS est inchangé : il continue de publier, la trace est
gardée, mais elle ne peut plus rien écraser.

## Session 2026-08-16 (suite 3) — Jeton KDS trouvable, Équipe en cartes, menu propriétaire

### Le déploiement était bloqué à l'écran cuisine

Signalé par le boss en installant un site : les QR affichés, l'écran cuisine
demande « un nom » introuvable, et **toute** saisie est refusée.

**Cause.** Le KDS ne demande pas un nom mais un **jeton d'appareil**
(`parametres_locaux.kds_jeton_appareil`, correction 3 : l'écran cuisine
s'identifie par appareil, jamais par PIN). `modules/kds/routes.ts` compare au
caractère près — et `preparer-base-master.sql` **supprime** cette clé de l'image
(volontairement : un site ne doit pas hériter du jeton d'un autre). Sur un poste
neuf la clé n'existe donc pas, `attendu` est nul, **et le serveur refuse tout
jeton, y compris le bon**. Aucune valeur à trouver nulle part, et la clé
n'était pas dans les paramètres éditables : blocage par construction.

**Correction** (choix du boss : le poser dans Réglages) :
- `kds_jeton_appareil` ajouté à `PARAMETRES_EDITABLES` (`@pos/shared`) →
  Réglages › Paramètres, « Jeton de l'écran cuisine ». Le PATCH fait un upsert,
  donc poser la valeur crée la ligne absente.
- **Affiché dans la fenêtre « Appareils »**, sous les deux QR — c'est là qu'on
  est au moment d'installer la cuisine. `GET /api/appareils/connexion` renvoie
  `jeton_kds`, réservé à qui a `reglages.parametres` (`null` = pas le droit de
  le voir). **Vide → encart orange** : « aucun jeton défini, l'écran cuisine
  sera refusé », avec le chemin pour le poser. C'est exactement l'état d'une
  image neuve.
- Vérifié à l'écran dans les deux états (vide puis `ALKAYAN-KMS-KDS-1`).
- **La tablette serveur n'est pas concernée** : elle se connecte par profil +
  PIN (`LoginServeur.tsx`), sans jeton d'appareil.

### Réglages › Équipe — cartes au lieu d'un tableau

Le tableau débordait latéralement et empilait trois boutons identiques dans sa
dernière colonne, sur chaque ligne. Désormais une **carte par employé**
(1 à 3 colonnes) : photo, nom, rôle, état en pastille, puis Poste / Téléphone /
Dernière présence en lignes libellées. La **disponibilité reste réglable sans
rien ouvrir** — c'est le seul geste quotidien. Les trois actions (Modifier,
Réinitialiser le PIN, Désactiver) sont repliées derrière **« Détails »**, une
seule fiche ouverte à la fois, *Désactiver* détaché en rouge.

### Menu propriétaire (Supervision) au design v2

Il gardait l'ancien thème : le propriétaire changeait d'univers en passant à la
caisse. Repris sur le langage de l'accueil caissier — même entête (pastille de
synchro, **bascule clair/sombre**, profil, déconnexion), mêmes tuiles à vignette
teintée (Rapports violet comme « Mes ventes », Séquence ambre, Réglages ardoise,
*Basculer en mode caisse* en aplat de marque), bandeau des retours, pied avec
heure et date. Les écrans de Réglages ne sont pas décrits par `DESIGN_V2.md`
(qui ne couvre que la caisse) : rien à y corriger.

## Session 2026-08-16 (suite 2) — RETOURS à la clôture

Nouveau point de clôture demandé par le boss : **un « retour » = un article déjà
lancé en cuisine, supprimé ensuite par le manager ou l'administrateur.** Le
Chawarma est parti au grill, le client change d'avis, le manager l'annule : le
plat a été produit, il n'est pas vendu. **215/215 tests verts**, typecheck
serveur et caisse OK, `dist` caisse reconstruit. **Aucune migration** — la donnée
existait déjà.

**Ce qui existait déjà** (et qu'il ne fallait surtout pas refaire) : annuler un
article **déjà envoyé** exige PIN manager + motif (`ANNULATION_ITEM`, audité avec
le montant) ; ces lignes sont **déjà** hors vente (totaux recalculés) et **déjà**
hors inventaire (`ventesParProduit` ignore les lignes annulées). L'incidence
était donc nulle depuis le début — ce qui manquait, c'est que ça se VOIE.

**Discriminant** : `envoye_le` renseigné, ET (`statut_cuisine = 'ANNULE'` OU
`commandes.statut = 'ANNULEE'`). Une ligne corrigée avant l'envoi (faute de
frappe) n'est pas un retour : rien n'a été produit.

⚠️ **Les deux branches, et c'est un point de CONTRÔLE — corrigé le 2026-08-16
après remarque du boss.** Ma première version ne comptait que la ligne annulée.
Elle laissait grande ouverte la fraude évidente : *le manager encaisse, puis
supprime la table entière au lieu de l'article* — plus aucune trace dans les
compteurs. L'annulation de commande ne touchant pas le statut de ses lignes, il
faut explicitement regarder `commandes.statut`. Le motif et le nom du
responsable ne sont alors pas sur la ligne : ils sont lus dans le **journal
d'audit** (`ANNULATION_COMMANDE`), et le motif s'affiche préfixé
« Commande annulée — … » pour distinguer à l'œil la suppression d'un plat de
celle de toute une table. **Ne jamais restreindre ce filtre à la ligne seule.**

- **Serveur** : `retoursDuService()` / `retoursDepuis()` dans
  `modules/services/rapport.ts`. `RetoursVue` = `nb`, `montant`, `par_produit`
  (pour le ticket) et `detail` (numéro de ticket, motif, **nom du manager qui a
  autorisé**). Ajouté à `StatsService`, donc **figé dans le rapport Z** par le
  spread existant, et remonté au cloud avec le shift.
- **Clôture** : bloc en lecture seule à l'étape *Réconcilier* (sous les
  dépenses, sans jamais s'y ajouter) et sur le **ticket de clôture** ; le
  `reconciliation-preview` porte le bloc.
- **Ticket Z imprimé** (ESC/POS + console) : bloc `RETOURS` après l'inventaire,
  avec la mention « hors vente et hors tiroir ».
- **Mes ventes** : section Retours du service (motif + qui a autorisé) — les
  montants suivent la règle de l'écran, réservés au Rapport X — et carte
  **« Retours du jour »** (tous services) pour le manager.
- **Supervision** : bandeau en tête de l'écran du propriétaire, cliquable vers
  les rapports. C'est la réponse à la demande de départ : voir d'un coup d'œil
  si un site refait souvent ses plats.
- **Route** `GET /api/rapports/retours-jour` (garde `rapports.z`).
- **Test** `test/retours.test.ts` (6 cas) : annulé avant cuisine ≠ retour ; PIN
  manager exigé après envoi ; le retour est compté avec motif et manager ; **une
  commande annulée en entier après envoi compte aussi** ; une commande annulée
  jamais partie en cuisine ne compte pas ; le rapport Z fige le tout **sans
  toucher `total_ventes`, le théorique ni l'écart**.

## Session 2026-08-16 (suite) — Recettes d'inventaire (migration 0022)

Les sorties d'inventaire ne sont plus à 0. **211/211 tests verts**, typecheck
serveur et caisse OK, `dist` caisse reconstruit, migration appliquée sur la base
dev.

**Le défaut corrigé.** `produits_inventaire.article_id` (0021) supposait un lien
un-à-un. En confrontant les 52 produits de comptage aux 128 articles, il est
un-à-plusieurs **dans les deux sens** : « Pain chawarma » ← les 6 Chawarmas,
« Pizza grande (200g) » ← les 16 `Pizza … (G)`, et un « Poulet Pané + Frites »
consomme poulet ET frites. La colonne est **supprimée** ; le pont est la table
`inventaire_consommations (produit_id, article_id, quantite)`.

**Écart assumé avec le plan écrit le 2026-08-15** : `quantite` ne remplace PAS
`ratio` pour les rôles `CONSO_*`. Les deux se **composent** — `quantite` dit
combien d'unités du produit part avec un article vendu (0,5 poulet par
« Demi Poulet Pané »), `ratio` convertit ensuite (100 g de fromage par Manaïche,
38 boules par pot, 8 portions par sachet). Remplacer `ratio` aurait touché des
formules qui sont **le contrat avec SamerTrackly**, pas une interprétation ;
`ventesParProduit()` (`modules/inventaire/service.ts`) somme désormais
`quantité vendue × quantité de la recette`, et `calcul.ts` n'a pas bougé d'une
ligne.

**Jeu de recettes par défaut** — `modules/inventaire/recettes-defaut.ts`, même
patron que `appliquerRoutageDefaut` : appliqué au **seed** et après un **import
catalogue**, idempotent, et **il ne touche jamais un produit qui a déjà une
recette** (sinon une liaison supprimée exprès reviendrait au prochain import).
Sur le catalogue réel : **111 liaisons** posées, dont les 0,5 des demi-poulets et
le ×2 du « 10 Pièces Crispy ». Règles lisibles dans le nom de l'article,
uniquement — la « Manaïche Zaatar » est écartée du fromage (c'est du thym).
Restent **sans recette et volontairement** : Brochette poulet / viande (l'article
« Brochette Frites » ne dit pas laquelle), Boisson 1000f/1500f (dépend du prix du
site), Pain fahita, Cuisses de poulet, Pizza spéciale, Mini pizza, Cornets — plus
les lignes dérivées, qui n'en prennent jamais (Total poulet, Total fromage, Pot
de glace, Sachet de frites, Darina, Poulet frais, Pâte de poulet).

**Écran** Réglages › **Recettes d'inventaire** (garde `reglages.parametres` —
aucune permission nouvelle inventée) : un produit se déplie, on ajoute un article
par recherche, on règle la quantité, on enregistre **en bloc**. Bouton
« Proposer les recettes par défaut » (rejoue le jeu sur les produits vides) et
compteur des produits sans recette, dont les sorties restent à 0. Routes
`GET/PUT /api/admin/recettes-inventaire[/:produitId]` et
`POST …/defaut`, toutes auditées `MODIF_PARAMETRE`.

**Test** ajouté à `test/inventaire-depenses.test.ts` : un produit consommé par
DEUX articles à des quantités différentes (2 × 1 + 3 × 0,5 = 3,5), et une ligne
de consommation qui ne bloque pas la validation.

## Session 2026-08-15 — Portage du design v2 « Duo contrasté » : fondations + serveur

Le design v2 est arrivé par clé USB (`Design-POS-v2` : `DESIGN_V2.md` + maquette
cliquable, tous deux copiés dans `docs/`). Décisions du boss : **portage complet,
y compris les nouveaux modules** (Dépenses, Inventaire, Pointage), et **accueil à
6 tuiles** — entorse assumée au §15 du cahier des charges.

**Feuille de route en 11 tâches.** Faites : 1 à 4. Restent : 5 à 10 (les écrans).

Livré côté fondations (tâches 1-2) : `packages/theme/theme.css` réécrit avec les
jetons v2 (alias conservés vers les anciens noms, pour ne pas casser KDS/serveur/
client pas encore repris), jetons ajoutés aux 4 `tailwind.config.js`, mode
clair/sombre `data-mode` persisté **dans `parametres_locaux`** (réglage du POSTE,
pas du compte, pas du localStorage) via `modules/poste/affichage.ts` +
`stores/affichage.ts`. La lecture du mode est publique : l'écran de connexion
s'affiche avant toute session.

Livré côté base et serveur (tâches 3-4) :

- **Migration 0021** (delta écrit à la main — voir « Migrations Drizzle ») :
  `depenses`, `produits_inventaire`, `inventaires_service`, `inventaire_lignes`,
  `entrees_stock`, + `equipe_service.pointe_le` / `.reste`,
  `utilisateurs.taux_journalier`, `services_caisse.inventaire_valide`. Seed du
  **catalogue de comptage SamerTrackly** (8 catégories, 52 produits, grammages et
  ratios repris tels quels). Miroir fait dans `sql/schema.sql` et dans le schéma
  Drizzle. Tables **LOCALES** : ni descente de synchro, ni `sync_outbox` (le cloud
  n'a pas les tables ; publier vers une table absente ferait échouer toute la
  remontée du site). ⚠ Les QUANTITÉS y sont numériques, pas entières (fromage en
  grammes, glace en pots de 4,5) ; seuls les MONTANTS restent des entiers FCFA.
- **Piège rencontré** : le `_journal.json` de drizzle avait été réécrit en
  PowerShell et portait un **BOM UTF-8** → `JSON.parse` échoue et AUCUNE migration
  ne passe. Toujours écrire ce fichier en UTF-8 **sans** BOM.
- **Modules serveur neufs** : `modules/depenses` (registre, salaires,
  encouragements, paie & départs), `modules/pointage` (arrivée datée par le clic,
  service de 8 h, départs), `modules/inventaire` (`calcul.ts` porte les formules
  dérivées reprises à l'identique de SamerTrackly ; `service.ts` l'accès aux
  données ; `routes.ts` l'écran). Garde : `caisse.service.ouvrir` — **aucune
  permission nouvelle inventée**, le catalogue est fixe et une clé neuve serait
  décochée sur tous les rôles déjà en base.
- **Clôture (§6.10)** : refusée tant que l'inventaire n'est pas validé, sauf
  déblocage manager (PIN + motif, audité `DEBLOCAGE_INVENTAIRE`). Les **dépenses
  ne sont plus envoyées par la caisse** : le serveur additionne le registre. À la
  clôture, toute personne non marquée « Reste » est enregistrée comme **partie**.
  Le ticket Z porte un bloc `inventaire` (information manager, **sans effet sur la
  vente ni sur l'écart**) et le décompte `equipe`.
- **Sorties automatiques : `produits_inventaire.article_id` a la MAUVAISE FORME.**
  Constaté le 2026-08-16 en confrontant les 52 produits de comptage aux 128
  articles de vente : le lien est **un-à-plusieurs**, pas un-à-un. Un produit
  d'inventaire est consommé par TOUTE une famille d'articles :
  - « Pain chawarma » ← les 6 Chawarmas ;
  - « Manaïche (100g) » ← les 7 Manaich ;
  - « Pizza grande (200g) » ← les 13 `Pizza … (G)`, « Pizza moyenne (160g) » ← les 13 `(M)` ;
  - « Portions de frites » ← tout ce qui est « + Frites » (une quinzaine d'articles) ;
  - « Glace 2 boules » ← Glace (2 Boules), « Milkshake/Spéciale » ← Milkshake + Glace Spéciale ;
  - « Pané / Rôti / Braise » ← les Demi Poulet et Poulet correspondants.
  Certains articles consomment même **plusieurs** produits à la fois (un « Poulet
  Pané + Frites » sort du poulet ET des frites ET du pain, selon la recette).

  Une colonne `article_id` unique ne peut pas porter ça. Il faut une **table de
  liaison** `inventaire_consommations (produit_id, article_id, quantite)` — la
  `quantite` étant le nombre d'unités du produit consommées par article vendu
  (1 pain par chawarma, 1 portion de frites par assiette, etc.), ce qui remplace
  aussi l'usage actuel de `ratio` pour les CONSO_*.

  Tant que ce n'est pas fait, les sorties restent à 0 et le théorique se réduit à
  initial + entrées : l'inventaire fonctionne, mais il compare le compté à un
  théorique qui ignore les ventes. **À traiter avant la mise en service réelle de
  l'inventaire.** Chantier : migration 0022 (table de liaison + reprise de
  `ratio`), adaptation de `ventesParProduit()` dans
  `modules/inventaire/service.ts`, écran de réglages pour éditer les recettes, et
  un jeu de liaisons par défaut à seeder.
- Tests : **209/209 verts** (+11). Nouveau fichier `test/inventaire-depenses.test.ts`
  (formules dérivées, manquant chiffré, verrou, déblocage, salaires, départs). Le
  helper `validerInventaire()` de `test/aide.ts` est désormais **obligatoire avant
  toute clôture** dans les tests. `resetDonnees` vide `produits_inventaire` (par
  CASCADE avec `articles`) : les autres tests ont donc un inventaire vide.

Livré côté écrans (tâches 5-7), vérifié à l'écran dans un navigateur :

- **Accueil à 6 tuiles** (`screens/Accueil.tsx`) : Dépenses et Inventaire
  rejoignent les 4 existantes, vignettes teintées par `color-mix` (la teinte
  s'éclaircit en mode sombre, sinon elle disparaît), bascule clair/sombre dans
  l'entête, pastilles (nombre de dépenses, « ! » tant que l'inventaire n'est pas
  validé). Le sous-titre affiche l'heure d'ouverture et le fond de caisse.
- **Bandeau d'équipe** (`components/BandeauEquipe.tsx`, § 6.7) : replié par
  défaut (avatars empilés + compteurs + « Pointer une arrivée » sans déplier),
  déplié il tient sur UNE ligne de 4 qui défile — la hauteur ne bouge jamais,
  que l'équipe compte 4 personnes ou 40. Toute la barre est la zone de pli.
- **Écran Dépenses** (`screens/Depenses.tsx`) et **écran Inventaire**
  (`screens/Inventaire.tsx`) : voir § 6.8 / § 6.9 du design.
- **Deux défauts trouvés en essayant l'app, corrigés** : (1) l'équipe cochée à
  l'ouverture n'était **pas pointée** (`pointe_le` restait NULL) — cocher
  quelqu'un, c'est déclarer qu'il est là, son arrivée est donc datée de
  l'ouverture ; (2) **le seed laissait le catalogue de comptage VIDE** : son
  `TRUNCATE ... articles ... CASCADE` emporte `produits_inventaire`, donc après
  `db:migrate && db:seed` l'écran Inventaire n'affichait rien et la validation
  passait sans rien compter — le verrou de clôture ne verrouillait plus rien.
  Le catalogue vit désormais dans `db/catalogue-inventaire.ts`, réinséré par le
  seed ; il doit rester identique à celui de la migration 0021.
- Rappel confirmé en conditions réelles : le **service worker de la PWA ressert
  l'ancien shell** après un rebuild. En dev, purger `serviceworkers` +
  `cachestorage` ; dans le kiosque, `main.js` le fait au démarrage.

Livré côté clôture (tâche 8) :

- **Étape 1 verrouillée** sans inventaire validé : encart rouge avec le nombre
  de produits restants, « Aller à l'inventaire » et « Débloquer (manager) »
  (la modale de déblocage d'`Inventaire.tsx` est exportée et réutilisée là où le
  caissier bute réellement).
- **Dépenses en lecture seule**, reportées du registre avec le nombre de lignes.
- Étape **Confirmer** : annonce « X restent · Y seront enregistrés comme partis »
  avant validation — l'enregistrement est irréversible.
- **Ticket Z** (écran, ESC/POS et console) : bloc Inventaire marqué *information
  manager, sans effet sur la vente ni sur l'écart*, et décompte présents /
  restent / partis.

⚠ **Écart avec le document** : `DESIGN_V2.md` § 6.10 annonce les livraisons
partenaires « saisissables ». **Le boss a tranché l'inverse le 2026-08-15 : elles
ne sont PAS modifiables.** Appliqué côté serveur (la route de clôture ignore le
champ `livraisons` du corps et recalcule depuis les commandes payées), pas
seulement côté UI. Même traitement pour `depenses`. Les deux champs restent
acceptés par le schéma Zod pour ne pas casser une caisse pas encore rebuildée,
mais sont marqués `@deprecated`. Un test envoie volontairement de faux montants.
Le document reste à corriger sur ce point.

Livré côté restyle (tâche 9, partiel) :

- **Tables** (§ 6.3) et **Commande** (§ 6.4) partagent l'ossature de la maquette :
  barre ardoise en haut, puis la grille
  **`186px 1fr clamp(280px, 27vw, 356px)`** — colonne de gauche en ardoise
  (`--ard-800`, libellés + compteurs, pas un rail d'icônes), plan de travail
  clair au centre, panneau de droite en ardoise (`--ard-850`, pied `--ard-900`).
  Le `clamp` sur la 3ᵉ colonne n'est pas une coquetterie : **l'écran de ce poste
  fait 1024×768**, et les 356 px fixes de la maquette n'y laissaient que 482 px
  au centre — trop peu d'écart avec la droite (refusé le 2026-08-16). La colonne
  droite retrouve ses 356 px dès ~1320 px de large. Le centre reste toujours le
  plus large, c'est là que le caissier travaille.
  ⚠ **Aucun point de rupture responsive sur ces deux écrans, volontairement.**
  Une première version utilisait `lg:` : sous 1024 px tout s'empilait et les
  zones/catégories remontaient EN HAUT — ce n'est pas le plan de la maquette, et
  le boss l'a refusé le 2026-08-16. La caisse tourne sur un kiosque, la largeur
  est connue : pas de repli.
  Tables : zones avec `occupées/total` et point orange quand la zone appelle ;
  cartes **peintes en plein dans la couleur d'état** (LIBRE reste blanche à filet
  pointillé), montant en cours et ancienneté en bas, `pulse-ok` sur PRETE ;
  « Coup d'œil salle » à droite. Couleurs reprises telles quelles de la maquette
  (`EN_PREPARATION #ef9f27`, `SERVIE #3b82f6`…).
  Le composant partagé `PlanSalle` (@pos/shared-ui) n'a **pas** été touché : il
  reste celui de la tablette serveur, qui n'a ni la place ni l'usage de ces
  trois colonnes.
- **Paiement** (§ 6.5 / § 4.2) : modes de paiement aux **vraies couleurs
  d'opérateur** (jetons `--pay-*`), bouton d'ajout teinté du mode sélectionné,
  et récapitulatif de droite passé en **ardoise** avec le Reste à payer en très
  grand.

**Reste à faire** : *rien de ce paragraphe.* Les tâches 9 et 10 sont faites, et
le mappage produit de comptage ↔ articles de vente aussi (migration 0022) —
voir les deux sections du 2026-08-16 en tête de fichier.

## Session 2026-08-13 — La base du master n'avait pas la migration 0020

Validation en conditions réelles de la saisie optimiste (livrée la veille, jamais
essayée à l'écran). **Le parcours était en fait bloqué** : la base `pos_samer` du
master s'arrêtait à **20 migrations (0000→0019)**, la 0020 n'ayant été appliquée
la veille que sur base jetable et base de test. `GET /api/catalogue` répondait
donc **500** (`relation "options_catalogue" does not exist`) et l'écran de
commande restait sur « Chargement… » indéfiniment.

**Portée réelle du défaut** : le déploiement copie `data/pgdata` du master tel
quel. Fabriquer la clé USB en l'état aurait envoyé sur les 7 sites une caisse
incapable d'ouvrir le moindre écran de commande.

- Corrigé : sauvegarde `sauvegardes\pos_samer_avant_0020.dump` (`pg_dump -F c`)
  puis `db/migrate.ts` → **21 migrations**, reprise des anciennes options en
  **5 `options_catalogue` + 5 `options_liaisons`**.
- Vérifié en base : `KDO` bien en zone RC, `SAMER DELLY` renommée, 16 tables.
- **Règle qui en découle** : appliquer les migrations **à la base du master**
  fait partie de la livraison, au même titre que `pnpm --filter caisse build`.
  Une migration validée sur base jetable n'est pas une migration livrée.

**Saisie optimiste — validée à l'écran** (login proprio → mode caisse → service
25 000 → table T1 → 5 articles → envoi cuisine → encaissement espèces) :
- une ligne en vol s'affiche **sans montant** (« … » + « Enregistrement… ») ;
- le total garde la **dernière valeur serveur** avec la pastille « recalcul… » —
  jamais un total deviné côté client ;
- Remise / Facture / Envoyer / ± / Encaisser sont `disabled` sur
  `saisie.enAttente` (`Commande.tsx`) ;
- addition finale exacte : **16 000 F** à l'écran = `commandes.total` = somme des
  paiements en base, ticket n° 13 **PAYEE**, 5 lignes.
- Aucune erreur serveur après la migration (les seuls 500 du journal sont les
  deux `/api/catalogue` d'avant correctif).

## Session 2026-08-12 (suite 5) — Options réutilisables (migration 0020)

Onglet **Réglages › Options**. Remplace les anciens `groupes_options`/`options`
(choix gratuits groupés) et `supplements` (extras payants), tous deux liés à un
seul article.

- **Modèle** : `options_catalogue` (nom + prix unique, 0 = offerte) et
  `options_liaisons` (vers une **catégorie entière** OU un **article**). Les
  options d'un article = celles de sa catégorie **∪** les siennes. Règle unique
  dans `modules/catalogue/options.ts`, partagée par la lecture du catalogue ET la
  validation à l'ajout : les deux DOIVENT voir le même ensemble.
- **Tables locales, volontairement hors `sync/descente.ts`** : une descente du
  siège ne les écrase jamais. `sync_outbox` est déjà alimentée pour brancher le
  cloud plus tard.
- **L'instantané ne change pas de forme** : une option cochée s'écrit dans
  `commande_items.supplements` en `{nom, prix}` → tickets, bons cuisine, KDS et
  rapports intacts. Prix figé à l'ajout (vérifié).
- **Anciennes tables conservées** (non lues) : les supprimer ferait échouer une
  future descente cloud qui les alimente encore.
- **Contrainte perdue, assumée** : plus de « choisir exactement 1 sauce » — le
  modèle est une liste d'extras à cocher. La reprise a créé une option par couple
  (nom, prix) distinct, jamais de fusion de deux prix (ce serait modifier un prix
  de vente en silence).
- *Piège* : écrire `drizzle/meta/_journal.json` avec `Set-Content -Encoding utf8`
  ajoute un **BOM** que `JSON.parse` refuse → migrations muettes. Utiliser
  `[IO.File]::WriteAllText` avec `UTF8Encoding($false)`.
- **Validé** : 198/198 tests serveur, migration idempotente, héritage sur les
  32 pizzas, refus serveur d'une option non liée.

## Session 2026-08-12 (suite 4) — Saisie optimiste de l'addition

Latence au clic pendant la prise de commande. Périmètre volontairement limité à
`apps/caisse` : déploiement par `pnpm --filter caisse build`, **sans repackaging
de l'exe**.

**Invariant à ne JAMAIS casser — aucun calcul monétaire côté client.**
`apps/caisse/src/saisie-optimiste.ts` n'affiche optimistiquement que du NON
monétaire (présence d'une ligne, son nom, sa quantité). Le total dépend de la
meilleure promo active à l'horloge du **serveur**, du prix de canal
(`prix_canaux`) et d'un écrêtage en cascade remise → promo → fidélité ; il est lu
à voix haute au client, un montant faux même 200 ms est inacceptable.

- **Écho WebSocket** (`echo-mutations.ts`) : le serveur diffuse `commande` à tous
  après chaque mutation, sans identifiant d'émetteur — la caisse recevait son
  propre écho et invalidait `['commande', id]` qu'elle venait de peupler
  (~4 requêtes par tap). Neutralisé par jeton posé **avant** l'envoi.
- La caisse ne peut pas devenir sourde : **seul le type exactement égal à
  `commande` est neutralisable** (le KDS émet `commande:modifiee`/`:servie`, la
  tablette `commande:envoyee`). **Ne jamais élargir ce filtre à `startsWith`.**
- Mutations sérialisées (une requête en vol) : deux PATCH concurrents sur le même
  article n'ont pas d'ordre garanti côté serveur.
- `crypto.randomUUID()` est indisponible (caisse en `http://IP-LAN`, contexte non
  sécurisé) → compteur local, même piège que `apps/client/.../PageTable.tsx`.
- Retour arrière : `apps/caisse/dist.avant-optimisation` → recopier sur `dist`,
  aucun rebuild ni repackaging.
- **Validé à l'écran le 2026-08-13** (voir la session du jour).

## Session 2026-08-12 (suite 3) — L'écran blanc au redémarrage par l'icône

Symptôme terrain : après une longue session, relancer par l'icône donnait une
**fenêtre blanche sans données**, « comme si l'appli refusait de charger »,
alors que PostgreSQL tournait. Trois chemins menaient là ; les trois sont
bouchés.

**1. `/api/sante` mentait.** La route répondait `{ ok: true }` **sans jamais
toucher la base**. Un serveur debout mais coupé de PostgreSQL (machine sortie
de veille, PG redémarré sous l'app, pool mort) était donc déclaré « prêt » : la
coquille chargeait la caisse, qui n'avait aucune donnée à afficher — et l'écran
d'erreur ajouté plus tôt se faisait berner de la même façon. La route fait
désormais un vrai `SELECT 1` (garde de 2 s) et renvoie **503** sinon.
*Vérifié* : base debout → `200 {"ok":true,"base":true}` ; PostgreSQL coupé sous
un serveur resté debout → **503**.

**2. Aucun verrou d'instance unique.** Cliquer sur l'icône alors que la caisse
tournait déjà lançait une **deuxième application complète** qui (a) démarrait un
second serveur sur le port 3001 déjà pris, lequel mourait aussitôt ; (b)
purgeait le cache de la session partagée sous les pieds de la première ; (c)
ré-extrayait l'exe portable **par-dessus les fichiers en cours d'usage** (le
dossier d'extraction `PosSamerApp` est fixe). `requestSingleInstanceLock()` :
le second lancement ramène la fenêtre existante au premier plan et se termine.
- **Piège évité de justesse** : sortir par `app.quit()` passait par
  `before-quit` → `arreterProprement()` → **`pg_ctl stop`**, donc ce lancement
  de trop aurait coupé PostgreSQL sous la caisse active. On sort par
  `app.exit(0)`, et `arreterProprement()` refuse désormais de s'exécuter dans
  une instance qui ne détient pas le verrou.
- *Vérifié* : app lancée, puis relancée → journal « Second lancement detecte :
  on ramene la fenetre existante au premier plan » puis « Instance deja en
  cours : ce lancement rend la main et se termine » ; **aucun processus
  résiduel** (les 6 restants descendent tous du premier lancement), PostgreSQL
  intact, `/api/sante` toujours 200, les 4 ports ouverts.

**3. Fenêtre qui échoue à charger, en silence.** En kiosque sans bordure,
`did-fail-load` et un processus de rendu mort ne montrent **rien** : écran
blanc. Les deux basculent maintenant sur l'écran d'erreur (avec garde
anti-boucle si l'écran d'erreur échouait à son tour).

**Validé** : typecheck serveur OK, **suite complète 198 tests verts**, exe
repackagé (15:11) et copié à la racine.

## Session 2026-08-12 (suite 2) — Deux comptes propriétaire dans l'image

L'image de déploiement porte désormais **exactement deux comptes**, tous deux
PROPRIETAIRE (`db/seed.ts`) :
- **SAMER Zreik** — PIN **852741** (remplace l'ancien « Samer El Khoury ») ;
- **Admin Willy** — PIN **2212**, l'administrateur qui installe et dépanne les
  7 sites.

Aucun autre employé n'est seedé : le reste de l'équipe arrive par Réglages →
Équipe ou la descente SamerTrackly (les seeder enverrait les comptes du premier
restaurant sur tous les autres).

**Pour les postes DÉJÀ déployés**, qui portent encore le compte unique et ne
peuvent pas être reseedés sans perdre catalogue, plan de salle et ventes :
`apps/server/src/scripts/comptes-proprietaire.ts`, **idempotent**. Il renomme
l'ancien propriétaire **sans toucher à son id ni à son PIN** — ses ventes, ses
shifts et ses lignes d'audit y sont rattachés, un nouveau compte les
orphelinerait — puis crée Admin Willy (ou le remet d'aplomb : rôle, PIN,
réactivation, déverrouillage). Sur un poste déployé, pnpm n'existe pas :
`node node_modules\tsx\dist\cli.mjs src\scripts\comptes-proprietaire.ts`.

`preparer-base-master.sql` filtre sur le RÔLE (`role_id NOT IN (… PROPRIETAIRE)`)
et conserve donc **les deux** comptes à la préparation de la clé — vérifié.

**Validé** : seed sur base neuve → 2 comptes PROPRIETAIRE actifs, les deux PIN
vérifiés par argon2 (et un PIN faux rejeté) ; script rejoué **deux fois** sur
`pos_samer`, mêmes PIN valides à l'arrivée ; typecheck serveur OK.

## Session 2026-08-12 (suite) — Kdo, Samer Delly, tables partenaires accessibles

**1. Kdo — le repas offert.** Nouvelle table virtuelle **KDO en zone RC** (et non
en « Livraison » : le cadeau se consomme sur place). Une commande prise dessus
est marquée `offert` **par le serveur**, d'après la table — jamais sur la foi du
client : offrir sort de la marchandise sans contrepartie, ça ne se décide pas
côté navigateur. Elle se clôture par `POST /api/commandes/:id/offrir`, qui la
passe à PAYEE **sans aucune ligne de paiement**.

*Règle comptable (formulée par le client) :* « je vends 25 000 et Kdo 5 000, ma
vente est **30 000** et non 25 000 ». Le Kdo se comporte donc comme une
livraison Yango — il compte dans la vente du shift — mais n'ajoute pas un franc
au tiroir. Concrètement :
- `total_ventes` l'inclut déjà (toute commande PAYEE) ;
- le théorique espèces l'ignore par construction (il ne somme que les
  paiements encaissés) → **aucun écart de caisse** ;
- `vente_totale`, elle, est RECONSTITUÉE à partir des montants déclarés à la
  clôture. Il a donc fallu y ajouter `offerts.total` **côté serveur ET côté
  caisse** (`Cloture.tsx` recalcule le même chiffre pour l'afficher) : sans ça,
  chaque cadeau creusait un **faux écart de réconciliation**, le total système
  les comptant déjà. Les deux calculs doivent donner le même résultat, sinon
  l'écran annonce un total différent de celui figé sur le ticket.
- **Motif obligatoire, sans PIN manager** (décision client : le caissier peut
  offrir seul). Tracé en audit `COMMANDE_OFFERTE` + imprimé sur le reçu
  (« *** OFFERT — KDO *** » + motif). Ceinture de sécurité en base : CHECK
  `motif_offert_obligatoire` (offert + PAYEE ⇒ motif non nul) — vérifié.
- Affiché partout où le caissier/gérant compte : aperçu de réconciliation,
  ticket de clôture, rapport Z imprimé, récap de séquence, écran Séquence.

**2. `SAMER_DELIV` → `SAMER_DELLY`, code compris** (choix explicite du client,
l'option légère « libellé seulement » a été écartée). Migration **0019** :
`UPDATE` sur `commandes.partenaire`, `prix_canaux.canal`, `tables_salle`
(partenaire + numéro). Aucune contrainte CHECK ne portait sur ces valeurs.
- Les **rapports Z et de séquence déjà figés** gardent `SAMER_DELIV` : ce sont
  des archives immuables, on ne réécrit pas l'histoire. `LIBELLES_PARTENAIRES`
  garde donc l'ancien code en lecture seule et `libellePartenaire()` affiche
  « Samer Delly » dans les deux cas.
- ⚠️ **Le renommage ne remonte pas au cloud** : les `UPDATE` d'une migration
  n'écrivent pas dans `sync_outbox` (c'est le code applicatif qui le fait, en
  transaction). Sans effet aujourd'hui — aucun site n'est enrôlé — mais un
  poste enrôlé plus tard remonterait ses anciennes commandes en `SAMER_DELIV`.

**3. On entre enfin dans une table partenaire depuis le plan de salle.** Cause
du blocage : « Nouvelle commande → Livraison » créait la commande **sans
`table_id`** (`Accueil.tsx`), donc la table virtuelle restait éternellement
« Libre » et le clic répondait « passez par Nouvelle commande ». Corrigé des
deux côtés (l'accueil rattache désormais la table, la modale du plan de salle
aussi). Le mécanisme d'entrée dans une table occupée existait déjà.
- `chargerTables` expose **toutes** les commandes en cours par table
  (`commandes_ouvertes`), pas seulement la première : plusieurs commandes
  coexistent sur une table virtuelle pendant un rush (deux livreurs Yango en
  même temps). Le clic ouvre une modale : liste des commandes en cours (on
  entre pour ajouter des produits) + « Nouvelle commande <partenaire> ».

**4. Validé** : 6 apps typecheckées ; **suite complète 198 tests verts**
(33 fichiers, +7 nouveaux dans `test/kdo.test.ts`, dont le scénario chiffré
ci-dessus) ; migration rejouée **deux fois** sur base jetable (idempotente,
table KDO recréée en RC, renommage complet) ; appliquée à `pos_samer` ; caisse
rebuildée.

**PIÈGE MAJEUR découvert — `packages/*` ne se propage pas tout seul.** Avec
`injectWorkspacePackages: true`, `@pos/shared` est **copié** dans chaque app.
Modifier `packages/shared/src/...` ne change RIEN pour les apps tant que la
copie n'est pas refaite, et **`pnpm install` répond « Already up to date » sans
la refaire — même avec `--force`, et même après avoir supprimé les copies**
(pnpm ne les recrée pas non plus). Les apps compilent alors contre une version
périmée : erreurs de type incompréhensibles, ou pire, aucune erreur et un
ancien comportement à l'exécution. D'où **`app/scripts/propager-paquets.ps1`**
(robocopy `/MIR`, lit les dépendances `@pos/*` de chaque manifeste), **à lancer
après toute modification de `packages/*`, avant tout typecheck ou build**.

## Session 2026-08-12 — `PosSamer.exe` ne démarrait plus le serveur (caisse vide)

**Symptôme terrain, après copie de la clé master sur un poste :** la fenêtre
kiosque s'ouvrait normalement mais la caisse était **vide** — aucune donnée,
aucune API. La base était pourtant bonne (128 articles, 15 catégories, seed
neutre `Restaurant à configurer` = normal, cf. README étape B3).

**Cause :** le lanceur `apps/desktop/main.js` cherchait `tsx` dans
`apps/server/node_modules` et `vite` dans `apps/<app>/node_modules`. Or le
workspace est passé en **`nodeLinker: hoisted`** (`pnpm-workspace.yaml`, pour
que la copie sur clé USB n'ait aucun lien symbolique à recréer) : les
dépendances ne sont plus QUE dans le `node_modules` de la racine — seuls les
paquets `@pos/*` restent injectés dans les apps. Les chemins en dur ne
résolvaient donc plus rien, le serveur sortait aussitôt en **code 1**, et la
fenêtre s'affichait quand même. **Le master avait le même bug** : l'exe du
03/08 est antérieur au passage en hoisted.

- **Correctif** (`main.js`) : helper `resoudreCli(dossierApp, ...sousChemin)`
  qui essaie `apps/<app>/node_modules/...` **puis** `app/node_modules/...`, et
  journalise « CLI introuvable » avec les deux chemins testés. Valable quel que
  soit le linker, donc pas de régression si on revient un jour en isolé.
- Les erreurs de lancement KDS/serveur/client passent de `console.error` (perdu
  en double-clic, sans console) au **journal** `%TEMP%\possamer-demarrage.log`,
  avec le code de sortie.
- **Repackaging** : deux pièges nouveaux, tous deux dus au hoisting, gravés
  dans `apps/desktop/package.json` :
  - `electronVersion: "33.4.11"` + `electronDist: "../../node_modules/electron/dist"`
    — sinon electron-builder ne trouve pas electron (« Cannot compute electron
    version ») et voudrait le retélécharger.
  - `npmRebuild: false` — electron-builder lançait un `pnpm install` dans
    `apps/desktop` (« installing production dependencies ») qui **a voulu
    purger `node_modules`** ; seul l'absence de TTY l'a arrêté. Ce paquet n'a
    aucune dépendance de production (l'asar = main.js + preload + icône +
    package.json), l'étape est inutile. **Ne jamais poser `CI=true` pour
    contourner ce message : ça autoriserait la purge.**
- **Validé sur ce poste** : serveur lancé via le `tsx` de la racine →
  `/api/sante` = 200 ; exe repackagé, copié à la racine, lancé → journal sans
  erreur, **ports 3001 / 5174 / 5175 / 5176 tous ouverts**, arrêt propre
  (PG coupé avec l'app). Ancien exe conservé en
  `PosSamer.exe.avant-correctif-hoisted`.

**Écran « La caisse n'a pas pu démarrer » (même session).** C'est l'absence de
message qui a coûté le temps de diagnostic : la fenêtre kiosque s'ouvrait
normalement sur une caisse vide, et sur un site personne ne lit
`%TEMP%\possamer-demarrage.log`. Désormais, si `/api/sante` ne répond pas dans
les 45 s, la fenêtre affiche un écran sombre à l'accent orange qui donne :
- une phrase en français courant (« Le matériel n'est pas en cause… Aucune
  vente n'est perdue ») ;
- **la cause exacte** encadrée — `dernierEchec`, alimenté par `resoudreCli`
  (« Fichier manquant : tsx/dist/cli.mjs. L'installation est incomplète… ») ou
  par la sortie du serveur (« Le serveur s'est arrêté tout seul (code 1) ») ;
- deux boutons ≥ 56 px : **Réessayer** (IPC `reessayer-demarrage` → relance PG +
  serveur sans quitter, puis charge la caisse ou réaffiche l'erreur) et
  **Fermer l'application** ;
- un dépliant « Détails techniques » avec le chemin du journal et ses
  12 dernières lignes, à lire au support par téléphone.

Le démarrage et le réessai partagent le même helper `demarrerEtAfficher()`.
KDS/serveur/client ne sont plus lancés si la caisse elle-même n'a pas démarré.
`preload-bouton.js` expose `window.posSamer.reessayer` en plus de `fermer`.

*Validé en provoquant une vraie panne* (renommage temporaire de
`node_modules/tsx/dist/cli.mjs`) : écran affiché avec la bonne cause, puis
fichier restauré à chaud et clic réel sur « Réessayer » → journal « Reessai
demande », serveur reparti, **les 4 ports rouverts**, arrêt propre.

**À faire sur les postes déjà déployés :** il suffit de **remplacer
`PosSamer.exe`** par celui-ci (le `main.js` est empaqueté dans l'asar : corriger
le fichier source sur le poste ne change rien tant que l'exe n'est pas
remplacé). Aucun Mode développeur ni droit admin requis sur le site — le
repackaging se fait ici, sur le master. En dépannage immédiat,
`demarrer-pos.bat` n'était pas touché par le bug.

**Rappel installation :** chemin court (`C:\POS-Samer`, cf. README) et copie
**complète** de `node_modules` — sur le poste concerné il manquait des paquets
(`tsx` absent), signe d'une copie partielle, réparée par un `pnpm install`
(20 min, et il faut internet — ce qu'un restaurant n'a pas forcément).

## À REPRENDRE (2026-08-10)

**Action en attente : relancer `PosSamer.exe`** (`Ctrl+Alt+Q` puis rouvrir) pour
charger les 4 changements ci-dessous. Caisse rebuildée (`dist` à jour), serveur
en tsx (relance suffit), **pas de repackaging** (le shell desktop n'a pas bougé).

**Puis, une fois relancé : Réglages → Imprimantes → « Tester » sur la Caisse.**
Le ticket de test est devenu un outil de calibration en 2 parties :
1. **Largeur du papier** — 3 barres d'essai `[ 32 ===]`, `[ 42 ===]`,
   `[ 48 ===]` : garder la plus grande qui tient sur UNE ligne.
2. **Logo** — le même logo en mode A (raster) et mode B (bandes) : garder celui
   qui sort propre, ou « Pas de logo » si les deux échouent.
Les deux se règlent juste en dessous, dans Réglages → Imprimantes.

## Session 2026-08-10 — Lisibilité des tickets, gérant, shift unique

**1. Police des tickets agrandie** (`printer/escpos.ts`). L'imprimante n'a que sa
police interne Font A (12×24 pts, 48 colonnes en 80 mm) : on ne la remplace pas,
on la multiplie (ESC/POS `GS ! n`, ×1 à ×8, largeur et hauteur indépendantes).
- `Ruban.taille(largeur, hauteur)` remplace l'ancien `taille(boolean)` et
  **mémorise la largeur courante** : `duo()` et `tiret()` calculent leurs
  colonnes à partir d'elle (48 en ×1, 24 en ×2), donc l'alignement des prix
  suit automatiquement si on agrandit un jour la largeur d'une ligne à deux
  colonnes.
- Constantes en tête de fichier : `TAILLE_BON_ARTICLE` = ×2 largeur ×2 hauteur
  (bon cuisine lu à distance), `TAILLE_RECU_ARTICLE` = ×1 largeur ×2 hauteur
  (reçu client : 48 colonnes préservées → prix alignés). Suppléments et options
  restent secondaires (normal sur le reçu, double hauteur sur le bon).

**2. Logo du ticket : réparé, à choisir sur pièce.** Cause identifiée :
l'imprimante caisse est une **WOOSIM WSP-CP383** (imprimante *mobile*), et le
logo était envoyé en `GS v 0` (raster). Une imprimante qui ne reconnaît pas une
commande n'ignore pas ce qui suit : elle l'**imprime comme du texte** → les
pages de charabia avant les articles. Les Woosim n'ont jamais implémenté
`GS v 0`. Aggravant : le PNG Al Kayan (2356×2825) donnait un raster de
**460 lignes / 22 Ko** d'un bloc, de quoi saturer le tampon d'une mobile.
- `printer/logo.ts` réécrit : le PNG devient un **bitmap** intermédiaire, puis
  est encodé au choix en `raster` (GS v 0) **ou en `bandes` (ESC \* mode 33)**
  — la vieille commande bit-image par tranches de 24 points, dénominateur
  commun de tout ce qui s'appelle ESC/POS, Woosim comprise.
- **Plafond `HAUTEUR_MAX_POINTS = 160`** (~2 cm), largeur réduite avec pour
  garder les proportions : Samer 384×186 → 328×159 (6,5 Ko), Al Kayan
  384×460 → 128×153 (2,4 Ko).
- **Le ticket de TEST imprime les deux modes, étiquetés A et B** — seule façon
  de savoir ce que comprend l'imprimante sans risquer un vrai ticket client.
- Nouveau réglage `ticket_logo` (`aucun` | `raster` | `bandes`), **défaut
  `aucun`**, dans Réglages → Imprimantes (bloc « Logo sur le ticket », route
  `POST /api/admin/imprimante/logo`, audité `MODIF_PARAMETRE`).

**2 bis. Montants coupés en deux (« 5 » en haut, « 000 F » en bas).** DEUX
causes distinctes, toutes deux corrigées — dans les deux cas la ligne dépassait
la largeur physique, et une imprimante ne tronque pas : elle **renvoie le
surplus à la ligne suivante**.
- *Largeur du papier codée en dur à 48.* `LARGEUR = 48` est remplacé par un
  `Ruban(papier)` : la largeur vient du paramètre **`ticket_colonnes`**
  (32 / 42 / 48, défaut 48), réglable dans Réglages → Imprimantes
  (`POST /api/admin/imprimante/colonnes`). Beaucoup de 80 mm n'impriment que
  42 colonnes (512 points au lieu de 576) ; une 58 mm en fait 32. **La partie 1
  du ticket de test sert à trancher.**
- *Libellé trop long.* Même à la bonne largeur, `2 x Assiette grillades mixtes
  avec frites maison` + le montant dépassait. `duo()` **replie désormais le
  libellé par mots** (un mot plus long que la ligne est coupé net) et garde le
  montant seul aligné à droite sur la dernière ligne. Vérifié à 32/42/48 sur un
  reçu réaliste, y compris un nom de 70 caractères sans espace : plus aucun
  débordement.
- L'horodatage passe au format court (`Ticket 42 - 10/08/26 17:49`) : le format
  long faisait 33 caractères et débordait sur une 58 mm.
- `imprimerTest` est scindé en `construireTest()` (pur, testable) + envoi.

**2 ter. Le rasage de séquence imprime enfin son récap.** La clôture figeait le
`RapportSequence` en base mais **n'imprimait rien** — le gérant repartait sans
papier. Ajouté `imprimerRapportSequence()` à `PrinterService` (+ ConsolePrinter
et EscposPrinter) : un bloc par shift (caissier, début/fin, fond, ventes,
dépenses, espèces comptées, modes déclarés, livraisons, **écart**), puis les
totaux du jour et une ligne « Signature du gérant ». Sort sur l'imprimante
**Caisse**, **hors transaction** — une panne d'imprimante ne doit pas annuler un
rasage. Filet : `POST /api/sequences/:id/reimprimer` (garde
`caisse.fermer_sequence`, relit le rapport figé) + bouton **« Réimprimer le
récap »** sur l'écran de fin. Rendu vérifié en 32/42/48 colonnes, sans
débordement.

**3. Le gérant n'est plus forcé d'ouvrir un shift.** Il était renvoyé sur
`OuvertureService` dès l'accueil, donc obligé d'ouvrir un service… ce qui
l'empêchait ensuite de raser la séquence (« des shifts sont encore ouverts »).
- `stores/session.ts` → `ecranInitial()` : atterrissage **Supervision** si
  proprio, superviseur **ou porteur de `caisse.fermer_sequence`** (le gérant).
  Il y trouve Rapports, Fermeture de séquence, Réglages et « Basculer en mode
  caisse » — ouvrir un shift devient un choix explicite.
- `Supervision.tsx` : le header affichait « Propriétaire »/« Superviseur » en
  dur → affiche le vrai `role_nom`. `OuvertureService.tsx` : bouton « Retour à
  la supervision » pour eux (règle partagée via `ecranInitial`).

**4. Un seul shift ouvert à la fois** (décision client, **aucune exception** :
proprio et gérant compris — un seul tiroir, un seul comptage).
- `services/routes.ts` : helper `servicesOuverts()` ; `/api/services/ouvrir`
  refuse **409** s'il existe un shift ouvert par quelqu'un d'autre (« *X a
  encore un shift en cours — il doit d'abord le clôturer* »).
- Nouvelle route **`GET /api/services/occupation`** (`exigerAuth`) → type
  partagé `OccupationCaisse` : qui tient la caisse et depuis quand, **sans
  aucun montant** (comptage à l'aveugle intact).
- `OuvertureService.tsx` : écran « Un autre shift est en cours » à la place du
  clavier, **refetch toutes les 15 s** → se libère tout seul dès le « J'ai
  fini » de la collègue. La relève reste « J'ai fini » → « Transférer au
  caissier suivant ».
- Tests : `equipe-service.test.ts` mis à jour (le refus 409 + `occupation` sont
  désormais testés, l'ouverture du 2ᵉ caissier passe après clôture du 1ᵉʳ).
  **Suite complète verte : 32 fichiers, 191 tests.**

## Session précédente (2026-08-04)

Tout est codé, testé (lots ciblés verts) et buildé. **Action en attente côté
utilisateur : relancer `PosSamer.exe`** (`Ctrl+Alt+Q` puis rouvrir) pour charger
tout ce qui a été fait — le nouvel exe embarque la purge de cache PWA, le pont
IPC + bouton « Fermer l'application », et au lancement le serveur (tsx) recharge
le code à jour (tables OCCUPEE, endpoint livraison, écart − dépenses).

État vérifié ce soir :
- `PosSamer.exe` racine = repackagé 23:31 (purge cache PWA + bouton fermer).
- Caisse `dist` = à jour (bouton, couleur OCCUPEE, livraisons).
- Imprimante cuisine repointée sur **KITCHEN** en base (Cuisine .15 était hors ligne).
- **PostgreSQL portable retombé plusieurs fois** ce soir → redémarré ; à
  resurveiller demain (`pg_ctl -D data/pgdata -l data/pg.log -w start`).

Questions ouvertes posées à l'utilisateur (sans réponse) :
1. La couleur « Occupée » (gris ardoise `#64748b`) est-elle assez distincte du
   libre ? Sinon passer à une teinte plus marquée (1 ligne + repackage/rebuild).
2. Ticket de clôture : séparer « écart réel » vs « dont dépenses », ou l'écart
   net corrigé suffit ?

Rappels build : modif **caisse** → `pnpm --filter caisse build` ; modif **shell
desktop** → `pnpm --filter @pos/desktop build` + copier l'exe à la racine ; modif
**serveur seule** → relancer l'app (pas de build). Tests : `ADMIN_DATABASE_URL=
postgres://postgres@localhost:5432/postgres`, PG démarré, rôle `PC` présent.

## Session 2026-08-03 (suite 3) — Écart de caisse : déduire les dépenses

Bug métier : les **dépenses payées en espèces** depuis le tiroir apparaissaient
comme un **manquant**. Le théorique espèces était `fond + espèces encaissées`
**sans** retirer les dépenses, alors que l'argent du tiroir est fongible (la
dépense sort du tiroir, qu'elle vienne du fond ou de la recette).

- **Correctif** (`modules/services/routes.ts`, clôture) :
  `especes_theorique = fond + auto.modes.ESPECES − corps.depenses`
  (`écart = comptées − théorique`). Le comptage aveugle reste préservé (théorique
  jamais exposé avant saisie). L'`écart de réconciliation` (`diff`) était déjà
  correct (il réintègre les dépenses dans `vente_totale`).
- **Tests** : nouveau `test/depenses-ecart.test.ts` (dépense espèces → écart 0 ;
  vrai manquant toujours détecté). `sequence.test.ts` mis à jour (dépense 1000,
  compté 31000 → écart +1000 = excédent, illustre la correction). Lot ciblé =
  16 tests verts. **Serveur seul** → pas de rebuild caisse ; relancer l'app pour
  charger le nouveau code (tsx sans watch).

## Session 2026-08-03 (suite 2) — Bouton « Fermer l'application » redessiné

L'ancien bouton ✕ flottant (fenêtre Electron séparée, always-on-top, visible
partout) est **supprimé**. Remplacé par un vrai bouton intégré « Fermer
l'application » dans la caisse, **uniquement sur l'écran de choix du profil**
(login) et **uniquement dans la coquille kiosque**, avec confirmation en 2 temps.

- **Desktop** (`apps/desktop/main.js`) : `creerBoutonFermer()` + la fenêtre
  `boutonFermer` + `bouton-fermer.html` supprimés. La fenêtre principale expose
  désormais le pont IPC via `webPreferences.preload = preload-bouton.js`
  (`window.posSamer.fermer()` → `ipcMain.on('fermer-app')`, conservé). Raccourci
  maintenance `Ctrl+Alt+Q` conservé. `bouton-fermer.html` retiré de la liste
  `files` du build et supprimé.
- **Caisse** (`screens/Login.tsx`) : helper `fermetureBureau()` (lit
  `window.posSamer.fermer`, null hors kiosque → bouton masqué en dev/navigateur).
  Bouton dans le footer du panneau profil, affiché seulement si `fermerApp &&
  !choisi` (masqué pendant la saisie du PIN). Confirmation inline « Oui, fermer /
  Annuler ».
- **Déploiement** : changer le shell desktop **impose un repackaging** de
  `PosSamer.exe` (`asar:true`, main.js/preload empaquetés). Fait :
  `pnpm --filter @pos/desktop build` (electron-builder --win portable ;
  `CSC_IDENTITY_AUTO_DISCOVERY=false`, Mode dev Windows requis = déjà activé),
  puis copie de `apps/desktop/release/PosSamer.exe` → racine du dossier portable.
  Caisse reconstruite aussi. Typecheck caisse OK.

## Session 2026-08-03 (suite) — Correctifs terrain (imprimante cuisine + tables)

Déploiement en prod : la caisse tourne via `PosSamer.exe` (serveur tsx depuis les
sources + caisse servie en **statique** depuis `apps/caisse/dist`). Le `dist`
datait du 18/07 → aucune fonction récente visible. **Reconstruit** la caisse
(`pnpm --filter caisse build`) : imprimante/routage/livraisons de nouveau là.

- **Bon cuisine bloqué dans la file** : le poste CUISINE était configuré sur
  l'imprimante Windows « Cuisine » (192.168.1.15) en état **Error** (hors ligne) →
  jobs RAW acceptés par le spooler mais jamais sortis. Le spooler ne remonte pas
  d'erreur (WritePrinter/EndDocPrinter réussissent) donc `envoyer()` ne bascule pas
  sur la console. **Correctif config** (pas de code) : `imprimante_poste_cuisine`
  repointé sur **« KITCHEN »** (192.168.1.86, en ligne) via `UPDATE
  parametres_locaux`. `queuePoste()` relit à chaque impression → effet immédiat,
  sans redémarrage. (Imprimantes prod : caisse = WOOSIM WSP-CP383 USB.)
- **Tables ouvertes affichées « Libre »** : `deriverEtat` (`modules/tables/etat.ts`)
  n'avait aucune branche pour une commande **OUVERTE** prise en caisse/serveur (seul
  le cas CLIENT_QR OUVERTE était géré) → elle retombait sur le `else` = LIBRE, alors
  que la table est physiquement OCCUPEE et la commande visible dans Mes ventes.
  **Correctif** : nouvel état dérivé **`OCCUPEE`** (« Occupée », gris `#64748b` dans
  `PlanSalle`) rendu quand il reste une commande active non couverte par les autres
  états. `ETATS_TABLE`/`LIBELLES_ETAT_TABLE` étendus (état DÉRIVÉ, pas de migration).
  Test `test/table-occupee.test.ts` (LIBRE→OCCUPEE→EN_PREPARATION→LIBRE). NB : le
  `statut` physique `tables_salle.statut` reste distinct (sprint2 le teste, inchangé).
- **À faire par l'utilisateur** : relancer `PosSamer.exe` (Ctrl+Alt+Q puis
  redémarrer) pour que le serveur recharge le code (deriverEtat, endpoint livraison)
  et serve le nouveau `dist`. Typecheck serveur/caisse/tablette OK ; tests ciblés
  verts (table-occupee + corrections3-point4 + sprint2 = 23).

## Session 2026-08-03 — Livraisons externes sans encaissement en caisse

Une livraison **Yango/Glovo** est réglée chez le partenaire : la caisse ne doit
plus demander de mode de paiement.

- **Discriminant** (`packages/shared/src/constantes.ts`) : `PARTENAIRES_EXTERNES`
  = `['YANGO', 'GLOVO']` + helper `estLivraisonSansEncaissement(partenaire)`.
  **Samer Deliv est EXCLU** (livraison propre → encaisse normalement au comptoir,
  décision client).
- **Endpoint** `POST /api/commandes/:id/cloturer-livraison`
  (`modules/paiements/routes.ts`, permission `caisse.encaisser`) : passe une
  commande Yango/Glovo à **PAYEE sans aucune ligne de paiement** (rattachement au
  service du caissier, fidélité créditée, reçu imprimé). Refuse (400) tout ce qui
  n'est pas une livraison externe (Samer Deliv, sur place, à emporter).
- **Réconciliation** (`modules/services/rapport.ts`, `reconciliationAuto`) revue :
  `modes` = paiements HORS partenaires externes (⇒ **Samer Deliv compte dans le
  théorique espèces** comme une vente normale) ; `livraisons` = totaux **Yango/
  Glovo uniquement**. Plus de double comptage. Avant, TOUS les partenaires étaient
  hors caisse — c'était le bug pour Samer Deliv.
- **Caisse** (`Paiement.tsx`) : pour une livraison externe, modes+clavier remplacés
  par un unique bouton « Valider la livraison ». Fidélité/split masqués. Bouton
  « Terminer » corrigé (ne se bloque plus sur `reste > 0` quand c'est PAYEE, car
  une livraison clôturée garde `reste = total`). `Commande.tsx` : bouton relabellé
  « Valider la livraison ».
- **Reçu** : ligne « Réglé par <partenaire> » quand pas de paiement (escpos +
  ConsolePrinter).
- **Validé** : typecheck serveur + caisse OK ; **suite complète 180 tests verts**
  (nouveau `test/livraison-externe.test.ts`, 4 tests). NB : le PG portable peut
  tomber si on enchaîne les 29 fichiers sur une instance déjà chargée — relancer
  `pg_ctl start` puis relancer donne 180/180.

## Session 2026-07-19 (suite 3) — Routage par défaut par catégorie (choix client)

Mapping validé par le client, gravé comme défaut **général** (modifiable via
Réglages › Routage impression) :
- **Caisse** : Chawarmas, Jus Naturels, Boissons, Crêpes, Desserts.
- **Cuisine** : Salades, Sandwiches, Tacos, Assiettes, Poulet & Poisson,
  Accompagnements, Manaiches, Pizzas, Apéritifs. **Bar** : aucune (pour l'instant).

- Constante partagée `ROUTAGE_CATEGORIE_DEFAUT` (par nom normalisé) +
  `posteDefautCategorie()` dans `packages/shared/src/constantes.ts`.
- Helper serveur idempotent `appliquerRoutageDefaut()`
  (`modules/reglages/routage-defaut.ts`) : n'insère que pour les catégories SANS
  routage — ne réécrase jamais un choix fait à la main.
- Appliqué : au **seed** (`db/seed.ts`) et à l'**import catalogue local**
  (`scripts/importer-catalogue.ts`). PAS au boot (pour respecter un « hérité »
  choisi volontairement). NB : la descente catalogue cloud (moteur sync) ne
  l'applique pas encore — à ajouter si besoin pour les 7 restos alimentés cloud.
- Appliqué à la base dev actuelle + validé sur base jetable (seed → 14 catégories
  routées, 5 Caisse / 9 Cuisine). `git` n'est pas installé sur ce poste : « commit »
  = gravé dans le code (seed/shared), pas un commit git réel.

## Session 2026-07-19 (suite 2) — QR de connexion des appareils

Menu « Appareils » côté caisse : le serveur (tablette) et le cuisinier (KDS)
scannent un QR pour ouvrir leur plateforme, sur le MÊME WiFi que la caisse, sans
internet (tout est servi en LAN par le mini-PC).

- Ports LAN dans `lib/reseau.ts` : `PORT_KDS=5174`, `PORT_SERVEUR=5175`
  (alignés sur les `server.port` des vite.config ; caisse 5173, client 5176).
- Endpoint `GET /api/appareils/connexion` (`modules/salle/admin.ts`, guard léger
  `exigerAuth`) : IP LAN détectée (`adresseReseauLocale`) + un QR PNG data-URL par
  plateforme (`http://<ip>:5174|5175`, via `qrDataUrl`).
- UI : bouton « Appareils » (icône QR) dans le header de l'Accueil caissier →
  modale avec les 2 QR + URLs. Pas de 5e tuile (règle des 4 boutons respectée).
- Validé end-to-end : login proprio → réponse OK (IP 192.168.1.159, QR Cuisine
  :5174 et Serveur :5175). Le QR n'ouvre que l'app ; l'employé fait ensuite son PIN.

## Session 2026-07-19 (suite) — Routage d'impression par produit + code TC

Chaque produit sort désormais sur l'imprimante de SON poste ; la cuisine reçoit
un bon papier en plus de l'affichage KDS. Migration **0018** (attention : les
migrations vont jusqu'à 0018, le doc listait 0011 par erreur).

- **Modèle** (migration 0018, delta écrit à la main car aucun snapshot drizzle
  pour 0000-0017) : enum `poste_impression` (CAISSE/CUISINE/BAR), colonne
  `commandes.code_commande`, tables locales `routage_categorie` /
  `routage_article` (jamais écrasées par une descente cloud, comme
  `disponibilite_locale`), index unique `(service_id, code_commande)`.
- **Code court** `SP215` : préfixe selon le type (SP/EM/LV) + 3 chiffres
  aléatoires, unique dans le service. Généré aux 3 points de création (caisse,
  tablette serveur, QR client). Le `numero_ticket` reste la séquence d'audit.
- **Impression par poste** (`printer/escpos.ts`) : `queuePoste(poste)` lit
  `imprimante_poste_<poste>` (Caisse retombe sur l'ancienne clé
  `imprimante_thermique_queue`). Reçu/facture/rapport Z → Caisse.
- **Bon de préparation** (`printer/bons.ts`) : à l'envoi en cuisine, les articles
  nouvellement envoyés sont groupés par poste (résolution article > catégorie >
  défaut CUISINE) et un bon imprime sur chaque imprimante concernée. Câblé aux
  3 vrais points d'envoi (caisse `/envoyer`, tablette serveur, validation client
  en salle). Impression APRÈS commit (jamais dans la transaction).
- **Réglages** : section « Imprimantes » = 3 postes (Caisse/Cuisine/Bar) chacun
  avec sélection + test ; nouvelle section « Routage impression » (catégories +
  exceptions par article). Routes `/api/admin/imprimantes`,
  `/api/admin/imprimante/poste`, `/api/admin/imprimante/test`, `/api/admin/routage`,
  `/api/admin/routage/categorie|article`. Permission `reglages.parametres`.
- **Affichage du code** : reçu/facture (gros), KDS (remplace le N°), écrans caisse
  (Commande, Paiement, Mes ventes).
- **Validé** : migration appliquée (base jetable + base dev), typecheck des 6 apps,
  **176 tests verts**, bon CUISINE imprimé physiquement sur la RONGTA 80mm.
- Env test : ce PG portable n'a que le rôle `postgres` ; la config de test code en
  dur une URL sans utilisateur → un rôle superutilisateur `PC` a été créé
  localement pour que Vitest tourne (n'affecte pas l'app, qui utilise `postgres@`).

## Session 2026-07-19 — Coquille desktop + config imprimante

- **Bouton fermer kiosque (Windows+D)** : `apps/desktop/main.js` — le bouton « ✕ »
  flottant (niveau `screen-saver`) restait affiché seul quand Windows+D masquait
  la caisse. Corrigé : `boutonFermer` est une variable de module et la fenêtre
  caisse pilote sa visibilité (`minimize`/`hide` → `hide()`, `restore`/`show`/
  `focus` → `show()`).
- **Menu de configuration imprimante** (auto-suffisant, aucun code à toucher par
  poste). Section **« Imprimante »** dans Réglages (`apps/caisse/.../Reglages.tsx`,
  permission `reglages.parametres`) : liste les imprimantes du poste, sélection,
  **Imprimer un test**, **Enregistrer**, **Désactiver**.
  - Serveur : `printer/escpos.ts` — **impression RAW par NOM d'imprimante** via
    le spooler Windows (P/Invoke `winspool` dans un script PowerShell temporaire),
    donc **plus besoin de partager l'imprimante**. Chemin UNC `\\host\partage`
    conservé en secours ; `copy /b` uniquement pour l'UNC.
  - Nouveaux exports : `listerImprimantes()`, `imprimerTest()`, `envoyerRaw()`.
  - Routes : `GET /api/admin/imprimantes` (découverte + valeur configurée) et
    `POST /api/admin/imprimante/test` (permission `reglages.parametres`).
  - **Testé physiquement** sur RONGTA 80mm (192.168.1.86) : ticket sorti, OK.
  - Le paramètre reste `imprimante_thermique_queue` (déjà dans la liste blanche) :
    on y stocke désormais le **nom** de l'imprimante (ex. « RONGTA 80mm Series
    Printer »), plus un nom de partage.
- Typecheck : serveur + caisse compilent (`tsc --noEmit`).

## Où on en est

Le **cœur caisse** (sprints 1→4) est en place + **hiérarchie des rôles** finalisée
(proprio/superviseur ≠ caissiers). Les derniers chantiers livrés :

- **Aiguillage par rôle** : proprio/superviseur → tableau de bord Supervision
  (rapports, réglages, basculer caisse optionnel) ; caissier/manager → accueil
  caissier ; serveur → accueil réduit (prise de commande + tables seulement).
  La cuisine ne se connecte jamais à la caisse (garde-fou serveur).
- **Corrections régressions** : proprio non forcé en ouverture service ; retour
  supervision possible ; flux de définition du PIN complété (code temporaire).
- **Salle & QR** : réactivation de tables + vraie modale QR (affichage/impression).
- **Dev-UX** : numpad supporte clavier (0-9, Backspace, Escape, Enter).

État technique : **155 tests verts**, tous les apps compilent (`pnpm -r build`).
Développement directement sur `main` (convention du dépôt), un commit par étape.

## Session 2026-07-10 — Hiérarchie des rôles + UX

**6 commits, 4 tests ajoutés** :

1. **Blocage cuisine** — La cuisine ne se connecte jamais à la caisse
   (refus login + exclusion liste, côté serveur).
2. **Aiguillage par rôle** — Proprio/superviseur → Supervision (rapports, réglages,
   bascule caisse optionnelle) ; serveur → accueil réduit (seulement commandes/tables).
3. **Corrections régressions** — Proprio non forcé en ouverture service en consultant
   les rapports ; retour supervision disponible ; flux PIN définition au login complet.
4. **Salle & QR** — Bouton réactivation table ; vraie modale QR (image, adresse,
   imprimer, régénérer).
5. **Init url_base_client** — QR générait URL vide, maintenant defaults à
   `http://localhost:5173` en dev.
6. **Numpad clavier** — Support 0-9, Backspace, Escape, Enter/Espace en dev.

## Modules livrés récemment

### Permissions & rôles (Partie 1)
- Catalogue figé `packages/shared/src/permissions.ts` (sections + libellés FR).
- Tables `roles` / `role_permissions`, `utilisateurs.role_id` (migration 0006).
  6 rôles système ; accès existants préservés exactement.
- Guards serveur par **permission** (`app.exigePermission('caisse.remise')`),
  cache invalidé en temps réel (WebSocket `permissions`).
- Invariants 1.5 : PROPRIETAIRE toujours toutes permissions (anti-verrouillage) ;
  PIN manager = rôle avec permission de supervision (`rapports.z`) ;
  rôles PROPRIETAIRE/SUPERVISEUR verrouillés ; `roles.gerer` protégée.

### Module Réglages (Partie 2) — routes `/api/admin/*`, onglet PWA `Reglages.tsx`
- **Rôles & accès**, **Équipe** (PIN posé par l'employé via code temporaire,
  migration 0007), **Salle & QR** (migration 0008, PDF via `qrcode`+`pdfkit`),
  **Plats du jour** (`disponibilite_locale`, migration 0009, non écrasée par la
  descente), **Paramètres**, **Journal d'audit**, **Catalogue & Fidélité** via
  Edge Function cloud `admin-catalogue` (hors ligne → message clair).

### Allègement — équipe du jour (remplace le pointage)
- Table `equipe_service` (migration 0010) : à l'ouverture de service, on coche
  les présents + poste du jour (`POSTES_JOUR`), modifiable (ex. Willy barman →
  comptoiriste). Info + remontée outbox, **pas de chronométrage**.
- **Pointage retiré** (migration 0011) : module, tables `pointages`/
  `codes_pointage`, permission `reglages.pointage`, params géoloc + SMS, page
  pointage client, mode pointage de la connexion.
- **KDS** : présence « en poste » = équipe du jour d'un service ouvert ; à défaut,
  tous les cuisiniers actifs (ne bloque jamais). Regroupement sur `poste_cuisine`
  (le poste du jour est une info, il ne pilote pas le KDS — décision utilisateur).

## Décisions clés (récentes)
- Poste du jour = **info + remontée**, KDS inchangé.
- Sélection de l'équipe **à l'ouverture de service** (2 étapes : fond → équipe).
- Allègement retenu pour cette passe : **SMS retirés** (avec le pointage).

## Migrations Drizzle
`0006` rôles/permissions · `0007` PIN temporaire · `0008` `tables_salle.actif` ·
`0009` `disponibilite_locale` · `0010` `equipe_service` · `0011` retrait pointage ·
`0020` options réutilisables · `0021` dépenses, inventaire, pointage (DESIGN_V2) ·
`0022` recettes d'inventaire (`inventaire_consommations`, et retrait de
`produits_inventaire.article_id`).
Deltas **écrits à la main** : drizzle-kit n'a pas de snapshot des migrations
0000-0022, `generate` redéposerait tout le schéma. Après ajout, compléter
`drizzle/meta/_journal.json` **en UTF-8 sans BOM** (un BOM casse toute migration).

## Commandes utiles
```bash
pnpm -r build                              # build strict TS + tous les apps
pnpm --filter @pos/server test             # tests serveur (DB pos_samer_test)
pnpm --filter @pos/server exec vitest run test/<fichier>.test.ts
pnpm install && pnpm db:migrate && pnpm db:seed && pnpm dev   # démarrage complet
```

## Pistes d'allègement en attente (non décidées)
1. Supprimer l'app **serveur tablette** (`apps/serveur`) si les serveurs passent
   par la caisse.
2. Réduire l'**app client QR** (`apps/client`) à un menu consultatif.
3. **Fidélité** masquée tant qu'aucun barème n'est configuré.
4. Garder seulement les 6 rôles système (éditeur de rôles perso plus tard).

## À vérifier au déploiement (non testable ici)
- Round-trip cloud de l'édition catalogue/barème (`admin-catalogue` → descente
  `< 5 min`) : pas de Supabase joignable dans l'environnement de dev.
