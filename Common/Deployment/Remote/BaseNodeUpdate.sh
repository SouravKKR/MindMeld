#!/usr/bin/env bash
#
# Runs ON the always-on base node (as the SSH user), streamed there by deploy.sh.
# Implements Deployment.md steps 6–7: refresh the Agent code + venv, point the fleet
# at the freshly-baked image, ensure Dock + cloudflared run as services
# (idempotently), and restart Dock so the change takes effect.
#
# Inputs (exported by deploy.sh on the ssh command line):
#   REPO_DIR               — absolute repo path on the base node (e.g. /root/mindmeld)
#   AGENT_CONTEXT_ARCHIVE  — path to the uploaded Agent build context tarball
#   NEW_IMAGE_ID           — baked image id to write as BURST_IMAGE_ID, or "" to skip
set -euo pipefail

DOCK_DIRECTORY="$REPO_DIR/Dock"
AGENT_DIRECTORY="$REPO_DIR/Agent"
DOCK_PRODUCTION_ENV="$DOCK_DIRECTORY/.production.env"
CLOUDFLARE_CONFIG_SOURCE="$REPO_DIR/Common/Config/CloudflareTunnelConfig.production.yml"

[ -d "$REPO_DIR" ] || { echo "ERROR: REPO_DIR '$REPO_DIR' does not exist on the base node"; exit 1; }
[ -f "$AGENT_CONTEXT_ARCHIVE" ] || { echo "ERROR: agent context '$AGENT_CONTEXT_ARCHIVE' not found"; exit 1; }

echo "==> Refreshing Agent code from the uploaded context..."
# Overwrites changed/added files; the tar excludes the venv and env files so neither
# the running venv nor secrets are clobbered.
tar -xzf "$AGENT_CONTEXT_ARCHIVE" -C "$REPO_DIR"
rm -f "$AGENT_CONTEXT_ARCHIVE"

if [ -n "${DOCK_CONTEXT_ARCHIVE:-}" ] && [ -f "$DOCK_CONTEXT_ARCHIVE" ]
then
    echo "==> Refreshing Dock code (brute-force, including node_modules)..."
    # The tar excludes the env files, so the live Dock/.production.env (real secrets)
    # is never clobbered. node_modules is shipped as-is from the dev box — safe only
    # while Dock has no native (.node) modules (all current deps are pure JS).
    tar -xzf "$DOCK_CONTEXT_ARCHIVE" -C "$REPO_DIR"
    rm -f "$DOCK_CONTEXT_ARCHIVE"
fi

echo "==> Ensuring the Agent venv + dependencies..."
cd "$AGENT_DIRECTORY"
# Always drive installs through uv. `uv venv` does NOT install pip into the venv, so a
# `./.venv/bin/python -m pip install` against an already-existing venv fails with
# "No module named pip" (this is exactly what broke an earlier roll-out). uv manages the
# venv directly and needs no in-venv pip, so this works whether or not the venv exists.
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
# --index-strategy unsafe-best-match lets uv honour the PyTorch CPU --extra-index-url in
# requirements.txt so torch+cpu resolves correctly.
uv pip install --python .venv/bin/python --index-strategy unsafe-best-match -r requirements.txt

if [ -n "${NEW_IMAGE_ID:-}" ]
then
    echo "==> Pointing the fleet at the new image (BURST_IMAGE_ID=$NEW_IMAGE_ID)..."
    [ -f "$DOCK_PRODUCTION_ENV" ] || { echo "ERROR: $DOCK_PRODUCTION_ENV not found"; exit 1; }
    if grep -q '^BURST_IMAGE_ID=' "$DOCK_PRODUCTION_ENV"
    then
        sed -i "s#^BURST_IMAGE_ID=.*#BURST_IMAGE_ID=${NEW_IMAGE_ID}#" "$DOCK_PRODUCTION_ENV"
    else
        printf '\nBURST_IMAGE_ID=%s\n' "$NEW_IMAGE_ID" >> "$DOCK_PRODUCTION_ENV"
    fi
fi

echo "==> Ensuring the Dock systemd service (so it survives reboots)..."
# Locate node. On this box node comes from nvm, not /usr/bin — and a non-login SSH
# may not have nvm on PATH, so fall back to the newest nvm install if needed.
NODE_BINARY="$(command -v node || true)"
if [ -z "$NODE_BINARY" ]
then
    NODE_BINARY="$(ls -1 "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
fi
[ -n "$NODE_BINARY" ] || { echo "ERROR: could not locate the node binary"; exit 1; }
NODE_DIRECTORY="$(dirname "$NODE_BINARY")"

# Always (re)write the unit so the node path + PATH stay correct. The absolute
# ExecStart path means systemd needs no nvm on its PATH; Environment=PATH still
# carries node for any child `node`/`npm` Dock might spawn.
cat >/etc/systemd/system/mindmeld-dock.service <<EOF
[Unit]
Description=MindMeld Dock
After=network-online.target redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$DOCK_DIRECTORY
Environment=PATH=$NODE_DIRECTORY:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$NODE_BINARY index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable mindmeld-dock.service

# One-time migration off the old `screen` workflow: quitting the session frees
# :3000 before systemd starts Dock. Harmless (and a no-op) once migrated.
echo "==> Migrating off any legacy 'mindmeld' screen session..."
screen -S mindmeld -X quit 2>/dev/null || true

echo "==> Ensuring the Cloudflare Tunnel runs as a service (idempotent)..."
if [ ! -f "$CLOUDFLARE_CONFIG_SOURCE" ]
then
    echo "    WARN: $CLOUDFLARE_CONFIG_SOURCE missing; skipping cloudflared setup."
else
    if ! command -v cloudflared >/dev/null 2>&1
    then
        echo "    Installing cloudflared..."
        curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
        dpkg -i /tmp/cloudflared.deb
        rm -f /tmp/cloudflared.deb
    fi

    mkdir -p /etc/cloudflared
    cp "$CLOUDFLARE_CONFIG_SOURCE" /etc/cloudflared/config.yml

    TUNNEL_NAME="$(awk -F': *' '/^tunnel:/ {print $2; exit}' /etc/cloudflared/config.yml)"
    TUNNEL_HOSTNAME="$(awk -F'hostname: *' '/hostname:/ {print $2; exit}' /etc/cloudflared/config.yml)"
    CREDENTIALS_FILE="$(awk -F': *' '/^credentials-file:/ {print $2; exit}' /etc/cloudflared/config.yml)"

    if [ -n "$CREDENTIALS_FILE" ] && [ ! -f "$CREDENTIALS_FILE" ]
    then
        echo "    WARN: tunnel credentials '$CREDENTIALS_FILE' missing — copy the tunnel's"
        echo "          JSON there (see Deployment.md §1.8). cloudflared will not start without it."
    fi

    # Route DNS (safe to re-run) and (re)install the service from the config.
    cloudflared tunnel route dns "$TUNNEL_NAME" "$TUNNEL_HOSTNAME" 2>/dev/null || true
    if [ ! -f /etc/systemd/system/cloudflared.service ]
    then
        cloudflared service install || true
    fi
    systemctl enable cloudflared 2>/dev/null || true
    systemctl restart cloudflared 2>/dev/null || true
fi

echo "==> Restarting Dock..."
systemctl daemon-reload
systemctl enable mindmeld-dock.service
systemctl restart mindmeld-dock.service

echo "==> Base node update complete."
