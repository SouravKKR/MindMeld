#!/usr/bin/env bash
#
# Runs ON a fresh Debian 12 base node (as root), streamed there by
# provision-environment.sh. Installs the OS + data tier that the app layer needs:
# system packages (Redis, OCR stack, build tools), Node.js, the Agent Python venv,
# the Dock npm dependencies, and — for the "colocated" Mongo topology (Development)
# — a local MongoDB. It deliberately does NOT install the Dock systemd unit,
# cloudflared or the burst image: provision-environment.sh finishes by invoking
# deploy-environment.sh, whose BaseNodeUpdate step owns those (so that logic lives
# in exactly one place).
#
# Inputs (exported on the ssh command line):
#   REPO_DIR               — absolute repo path to create/populate (e.g. /root/cogniumlearn)
#   COGNIUMLEARN_ENVIRONMENT   — environment name (for log lines)
#   MONGO_TOPOLOGY         — "colocated" | "separate"
#   BASE_PRIVATE_IP        — this node's VPC private IP (Redis/Mongo bind target)
#   AGENT_CONTEXT_ARCHIVE  — uploaded Agent build context tarball to extract
#   DOCK_CONTEXT_ARCHIVE   — uploaded Dock build context tarball to extract
#   MONGO_ROOT_USER / MONGO_ROOT_PASSWORD / MONGO_VERSION  — only when colocated
#   NODE_MAJOR             — Node.js major version (default 22)
#
# Idempotent: safe to re-run on an already-provisioned node.
set -euo pipefail

REPO_DIR="${REPO_DIR:?REPO_DIR is required}"
COGNIUMLEARN_ENVIRONMENT="${COGNIUMLEARN_ENVIRONMENT:-development}"
MONGO_TOPOLOGY="${MONGO_TOPOLOGY:-colocated}"
BASE_PRIVATE_IP="${BASE_PRIVATE_IP:-}"
NODE_MAJOR="${NODE_MAJOR:-22}"
DOCK_DIRECTORY="$REPO_DIR/Dock"
AGENT_DIRECTORY="$REPO_DIR/Agent"
export DEBIAN_FRONTEND=noninteractive

echo "==> [$COGNIUMLEARN_ENVIRONMENT] Extracting uploaded code contexts into $REPO_DIR..."
mkdir -p "$REPO_DIR"
if [ -n "${AGENT_CONTEXT_ARCHIVE:-}" ] && [ -f "$AGENT_CONTEXT_ARCHIVE" ]
then
    tar -xzf "$AGENT_CONTEXT_ARCHIVE" -C "$REPO_DIR"
    rm -f "$AGENT_CONTEXT_ARCHIVE"
fi
if [ -n "${DOCK_CONTEXT_ARCHIVE:-}" ] && [ -f "$DOCK_CONTEXT_ARCHIVE" ]
then
    tar -xzf "$DOCK_CONTEXT_ARCHIVE" -C "$REPO_DIR"
    rm -f "$DOCK_CONTEXT_ARCHIVE"
fi

echo "==> System packages (Redis, OCR stack, build tools)..."
apt-get update
apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg build-essential screen \
    redis-server \
    ocrmypdf tesseract-ocr ghostscript qpdf

echo "==> Node.js ${NODE_MAJOR}.x (if missing)..."
if ! command -v node >/dev/null 2>&1
then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs
fi

echo "==> Binding Redis to loopback + the VPC private IP..."
if [ -n "$BASE_PRIVATE_IP" ]
then
    sed -i "s/^bind .*/bind 127.0.0.1 $BASE_PRIVATE_IP/" /etc/redis/redis.conf
    sed -i "s/^protected-mode .*/protected-mode no/" /etc/redis/redis.conf
    echo "    Redis bound to 127.0.0.1 + $BASE_PRIVATE_IP (firewall restricts 6379 to the VPC)."
else
    echo "    WARN: BASE_PRIVATE_IP unset; Redis stays on 127.0.0.1 (burst workers will NOT reach it)."
fi
systemctl enable redis-server
systemctl restart redis-server

if [ "$MONGO_TOPOLOGY" = "colocated" ]
then
    MONGO_VERSION="${MONGO_VERSION:-7.0}"
    MONGO_ROOT_USER="${MONGO_ROOT_USER:?MONGO_ROOT_USER is required for colocated Mongo}"
    MONGO_ROOT_PASSWORD="${MONGO_ROOT_PASSWORD:?MONGO_ROOT_PASSWORD is required for colocated Mongo}"

    echo "==> Installing colocated MongoDB ${MONGO_VERSION} (if missing)..."
    if ! command -v mongod >/dev/null 2>&1
    then
        curl -fsSL "https://www.mongodb.org/static/pgp/server-${MONGO_VERSION}.asc" \
            | gpg -o "/usr/share/keyrings/mongodb-server-${MONGO_VERSION}.gpg" --dearmor
        echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-${MONGO_VERSION}.gpg ] http://repo.mongodb.org/apt/debian bookworm/mongodb-org/${MONGO_VERSION} main" \
            > "/etc/apt/sources.list.d/mongodb-org-${MONGO_VERSION}.list"
        apt-get update
        apt-get install -y mongodb-org
    fi

    echo "==> Binding mongod to 127.0.0.1 + ${BASE_PRIVATE_IP}..."
    sed -i -E "s/^( *bindIp:).*/\1 127.0.0.1,${BASE_PRIVATE_IP}/" /etc/mongod.conf
    systemctl enable mongod
    systemctl restart mongod
    for _attempt in $(seq 1 30)
    do
        mongosh --quiet --host 127.0.0.1 --eval 'db.runCommand({ ping: 1 })' >/dev/null 2>&1 && break
        sleep 2
    done

    if mongosh --quiet --host 127.0.0.1 -u "$MONGO_ROOT_USER" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin --eval 'db.runCommand({ ping: 1 })' >/dev/null 2>&1
    then
        echo "    Colocated Mongo root user already present — leaving data + auth untouched."
    else
        echo "    Creating the Mongo root user '${MONGO_ROOT_USER}'..."
        mongosh --quiet --host 127.0.0.1 admin --eval "db.createUser({ user: '${MONGO_ROOT_USER}', pwd: '${MONGO_ROOT_PASSWORD}', roles: [ { role: 'root', db: 'admin' } ] });"
        if grep -qE '^security:' /etc/mongod.conf
        then
            grep -qE '^\s*authorization:' /etc/mongod.conf || sed -i '/^security:/a\  authorization: enabled' /etc/mongod.conf
        else
            printf '\nsecurity:\n  authorization: enabled\n' >> /etc/mongod.conf
        fi
        systemctl restart mongod
    fi
fi

echo "==> uv + Python 3.12 (if missing)..."
if ! command -v uv >/dev/null 2>&1
then
    curl -LsSf https://astral.sh/uv/install.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"

echo "==> Agent venv + dependencies (CPU torch + ML stack; ~10-15 min)..."
cd "$AGENT_DIRECTORY"
[ -x ".venv/bin/python" ] || uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python --index-strategy unsafe-best-match -r requirements.txt

echo "==> Dock dependencies (npm)..."
cd "$DOCK_DIRECTORY"
npm install

echo "==> Base node OS + data tier ready ($COGNIUMLEARN_ENVIRONMENT). App layer follows via deploy."
