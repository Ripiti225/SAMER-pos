# Migrer chezsamer.com vers Cloudflare — sans casser le site ni l'email

Objectif : gérer les DNS de `chezsamer.com` sur Cloudflare (gratuit) pour pouvoir
publier `table.chezsamer.com` via le tunnel. **Les serveurs ne bougent pas** (site
et email restent chez l'hébergeur actuel, IP `91.234.194.101`) : seule la
« gestion des noms » déménage. Zéro coupure **si** on recopie tous les
enregistrements dans Cloudflare **avant** de changer les nameservers.

## Règle d'or
Tout recréer en **« DNS only » (nuage GRIS)**, surtout tout ce qui touche à
l'email. On ne met le proxy (nuage orange) sur rien pour l'instant : le domaine
se comportera exactement comme aujourd'hui.

## Enregistrements à retrouver dans Cloudflare (relevés le 2026-07-12)

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

⚠️ **DKIM** : vérifie dans cPanel (« Email Deliverability ») s'il existe un
enregistrement DKIM (souvent `default._domainkey`, une longue clé `v=DKIM1…`).
S'il y en a un, recopie-le aussi (sinon les mails partent quand même, mais moins
bien notés). Non détecté automatiquement le 2026-07-12.

## Marche à suivre

1. Crée un compte gratuit sur **dash.cloudflare.com**.
2. **Add a site** → `chezsamer.com` → plan **Free**.
3. Cloudflare **scanne et importe** automatiquement tes DNS. **Compare** la liste
   proposée avec le tableau ci-dessus : ajoute ce qui manque, corrige, et passe
   **tout en « DNS only » (gris)**.
4. Cloudflare t'affiche **2 nameservers** (ex. `xxx.ns.cloudflare.com`). Le
   domaine est enregistré chez **GoDaddy** → c'est **là** qu'on les change
   (l'hébergement site+email reste chez LWS, il ne bouge pas) :
   - Connecte-toi sur **godaddy.com** → **My Products** → **Domains** →
     `chezsamer.com` → **Domain Settings**.
   - Section **Nameservers** → **Change** → **« I'll use my own nameservers »**
     (ou « Enter my own nameservers / Advanced »).
   - **Supprime** les 4 `NS?.DNSHOSTSERVICES.COM` et **saisis les 2 nameservers
     Cloudflare**. Enregistre.
   - Propagation : souvent < 1 h, parfois jusqu'à 48 h.
5. Attends l'activation (email de Cloudflare « chezsamer.com is now active »,
   de quelques minutes à quelques heures).
6. **Vérifie que l'email marche toujours** : envoie/reçois un mail, ouvre le
   webmail. Vérifie le site.
7. Seulement ensuite, reprends `docs/TUNNEL_CLOUDFLARE.md` (login → create →
   route dns `table.chezsamer.com` → config.yml → `scripts/tunnel-client.sh`).

## Vérifs en ligne de commande (après bascule)

```bash
dig +short NS chezsamer.com          # doit afficher les nameservers Cloudflare
dig +short MX chezsamer.com          # doit toujours afficher mail.chezsamer.com
dig +short A mail.chezsamer.com      # doit toujours donner 91.234.194.101
```
