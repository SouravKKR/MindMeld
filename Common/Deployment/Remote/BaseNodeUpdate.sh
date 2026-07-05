#!/usr/bin/env bash
#
# Runs ON an always-on base node (as the SSH user), streamed there by
# deploy-environment.sh. Refreshes the Agent + Dock code + venv, points the fleet
# at the freshly-baked image, ensures Dock + cloudflared run as services
# (idempotently), and restarts Dock so the change takes effect.
#
# Inputs (exported by deploy-environment.sh on the ssh command line):
#   REPO_DIR                 — absolute repo path on the base node (e.g. /root/mindmeld)
#   AGENT_CONTEXT_ARCHIVE    — path to the uploaded Agent build context tarball
#   DOCK_CONTEXT_ARCHIVE     — path to the uploaded Dock build context tarball (optional)
#   NEW_IMAGE_ID             — baked image id to write as BURST_IMAGE_ID, or "" to skip
#   DOCK_ENV_FILE            — Dock env file name for this environment (default .production.env)
#   MINDMELD_ENVIRONMENT     — environment name baked into the systemd unit (default production)
#   CLOUDFLARE_TUNNEL_TOKEN  — if set, cloudflared runs token-based (remotely-managed);
#                              if empty, the legacy config.yml tunnel is used instead
set -euo pipefail

DOCK_DIRECTORY="$REPO_DIR/Dock"
AGENT_DIRECTORY="$REPO_DIR/Agent"
DOCK_ENV_FILE="${DOCK_ENV_FILE:-.production.env}"
MINDMELD_ENVIRONMENT="${MINDMELD_ENVIRONMENT:-production}"
DOCK_ENVIRONMENT_FILE="$DOCK_DIRECTORY/$DOCK_ENV_FILE"
CLOUDFLARE_CONFIG_SOURCE="$REPO_DIR/Common/Config/CloudflareTunnelConfig.production.yml"

[ -d "$REPO_DIR" ] || { echo "ERROR: REPO_DIR '$REPO_DIR' does not exist on the base node"; exit 1; }
[ -f "$AGENT_CONTEXT_ARCHIVE" ] || { echo "ERROR: agent context '$AGENT_CONTEXT_ARCHIVE' not found"; exit 1; }

echo "==> [$MINDMELD_ENVIRONMENT] Refreshing Agent code from the uploaded context..."
tar -xzf "$AGENT_CONTEXT_ARCHIVE" -C "$REPO_DIR"
rm -f "$AGENT_CONTEXT_ARCHIVE"

if [ -n "${DOCK_CONTEXT_ARCHIVE:-}" ] && [ -f "$DOCK_CONTEXT_ARCHIVE" ]
then
    echo "==> Refreshing Dock code (brute-force, including node_modules)..."
    # The tar excludes every .env file, so the live Dock/.<env>.env secrets are never clobbered.
    tar -xzf "$DOCK_CONTEXT_ARCHIVE" -C "$REPO_DIR"
    rm -f "$DOCK_CONTEXT_ARCHIVE"
fi

echo "==> Ensuring the Agent venv + dependencies..."
cd "$AGENT_DIRECTORY"
if ! command -v uv >/dev/null 2>&1
then
    curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"
if [ ! -x ".venv/bin/python" ]
then
    echo "    No venv found — creating one via uv (Python 3.12)."
    uv venv --python 3.12 .venv
fi
uv pip install --python .venv/bin/python --index-strategy unsafe-best-match -r requirements.txt

if [ -n "${NEW_IMAGE_ID:-}" ]
then
    echo "==> Pointing the fleet at the new image (BURST_IMAGE_ID=$NEW_IMAGE_ID) in $DOCK_ENV_FILE..."
    [ -f "$DOCK_ENVIRONMENT_FILE" ] || { echo "ERROR: $DOCK_ENVIRONMENT_FILE not found"; exit 1; }
    if grep -q '^BURST_IMAGE_ID=' "$DOCK_ENVIRONMENT_FILE"
    then
        sed -i "s#^BURST_IMAGE_ID=.*#BURST_IMAGE_ID=${NEW_IMAGE_ID}#" "$DOCK_ENVIRONMENT_FILE"
    else
        printf '\nBURST_IMAGE_ID=%s\n' "$NEW_IMAGE_ID" >> "$DOCK_ENVIRONMENT_FILE"
    fi
