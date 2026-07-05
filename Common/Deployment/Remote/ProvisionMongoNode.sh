#!/usr/bin/env bash
#
# Runs ON a fresh Debian 12 MongoDB node (as root), streamed there by
# provision-environment.sh for environments whose mongoTopology is "separate"
# (Testing, Production). Installs MongoDB Community, binds it to loopback + the
# node's VPC private IP, creates the root user and enables authorization. The
# node's Cloud Firewall (MindMeld-<Env>-DatabaseFirewall) already restricts 27017
# to the VPC CIDR, so the database is never exposed publicly.
#
# Inputs (exported on the ssh command line by provision-environment.sh):
#   MONGO_BIND_IP          — the node's VPC private IP (e.g. 10.20.0.20)
#   MONGO_ROOT_USER        — root username to create
#   MONGO_ROOT_PASSWORD    — root password to create
#   MONGO_VERSION          — MongoDB major version (default 7.0)
#
# Idempotent: re-running verifies the user authenticates and leaves data intact.
set -euo pipefail

MONGO_BIND_IP="${MONGO_BIND_IP:?MONGO_BIND_IP is required}"
MONGO_ROOT_USER="${MONGO_ROOT_USER:?MONGO_ROOT_USER is required}"
MONGO_ROOT_PASSWORD="${MONGO_ROOT_PASSWORD:?MONGO_ROOT_PASSWORD is required}"
MONGO_VERSION="${MONGO_VERSION:-7.0}"

export DEBIAN_FRONTEND=noninteractive

echo "==> Installing MongoDB ${MONGO_VERSION} (if missing)..."
if ! command -v mongod >/dev/null 2>&1
then
    apt-get update
    apt-get install -y --no-install-recommends ca-certificates curl gnupg
    curl -fsSL "https://www.mongodb.org/static/pgp/server-${MONGO_VERSION}.asc" \
        | gpg -o "/usr/share/keyrings/mongodb-server-${MONGO_VERSION}.gpg" --dearmor
    echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-${MONGO_VERSION}.gpg ] http://repo.mongodb.org/apt/debian bookworm/mongodb-org/${MONGO_VERSION} main" \
        > "/etc/apt/sources.list.d/mongodb-org-${MONGO_VERSION}.list"
    apt-get update
    apt-get install -y mongodb-org
fi

echo "==> Binding mongod to 127.0.0.1 + ${MONGO_BIND_IP}..."
# bindIp lives under net: in /etc/mongod.conf. Set it precisely so the daemon is
# reachable over the VPC but nowhere else.
sed -i -E "s/^( *bindIp:).*/\1 127.0.0.1,${MONGO_BIND_IP}/" /etc/mongod.conf

systemctl enable mongod
systemctl restart mongod

# Wait for the daemon to accept connections.
for _attempt in $(seq 1 30)
do
    if mongosh --quiet --host 127.0.0.1 --eval 'db.runCommand({ ping: 1 })' >/dev/null 2>&1
    then
        break
    fi
    sleep 2
done

if mongosh --quiet --host 127.0.0.1 -u "$MONGO_ROOT_USER" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin --eval 'db.runCommand({ ping: 1 })' >/dev/null 2>&1
then
    echo "==> Root user already present and authenticating — leaving data + auth untouched."
else
    echo "==> Creating the root user '${MONGO_ROOT_USER}'..."
    mongosh --quiet --host 127.0.0.1 admin --eval "
        db.createUser({
            user: '${MONGO_ROOT_USER}',
            pwd: '${MONGO_ROOT_PASSWORD}',
            roles: [ { role: 'root', db: 'admin' } ]
        });
    "
    echo "==> Enabling authorization..."
    if grep -qE '^security:' /etc/mongod.conf
    then
        grep -qE '^\s*authorization:' /etc/mongod.conf || sed -i '/^security:/a\  authorization: enabled' /etc/mongod.conf
    else
        printf '\nsecurity:\n  authorization: enabled\n' >> /etc/mongod.conf
    fi
    systemctl restart mongod
fi

echo "==> MongoDB node ready (bound to 127.0.0.1,${MONGO_BIND_IP}; auth enabled)."
