# Guide pas à pas — Migrer chezsamer.com vers Cloudflare

But final : afficher le menu des tables sur `https://table.chezsamer.com`,
accessible en **4G** (sans WiFi public). Étape indispensable avant le tunnel :
faire gérer les DNS de `chezsamer.com` par **Cloudflare** (gratuit).

**Ce qui change / ne change pas :**
- ✅ Ton **site** et ton **email** continuent de fonctionner à l'identique
  (ils restent hébergés chez LWS, IP `91.234.194.101`).
- 🔁 Seule la **gestion des noms (DNS)** passe de LWS à Cloudflare.
- ⏱️ Aucune coupure **si** on recopie bien tous les enregistrements dans
  Cloudflare **avant** de changer les nameservers chez GoDaddy.

Rôles :
- **GoDaddy** = registrar (là où le domaine est enregistré → on y change les
  nameservers).
- **LWS** = hébergeur actuel (site + email + DNS jusqu'ici).
- **Cloudflare** = nouveau gestionnaire DNS + tunnel.

---

## PARTIE 1 — Créer le compte Cloudflare et ajouter le domaine

1. Va sur **https://dash.cloudflare.com/sign-up**.
2. Crée un compte : email + mot de passe → valide l'email de confirmation.
3. Une fois connecté, clique **« Add a site »** (ou « Ajouter un site »).
4. Saisis `chezsamer.com` (sans `www`, sans `https`) → **Continue**.
5. Choix du plan : sélectionne **Free** (0 $) → **Continue**.
6. Cloudflare **scanne automatiquement** tes DNS actuels (~1 min) et affiche la
   liste des enregistrements trouvés. → passe à la PARTIE 2 **sans encore
   cliquer sur Continue**.

---

## PARTIE 2 — Vérifier les enregistrements DNS (l'étape à ne PAS rater)

Compare la liste affichée par Cloudflare avec le tableau ci-dessous (relevé de
ta config réelle le 2026-07-12). **Il ne doit rien manquer**, surtout les lignes
email.

| Type | Nom            | Valeur / contenu                                                                 | Proxy        |
|------|----------------|----------------------------------------------------------------------------------|--------------|
| A    | `@` (racine)   | `91.234.194.101`                                                                 | DNS only 🌫️ |
| A    | `www`          | `91.234.194.101`                                                                 | DNS only 🌫️ |
| A    | `mail`         | `91.234.194.101`                                                                 | DNS only 🌫️ |
| A    | `webmail`      | `91.234.194.101`                                                                 | DNS only 🌫️ |
| A    | `cpanel`       | `91.234.194.101`                                                                 | DNS only 🌫️ |
| A    | `ftp`          | `91.234.194.101`                                                                 | DNS only 🌫️ |
| A    | `autodiscover` | `91.234.194.101`                                                                 | DNS only 🌫️ |
| A    | `autoconfig`   | `91.234.194.101`                                                                 | DNS only 🌫️ |
| MX   | `@`            | `mail.chezsamer.com` — priorité `0`                                              | —            |
| TXT  | `@` (SPF)      | `v=spf1 +a +mx +ip4:91.234.194.101 include:premiumsmtp.dnshostservices.com ~all` | —            |
| TXT  | `_dmarc`       | `v=DMARC1; p=none;`                                                              | —            |

**Deux règles simples :**

- **A) Tout en « DNS only » (nuage GRIS).** Sur chaque ligne A, si le nuage est
  **orange** (proxied), clique dessus pour le passer **gris** (DNS only). C'est
  obligatoire pour `mail`, `webmail`, `cpanel`, `ftp`, `autodiscover`,
  `autoconfig` (sinon email/webmail cassent). Pour la racine et `www`, on met
  aussi **gris** pour l'instant (comportement identique à aujourd'hui).

- **B) Ajouter ce qui manque.** Si une ligne du tableau n'est pas dans la liste
  Cloudflare, clique **« Add record »**, choisis le Type, saisis le Nom et la
  Valeur exactement comme ci-dessus.

**Bonus DKIM (recommandé) :** ouvre le cPanel LWS → **Email Deliverability** (ou
« Authentification email ») pour `chezsamer.com`. S'il affiche un enregistrement
**DKIM** (Type TXT, nom du genre `default._domainkey`, valeur `v=DKIM1;...`),
recopie-le aussi dans Cloudflare (Add record → TXT). Sans lui, les mails partent
quand même mais sont un peu moins bien notés.

Quand la liste est complète et **tout en gris** → clique **Continue**.

---

## PARTIE 3 — Changer les nameservers chez GoDaddy

Cloudflare affiche maintenant **2 nameservers** à toi, par exemple :
```
xxxx.ns.cloudflare.com
yyyy.ns.cloudflare.com
```
(garde cette page ouverte, tu vas recopier ces 2 valeurs)

1. Dans un autre onglet, connecte-toi sur **https://godaddy.com**.
2. En haut à droite : **ton nom → My Products** (Mes produits).
3. Section **Domains** → clique sur **`chezsamer.com`**.
4. Trouve la section **Nameservers** (Serveurs de noms) → clique **Change**
   (Modifier).
5. Choisis **« I'll use my own nameservers »** / **« Enter my own nameservers
   (advanced) »**.
6. **Efface** les serveurs actuels (`NS1..NS4.DNSHOSTSERVICES.COM`) et **saisis
   les 2 nameservers Cloudflare** (ceux de la page Cloudflare).
7. **Save** (Enregistrer). GoDaddy peut demander une confirmation → confirme.

Puis reviens sur la page Cloudflare et clique **« Done, check nameservers »**
(« J'ai terminé, vérifier »).

---

## PARTIE 4 — Attendre l'activation, puis vérifier

- Propagation : souvent **moins d'1 h**, parfois jusqu'à **48 h**. Cloudflare
  t'envoie un email **« chezsamer.com is now active »** quand c'est bon.
- **Vérifie que rien n'est cassé :**
  - Envoie-toi un mail sur `…@chezsamer.com` et vérifie que tu le reçois.
  - Ouvre le **webmail** habituel.
  - Ouvre le **site** si tu en as un.

Vérifs en ligne de commande (optionnel, dans le Terminal) :
```bash
dig +short NS chezsamer.com        # doit afficher les 2 nameservers Cloudflare
dig +short MX chezsamer.com        # doit toujours afficher mail.chezsamer.com
dig +short A mail.chezsamer.com    # doit toujours donner 91.234.194.101
```

⚠️ **Ne passe à la PARTIE 5 qu'une fois l'email confirmé OK.**

---

## PARTIE 5 — Monter le tunnel (adresse table.chezsamer.com)

Le domaine est actif sur Cloudflare → `cloudflared` te proposera enfin
`chezsamer.com`. La suite détaillée est dans **docs/TUNNEL_CLOUDFLARE.md** :
`login` → `create` → `route dns table.chezsamer.com` → `config.yml` →
`scripts/tunnel-client.sh`, puis régler « Adresse web des QR clients » sur
`https://table.chezsamer.com` dans Réglages et réimprimer les QR.

---

## En cas de doute
Avant de cliquer sur les nameservers GoDaddy (PARTIE 3), **copie-colle la liste
d'enregistrements que Cloudflare te montre** et envoie-la moi : je la compare
avec ta config actuelle et je te confirme qu'il ne manque rien. Zéro risque pour
l'email.
