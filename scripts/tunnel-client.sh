#!/usr/bin/env bash
# Lance l'app client (menu QR) exposée en 4G via Cloudflare Tunnel.
#
# Pré-requis (voir docs/TUNNEL_CLOUDFLARE.md) :
#   - le serveur API tourne déjà (pnpm dev, port 3001) ;
#   - le tunnel « pos-samer » est configuré (login + create + route + config.yml).
#
# Ce script : compile le client, le sert en local sur :4176 (build, pas les
# sources), puis démarre le tunnel. Ctrl-C arrête proprement les deux.
set -euo pipefail
cd "$(dirname "$0")/.."

NOM_TUNNEL="${1:-pos-samer}"

echo "→ Compilation de l'app client…"
pnpm -F @pos/client build

echo "→ Service local du build sur http://localhost:4176 …"
pnpm -F @pos/client preview >/tmp/pos-client-preview.log 2>&1 &
PREVIEW_PID=$!
trap 'kill "$PREVIEW_PID" 2>/dev/null || true' EXIT
sleep 2

echo "→ Démarrage du tunnel Cloudflare « $NOM_TUNNEL » …"
echo "  (l'app client est maintenant joignable sur ton domaine ; Ctrl-C pour arrêter)"
cloudflared tunnel run "$NOM_TUNNEL"
