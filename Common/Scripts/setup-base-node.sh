#!/usr/bin/env bash
#
# MindMeld base-node setup — run as root on a fresh Debian 12 base node.
# Installs everything the base node needs and starts Dock under systemd.
#
# Prerequisites (do these BEFORE running):
#   - The repo is cloned on the box (e.g. /root/mindmeld or /opt/mindmeld/MindMeld).
#   - Dock/.production.env AND Agent/.production.env are filled in and present.
#   - The node is attached to the VPC. Mongo runs on its own node and is reachable
#     at its VPC IP (Dock/.production.env -> MONGODB_URL uses that VPC IP). Redis is
#     installed and started LOCALLY by this script.
#
# Usage (from anywhere; REPO_DIR defaults to the repo this script lives in):
#   sudo bash Common/Scripts/setup-base-node.sh
#   sudo REPO_DIR=/root/mindmeld bash Common/Scripts/setup-base-node.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
DOCK_DIR="$REPO_DIR/Dock"
AGENT_DIR="$REPO_DIR/Agent"
NODE_MAJOR="${NODE_MAJOR:-22}"
# Which environment this base node serves. Defaults to production (back-compat).
# The env files are Dock/.<env>.env + Agent/.<env>.env and the systemd unit exports
# MINDMELD_ENVIRONMENT so Dock + its Agent subprocesses load the right one. For a
# full from-scratch provision use Common/Deployment/provision-environment.sh instead.
MINDMELD_ENVIRONMENT="${MINDMELD_ENVIRONMENT:-production}"
ENVIRONMENT_FILE_NAME=".${MINDMELD_ENVIRONMENT}.env"

echo "==> Repo root: $REPO_DIR  (environment: $MINDMELD_ENVIRONMENT)"
[ -f "$DOCK_DIR/$ENVIRONMENT_FILE_NAME" ]  || { echo "ERROR: missing $DOCK_DIR/$ENVIRONMENT_FILE_NAME";  exit 1; }
[ -f "$AGENT_DIR/$ENVIRONMENT_FILE_NAME" ] || { echo "ERROR: missing $AGENT_DIR/$ENVIRONMENT_FILE_NAME"; exit 1; }

echo "==> System packages (Redis, OCR stack, build tools)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
    ca-certificates curl build-essential \
    redis-server \
    ocrmypdf tesseract-ocr ghostscript qpdf
# Non-English OCR? add language packs, e.g.: apt-get install -y tesseract-ocr-hin

echo "==> Node.js ${NODE_MAJOR}.x (if missing)..."
if ! command -v node >/dev/null 2>&1; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs
fi

echo "==> Bind Redis to loopback + the VPC private IP so burst workers can reach it..."
# (The Dock Cloud Firewall must allow 6379 only from the VPC CIDR — that's the
#  protection; protected-mode is disabled because access is firewalled, and the
#  env URLs are password-less.)
VPC_IP="$(ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 \
    | grep -E '^10\.|^192\.168\.|^172\.(1[6-9]|2[0-9]|3[0-1])\.' | head -1 || true)"
if [ -n "$VPC_IP" ]; then
    sed -i "s/^bind .*/bind 127.0.0.1 $VPC_IP/" /etc/redis/redis.conf
    sed -i "s/^protected-mode .*/protected-mode no/" /etc/redis/redis.conf
    echo "    Redis bound to 127.0.0.1 + $VPC_IP"
else
    echo "    WARN: no VPC private IP found; Redis stays on 127.0.0.1 only (burst workers will NOT reach it)."
fi
systemctl enable redis-server
systemctl restart redis-server

echo "==> uv + Python 3.12..."
if ! command -v uv >/dev/null 2>&1; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"

echo "==> Agent venv + dependencies (CPU torch + ML stack; ~10-15 min)..."
cd "$AGENT_DIR"
uv venv --python 3.12 .venv
# --index-strategy unsafe-best-match: requirements.txt adds the PyTorch CPU index;
# without this uv resolves each package against only the first index that has it.
uv pip install --python .venv/bin/python --index-strategy unsafe-best-match -r requirements.txt

echo "==> Dock dependencies (npm)..."
cd "$DOCK_DIR"
npm install

echo "==> Dock systemd service..."
NODE_BIN="$(command -v node)"
cat >/etc/systemd/system/mindmeld-dock.service <<EOF
[Unit]
Description=MindMeld Dock ($MINDMELD_ENVIRONMENT)
After=network-online.target redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$DOCK_DIR
Environment=MINDMELD_ENVIRONMENT=$MINDMELD_ENVIRONMENT
ExecStart=$NODE_BIN index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now mindmeld-dock

echo ""
echo "==> Done. Dock is running under systemd."
echo "    Logs:    journalctl -u mindmeld-dock -f"
echo "    Restart: systemctl restart mindmeld-dock"
echo ""
echo "Still MANUAL (not automated here):"
echo "  1. Cloudflare Tunnel for public access  (Deployment.md 1.8)."
echo "  2. Remove the SSH rule from the Burst Cloud Firewall (so burst VMs aren't exposed)."
echo "  3. Confirm Mongo accepts the VPC connection (its bindIp includes the VPC IP)."