fi

echo "==> Ensuring the Dock systemd service (env=$MINDMELD_ENVIRONMENT)..."
# Locate node (may come from nvm rather than /usr/bin).
NODE_BINARY="$(command -v node || true)"
if [ -z "$NODE_BINARY" ]
then
    NODE_BINARY="$(ls -1 "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
fi
[ -n "$NODE_BINARY" ] || { echo "ERROR: could not locate the node binary"; exit 1; }
NODE_DIRECTORY="$(dirname "$NODE_BINARY")"

# The MINDMELD_ENVIRONMENT variable makes both Dock AND the Agent subprocesses it
# spawns load Dock/.<env>.env and Agent/.<env>.env (see the env resolver in
# Dock/index.js and Agent/Globals/Utility/EnvironmentLoader.py). The absolute
# ExecStart path means systemd needs no nvm on PATH.
cat >/etc/systemd/system/mindmeld-dock.service <<EOF
[Unit]
Description=MindMeld Dock ($MINDMELD_ENVIRONMENT)
After=network-online.target redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$DOCK_DIRECTORY
Environment=PATH=$NODE_DIRECTORY:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=MINDMELD_ENVIRONMENT=$MINDMELD_ENVIRONMENT
ExecStart=$NODE_BINARY index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable mindmeld-dock.service

echo "==> Migrating off any legacy 'mindmeld' screen session..."
screen -S mindmeld -X quit 2>/dev/null || true

echo "==> Ensuring the Cloudflare Tunnel runs as a service (idempotent)..."
if ! command -v cloudflared >/dev/null 2>&1
then
    echo "    Installing cloudflared..."
    curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
    dpkg -i /tmp/cloudflared.deb
    rm -f /tmp/cloudflared.deb
fi

if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]
then
    # Token-based (remotely-managed) tunnel: the hostname route is configured in the
    # Cloudflare dashboard, so the base node needs no config.yml or credentials JSON.
    # `service install <token>` is idempotent — re-running rewrites the unit.
    echo "    Using token-based (remotely-managed) tunnel."
    cloudflared service install "$CLOUDFLARE_TUNNEL_TOKEN" 2>/dev/null || true
    systemctl enable cloudflared 2>/dev/null || true
    systemctl restart cloudflared 2>/dev/null || true
elif [ -f "$CLOUDFLARE_CONFIG_SOURCE" ]
then
    echo "    Using legacy config.yml tunnel."
    mkdir -p /etc/cloudflared
    cp "$CLOUDFLARE_CONFIG_SOURCE" /etc/cloudflared/config.yml
    TUNNEL_NAME="$(awk -F': *' '/^tunnel:/ {print $2; exit}' /etc/cloudflared/config.yml)"
    TUNNEL_HOSTNAME="$(awk -F'hostname: *' '/hostname:/ {print $2; exit}' /etc/cloudflared/config.yml)"
    cloudflared tunnel route dns "$TUNNEL_NAME" "$TUNNEL_HOSTNAME" 2>/dev/null || true
    if [ ! -f /etc/systemd/system/cloudflared.service ]
    then
        cloudflared service install || true
    fi
    systemctl enable cloudflared 2>/dev/null || true
    systemctl restart cloudflared 2>/dev/null || true
else
    echo "    WARN: no CLOUDFLARE_TUNNEL_TOKEN and no $CLOUDFLARE_CONFIG_SOURCE — skipping cloudflared."
fi

echo "==> Restarting Dock..."
systemctl daemon-reload
systemctl restart mindmeld-dock.service

echo "==> Base node update complete ($MINDMELD_ENVIRONMENT)."
