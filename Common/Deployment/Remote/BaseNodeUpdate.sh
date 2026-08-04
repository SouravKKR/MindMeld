#!/usr/bin/env bash
#
# Runs ON an always-on base node (as the SSH user), streamed there by
# deploy-environment.sh. Refreshes the Agent + Dock code + venv, points the fleet
# at the freshly-baked image, ensures Dock + cloudflared run as services
# (idempotently), and restarts Dock so the change takes effect.
#
# Inputs (exported by deploy-environment.sh on the ssh command line):
#   REPO_DIR                 — absolute repo path on the base node (e.g. /root/cogniumlearn)
#   AGENT_CONTEXT_ARCHIVE    — path to the uploaded Agent build context tarball
#   DOCK_CONTEXT_ARCHIVE     — path to the uploaded Dock build context tarball (optional)
#   NEW_IMAGE_ID             — baked image id to write as BURST_IMAGE_ID, or "" to skip
#   DOCK_ENV_FILE            — Dock env file name for this environment (default .production.env)
#   COGNIUMLEARN_ENVIRONMENT     — environment name baked into the systemd unit (default production)
#   CLOUDFLARE_TUNNEL_TOKEN  — remotely-managed tunnel token (required for cloudflared to run;
#                              see Deployment.md §1.8 — created in the Cloudflare Zero Trust
#                              dashboard, same as every other environment)
set -euo pipefail

DOCK_DIRECTORY="$REPO_DIR/Dock"
AGENT_DIRECTORY="$REPO_DIR/Agent"
DOCK_ENV_FILE="${DOCK_ENV_FILE:-.production.env}"
COGNIUMLEARN_ENVIRONMENT="${COGNIUMLEARN_ENVIRONMENT:-production}"

# The live Dock/Agent env files may be rendered to a RAM-backed tmpfs mount (no plaintext
# secret on persistent disk — see Common/ReadmeFiles/Deployment.md §0.7). When
# /etc/cogniumlearn/gcp.env sets COGNIUMLEARN_SECRETS_DIRECTORY the files live under it
# (<dir>/Dock, <dir>/Agent); otherwise they sit in the repo (legacy). Resolve the real paths
# so the BURST_IMAGE_ID stamp and the Secret Manager sync below act on the files the services
# actually read.
if [ -f /etc/cogniumlearn/gcp.env ]; then set -a; . /etc/cogniumlearn/gcp.env; set +a; fi
if [ -n "${COGNIUMLEARN_SECRETS_DIRECTORY:-}" ]
then
    DOCK_ENVIRONMENT_FILE="$COGNIUMLEARN_SECRETS_DIRECTORY/Dock/$DOCK_ENV_FILE"
    AGENT_ENVIRONMENT_FILE="$COGNIUMLEARN_SECRETS_DIRECTORY/Agent/$DOCK_ENV_FILE"
else
    DOCK_ENVIRONMENT_FILE="$DOCK_DIRECTORY/$DOCK_ENV_FILE"
    AGENT_ENVIRONMENT_FILE="$AGENT_DIRECTORY/$DOCK_ENV_FILE"
fi

[ -d "$REPO_DIR" ] || { echo "ERROR: REPO_DIR '$REPO_DIR' does not exist on the base node"; exit 1; }
[ -f "$AGENT_CONTEXT_ARCHIVE" ] || { echo "ERROR: agent context '$AGENT_CONTEXT_ARCHIVE' not found"; exit 1; }

echo "==> [$COGNIUMLEARN_ENVIRONMENT] Refreshing Agent code from the uploaded context..."
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

# The tmpfs env files are wiped on reboot and re-rendered at Dock start; ensure they exist
# before stamping BURST_IMAGE_ID (a mid-deploy render is a harmless no-op when already present).
if [ -n "${COGNIUMLEARN_SECRETS_DIRECTORY:-}" ] && [ -x /etc/cogniumlearn/refresh-secrets.sh ] && [ ! -f "$DOCK_ENVIRONMENT_FILE" ]
then
    /etc/cogniumlearn/refresh-secrets.sh "$COGNIUMLEARN_ENVIRONMENT" || true
fi

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

echo "==> Ensuring the Dock systemd service (env=$COGNIUMLEARN_ENVIRONMENT)..."
# Locate node (may come from nvm rather than /usr/bin).
NODE_BINARY="$(command -v node || true)"
if [ -z "$NODE_BINARY" ]
then
    NODE_BINARY="$(ls -1 "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
fi
[ -n "$NODE_BINARY" ] || { echo "ERROR: could not locate the node binary"; exit 1; }
NODE_DIRECTORY="$(dirname "$NODE_BINARY")"

# Pre-rebrand nodes run the old unit name ("mindmeld-dock.service"), which is NOT
# renamed automatically by systemd — it would keep running and fighting the new
# "cogniumlearn-dock.service" unit for port 3000. Stop + disable it once; a no-op
# (unit not found) on nodes that never had it or have already migrated.
if systemctl list-unit-files mindmeld-dock.service >/dev/null 2>&1
then
    echo "==> Migrating off the legacy 'mindmeld-dock' systemd unit..."
    systemctl stop mindmeld-dock.service 2>/dev/null || true
    systemctl disable mindmeld-dock.service 2>/dev/null || true
    rm -f /etc/systemd/system/mindmeld-dock.service
fi

