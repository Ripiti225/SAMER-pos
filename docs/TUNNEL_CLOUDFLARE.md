# Rendre le menu client (QR) joignable en 4G — Cloudflare Tunnel

But : un client qui **refuse le WiFi public** peut scanner le QR de sa table et
commander **via sa 4G**, sur une adresse **fixe et en HTTPS** (ex.
`https://table.mon-resto.ci`). Pas de page d'avertissement, gratuit.

Ce qui est publié : **uniquement l'app client** (menu). La caisse, l'admin et
l'authentification (port 3001) restent **privées** — le tunnel ne voit que le
port `4176` (build de l'app client) qui ne relaie que `/api/client`.

Pré-requis : un **compte Cloudflare** (gratuit) et un **nom de domaine ajouté à
Cloudflare** (le domaine apparaît dans le tableau de bord Cloudflare, statut
« Active »). `cloudflared` est déjà installé.

---

## 1. Configuration (une seule fois)

Choisis le sous-domaine du menu, par ex. `table.mon-resto.ci`.

```bash
# a) Autoriser cloudflared sur ton compte (ouvre le navigateur : choisis ton domaine)
cloudflared tunnel login

# b) Créer le tunnel (note l'IDENTIFIANT affiché : c'est <TUNNEL_ID>)
cloudflared tunnel create pos-samer

# c) Créer l'entrée DNS : ton sous-domaine → le tunnel
cloudflared tunnel route dns pos-samer table.mon-resto.ci

# d) Installer le fichier de config
cp infra/cloudflared/config.example.yml ~/.cloudflared/config.yml
#   puis édite ~/.cloudflared/config.yml :
#     - remplace <TUNNEL_ID> (2 endroits : tunnel + credentials-file)
#     - remplace table.MON-DOMAINE par table.mon-resto.ci
```

Puis, **dans le POS** : Réglages → Paramètres → « Adresse web des QR clients » =
`https://table.mon-resto.ci`. Enfin Réglages → Salle & QR → **Régénérer tous les
QR** et **Imprimer les QR** (ils encodent maintenant l'adresse publique).

---

## 2. Utilisation (à chaque service)

Le serveur API doit tourner (`pnpm dev`). Dans un autre terminal :

```bash
bash scripts/tunnel-client.sh
```

Le script compile l'app client, la sert sur `:4176`, et ouvre le tunnel. Tant
qu'il tourne, `https://table.mon-resto.ci` est joignable depuis n'importe quel
téléphone en 4G. `Ctrl-C` arrête.

### Démarrage automatique (optionnel, mini-PC en production)

Pour que le tunnel se lance tout seul au démarrage de la machine :

```bash
sudo cloudflared service install
```

(Il faut alors aussi lancer le `vite preview` du client au boot — ou, en
production, servir le build derrière le tunnel par un vrai serveur statique.)

---

## Notes

- **Dépendance internet** : ces QR passent par Cloudflare. Si internet tombe au
  restaurant, ils ne répondent plus (le reste du POS, lui, continue en local).
  Les QR sur le réseau WiFi local (adresse `http://<IP-LAN>:5176`) restent une
  alternative hors-ligne — mais un QR imprimé n'encode qu'**une** adresse : on
  choisit soit le tunnel (4G), soit le WiFi local.
- **Sécurité** : le tunnel n'expose que `:4176`, qui ne proxifie que
  `/api/client`. Les routes `/api/auth`, `/api/admin`, `/ws` sont injoignables
  depuis internet (vérifié). Pour verrouiller davantage, on peut ajouter
  Cloudflare Access devant le sous-domaine.
- **Adresse stable** : tant que tu gardes le même tunnel et le même sous-domaine,
  l'adresse ne change pas — les QR imprimés restent valables.