# The COGNIUMLEARN_ENVIRONMENT variable makes both Dock AND the Agent subprocesses it
# spawns load Dock/.<env>.env and Agent/.<env>.env (see the env resolver in
# Dock/index.js and Agent/Globals/Utility/EnvironmentLoader.py). The absolute
# ExecStart path means systemd needs no nvm on PATH. COGNIUMLEARN_SECRETS_DIRECTORY
# (when this node has the Secret Manager tmpfs wiring — see /etc/cogniumlearn/gcp.env
# above) MUST be passed through here: Dock/index.js's resolveDockSecretsDirectory()
# reads it from process.env to find the rendered .env under the tmpfs mount, falling
# back to __dirname (no env file on disk, since the tar upload excludes .env files)
# when it's absent — a missing Environment= line here means Persistence.js's
# module-load-time S3Client construction throws "Region is missing" and Dock
# crash-loops. This line was missing entirely before 2026-07-21; added then.
cat >/etc/systemd/system/cogniumlearn-dock.service <<EOF
[Unit]
Description=CogniumLearn Dock ($COGNIUMLEARN_ENVIRONMENT)
After=network-online.target redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$DOCK_DIRECTORY
Environment=PATH=$NODE_DIRECTORY:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=COGNIUMLEARN_ENVIRONMENT=$COGNIUMLEARN_ENVIRONMENT
Environment=COGNIUMLEARN_SECRETS_DIRECTORY=${COGNIUMLEARN_SECRETS_DIRECTORY:-}
ExecStart=$NODE_BINARY index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable cogniumlearn-dock.service

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
    #
    # `cloudflared service install` is NOT idempotent — it REFUSES when a service already
    # exists. Swallowing that error (the old `2>/dev/null || true`) left the previous unit
    # in place, so a ROTATED TOKEN COULD NEVER TAKE EFFECT: the node kept reconnecting to
    # the tunnel it was first installed with, serving that tunnel's hostname, while the
    # intended tunnel showed zero connectors in the dashboard and its hostname returned
    # Cloudflare 1033/530. Observed on development 2026-08-04 (still serving the
    # pre-rebrand hostname months after the rename).
    #
    # So: compare the token already baked into the unit and reinstall only when it differs
    # — a full stop/uninstall/install on every deploy would add avoidable tunnel downtime.
    echo "    Using token-based (remotely-managed) tunnel."
    if grep -qF -- "$CLOUDFLARE_TUNNEL_TOKEN" /etc/systemd/system/cloudflared.service 2>/dev/null
    then
        echo "    cloudflared is already installed with this token."
    else
        echo "    Token differs from the installed service (or none installed) — reinstalling."
        systemctl stop cloudflared 2>/dev/null || true
        cloudflared service uninstall 2>/dev/null || true
        systemctl disable cloudflared 2>/dev/null || true
        rm -f /etc/systemd/system/cloudflared.service
        rm -rf /etc/cloudflared
        systemctl daemon-reload 2>/dev/null || true
        cloudflared service install "$CLOUDFLARE_TUNNEL_TOKEN"
    fi
    systemctl enable cloudflared 2>/dev/null || true
    systemctl restart cloudflared 2>/dev/null || true
else
    echo "    WARN: no CLOUDFLARE_TUNNEL_TOKEN set (deployment.env) — skipping cloudflared."
fi

# Sync the just-updated env files up to Google Secret Manager BEFORE the restart, so the
# Dock unit's ExecStartPre render-on-restart does not revert deploy-written values such as
# BURST_IMAGE_ID (see Common/ReadmeFiles/Deployment.md §0.7.8). Only runs when this node has
# the Secret Manager wiring (/etc/cogniumlearn/gcp.env). Diff-guarded: a new version is added
# only when the content changed. Best-effort — a failure warns but never aborts the deploy.
if [ -f /etc/cogniumlearn/gcp.env ]
then
    echo "==> Syncing env files to Secret Manager (render-on-restart is wired)..."
    set -a
    . /etc/cogniumlearn/gcp.env
    set +a
    if command -v gcloud >/dev/null 2>&1 && [ -n "${GCP_PROJECT_ID:-}" ] && [ -f "${GCP_SERVICE_ACCOUNT_KEY_PATH:-}" ]
    then
        gcloud auth activate-service-account --key-file="$GCP_SERVICE_ACCOUNT_KEY_PATH" --quiet 2>/dev/null || true
        for secretPair in "dock-env:$DOCK_ENVIRONMENT_FILE" "agent-env:$AGENT_ENVIRONMENT_FILE"
        do
            secretName="${secretPair%%:*}"
            secretFile="${secretPair##*:}"
            [ -f "$secretFile" ] || continue
            if gcloud secrets versions access latest --project="$GCP_PROJECT_ID" --secret="$secretName" 2>/dev/null | diff -q - "$secretFile" >/dev/null 2>&1
            then
                echo "    [gsm-sync] $secretName unchanged — no new version."
            else
                if gcloud secrets versions add "$secretName" --project="$GCP_PROJECT_ID" --data-file="$secretFile" >/dev/null 2>&1
                then
                    echo "    [gsm-sync] $secretName — new version pushed."
                else
                    echo "    [gsm-sync] WARN: could not push $secretName; render-on-restart may revert it. Re-sync manually."
                fi
            fi
        done
    else
        echo "    [gsm-sync] WARN: gcloud/key/project not ready; skipping Secret Manager sync."
    fi
fi

echo "==> Restarting Dock..."
systemctl daemon-reload
systemctl restart cogniumlearn-dock.service

echo "==> Base node update complete ($COGNIUMLEARN_ENVIRONMENT)."
