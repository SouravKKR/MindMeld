#!/usr/bin/env bash
#
# Full, idempotent provision-from-zero of a CogniumLearn environment on Linode.
#
#     bash Common/Deployment/provision-environment.sh <development|testing|production> [--dry-run] [--skip-deploy]
#
# It brings an environment up from nothing and is safe to re-run: every cloud
# resource is matched by its CogniumLearn-<Env>-<Role> label (create-if-absent), and
# every remote step is idempotent. A run does, in order:
#
#   1. Scaffold the env files (deployment.env per-env keys, Dock/.<env>.env, Agent/.<env>.env)
#      from the committed templates, auto-generating the crypto secrets
#      (PAID_DECK_MASTER_KEY_BASE64, Mongo password) it can, and STOP early if a
#      secret only YOU can supply (Gemini/OpenAI/Google-OAuth/Cloudflare) is missing
#      — before a single paid resource is created.
#   2. Ensure the VPC + subnet, the three Cloud Firewalls, the base node, and (for
#      the separate-Mongo topology) the Mongo node.
#   3. Install the OS + data tier on the base node (and Mongo node), writing the
#      resolved private URLs + resource ids into the env files.
#   4. Hand off to deploy-environment.sh to build the frontend, bake the burst
#      image, wire the token-based Cloudflare tunnel and start Dock.
#
# --dry-run   : report the plan; create/modify nothing (look-ups still run).
# --skip-deploy: provision infra + node only; skip the image bake / code roll-out.
set -euo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIRECTORY/Library/Logging.sh"
source "$SCRIPT_DIRECTORY/Library/LinodeApi.sh"
source "$SCRIPT_DIRECTORY/Library/EnvironmentConfig.sh"

FIREWALL_RULES_SCRIPT="$SCRIPT_DIRECTORY/Library/FirewallRules.js"
DRY_RUN=0
SKIP_DEPLOY=0
DEFER_SECRETS=0
ENVIRONMENT_NAME_ARGUMENT=""

for argument in "$@"
do
    case "$argument" in
        --dry-run) DRY_RUN=1; LINODE_DRY_RUN=1 ;;
        --skip-deploy) SKIP_DEPLOY=1 ;;
        --defer-secrets) DEFER_SECRETS=1 ;;
        -*) log_error "Unknown flag: $argument"; exit 1 ;;
        *) ENVIRONMENT_NAME_ARGUMENT="$argument" ;;
    esac
done
[ -n "$ENVIRONMENT_NAME_ARGUMENT" ] || { log_error "Usage: provision-environment.sh <development|testing|production> [--dry-run] [--skip-deploy]"; exit 1; }

load_environment_config "$ENVIRONMENT_NAME_ARGUMENT"
[ "$ENVIRONMENT_NAME" != "local" ] || { log_error "The 'local' environment runs via npm (no provisioning). Use: npm run web"; exit 1; }
load_deployment_secrets "$ENVIRONMENT_NAME"

[ "$DRY_RUN" -eq 1 ] && log_warning "DRY RUN — no resources will be created or modified."

# One shared deployment.env holds every environment's deploy secrets, keyed by an
# uppercase-environment suffix (e.g. CLOUDFLARE_TUNNEL_TOKEN_DEVELOPMENT). The generic
# names the orchestrator uses (CLOUDFLARE_TUNNEL_TOKEN, BASE_NODE_SSH_HOST, ...) are
# resolved from those by load_deployment_secrets.
DEPLOYMENT_ENV_FILE="$REPOSITORY_ROOT/deployment.env"
ENVIRONMENT_UPPER="$(printf '%s' "$ENVIRONMENT_NAME" | tr '[:lower:]' '[:upper:]')"
DOCK_ENVIRONMENT_FILE="$REPOSITORY_ROOT/Dock/$(dock_environment_file_name)"
AGENT_ENVIRONMENT_FILE="$REPOSITORY_ROOT/Agent/$(agent_environment_file_name)"
DEPLOY_SSH_PRIVATE_KEY_PATH="${DEPLOY_SSH_PRIVATE_KEY_PATH/#\~/$HOME}"
DEPLOY_SSH_PUBLIC_KEY_PATH="${DEPLOY_SSH_PUBLIC_KEY_PATH/#\~/$HOME}"
BASE_NODE_REPO_DIR="${BASE_NODE_REPO_DIR:-/root/cogniumlearn}"
BASE_NODE_SSH_USER="${BASE_NODE_SSH_USER:-root}"
# ServerAliveInterval keeps long install sessions alive through NAT idle windows;
# the install calls below also auto-retry if the link resets mid-stream.
SSH_COMMON_OPTIONS=(-o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=10 -i "$DEPLOY_SSH_PRIVATE_KEY_PATH")

# ── env-file helpers ──────────────────────────────────────────────────────────
read_env_value()
{
    local file="$1" key="$2"
    [ -f "$file" ] || return 0
    grep -E "^${key}=" "$file" | head -1 | cut -d= -f2- || true
}

# Set KEY=value in an env file (replace in place or append). No-op in dry-run.
write_env_value()
{
    local file="$1" key="$2" value="$3"
    if [ "$DRY_RUN" -eq 1 ]; then return 0; fi
    touch "$file"
    if grep -qE "^${key}=" "$file"
    then
        # The value is passed through the environment, never as an argv, so Git Bash's
        # MSYS layer cannot path-convert a POSIX value (e.g. /root/cogniumlearn/Agent) into a
        # Windows path. The file arg stays positional because node on Windows needs the
        # converted path.
        WRITE_ENV_VALUE="$value" node -e '
            const fs = require("fs");
            const [file, key] = process.argv.slice(1);
            const value = process.env.WRITE_ENV_VALUE;
            const lines = fs.readFileSync(file, "utf8").split("\n");
            const out = lines.map(line => line.startsWith(key + "=") ? key + "=" + value : line);
            fs.writeFileSync(file, out.join("\n"));
        ' "$file" "$key"
    else
        printf '%s=%s\n' "$key" "$value" >> "$file"
    fi
}

generate_base64_key() { node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"; }
generate_password()   { node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"; }
detect_admin_cidr()   { local ip; ip="$(curl -s --max-time 8 https://api.ipify.org || true)"; [ -n "$ip" ] && printf '%s/32' "$ip" || printf '0.0.0.0/0'; }

# Write a per-environment deploy secret as KEY_<ENV> into the shared deployment.env.
write_deployment_value() { write_env_value "$DEPLOYMENT_ENV_FILE" "${1}_${ENVIRONMENT_UPPER}" "$2"; }

# Pull the password out of an existing mongodb:// URL (blank if none/unparseable), so a
# re-run reuses the credential already stored in the env file rather than rotating it.
extract_mongo_password() { node -e 'try{process.stdout.write(decodeURIComponent(new URL(process.argv[1]||"").password||""))}catch{process.stdout.write("")}' "$1"; }

value_is_missing()
{
    case "${1:-}" in
        ""|REPLACE_*|"<"*) return 0 ;;
        *) return 1 ;;
    esac
}

# Write a file from stdin only when it does not already exist (never clobbers real
# secrets) and only outside a dry run. Always drains stdin so the caller's heredoc
# is consumed either way.
create_file_if_absent()
{
    local target="$1"
    if [ -f "$target" ] || [ "$DRY_RUN" -eq 1 ]
    then
        cat >/dev/null
        return 0
    fi
    cat > "$target"
    log_info "Created $target."
}

# ── 1. Scaffold env files + validate the secrets only the user can provide ─────
scaffold_environment_files()
{
    log_step "Scaffolding env files for '$ENVIRONMENT_NAME'..."

    # Ensure the shared deployment.env carries this environment's key block. The
    # Cloudflare token is yours to fill; BASE_NODE_SSH_HOST + Mongo creds are filled
    # in later by provisioning.
    if ! grep -qE "^CLOUDFLARE_TUNNEL_TOKEN_${ENVIRONMENT_UPPER}=" "$DEPLOYMENT_ENV_FILE" 2>/dev/null && [ "$DRY_RUN" -eq 0 ]
    then
        {
            printf '\n# ── %s (fill CLOUDFLARE_TUNNEL_TOKEN_%s; provisioning fills the rest) ──\n' "$ENVIRONMENT_NAME" "$ENVIRONMENT_UPPER"
            printf 'CLOUDFLARE_TUNNEL_TOKEN_%s=\n' "$ENVIRONMENT_UPPER"
            printf 'BASE_NODE_SSH_HOST_%s=\n' "$ENVIRONMENT_UPPER"
        } >> "$DEPLOYMENT_ENV_FILE"
        log_info "Added a '$ENVIRONMENT_NAME' key block to deployment.env — fill CLOUDFLARE_TUNNEL_TOKEN_${ENVIRONMENT_UPPER}."
    fi

    # Auto-detect the admin SSH CIDR if not pinned, so this dev box can reach the nodes.
    ADMIN_SSH_CIDR="${ADMIN_SSH_CIDR:-$(detect_admin_cidr)}"
    log_info "Admin SSH CIDR: $ADMIN_SSH_CIDR"
    [ "$ADMIN_SSH_CIDR" = "0.0.0.0/0" ] && log_warning "Could not detect your public IP — SSH will be open to the world. Set ADMIN_SSH_CIDR in deployment.env."

    # Create the actual Dock + Agent env files (only if absent — never clobbers).
    create_file_if_absent "$DOCK_ENVIRONMENT_FILE" <<EOF
# Dock config for $ENVIRONMENT_NAME. Fill GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (add the
# redirect URI https://${ENVIRONMENT_DOMAIN}/Login/Callback to the OAuth client).
# provision-environment.sh appends MONGODB_URL / REDIS_URL / DOMAIN_NAME / BURST_* below.
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
PAID_DECK_MASTER_KEY_BASE64=
EOF

    create_file_if_absent "$AGENT_ENVIRONMENT_FILE" <<EOF
# Agent config for $ENVIRONMENT_NAME. Vertex AI auth: set GOOGLE_ENTERPRISE_AGENT_PROJECT and
# GOOGLE_ENTERPRISE_AGENT_CREDENTIALS_BASE64 (base64 -w0 of a "Vertex AI User" service-account key
# JSON for that project) — a service account is ~10x faster to first token than an API key. Optional:
# GOOGLE_ENTERPRISE_AGENT_LOCATION (default "global") and OPENAI_API_KEY. provision appends MONGODB_URL / REDIS_URL.
GOOGLE_ENTERPRISE_AGENT_PROJECT=
GOOGLE_ENTERPRISE_AGENT_LOCATION=global
GOOGLE_ENTERPRISE_AGENT_CREDENTIALS_BASE64=
OPENAI_API_KEY=
EOF

    # Generate the crypto secret we own, if absent.
    if value_is_missing "$(read_env_value "$DOCK_ENVIRONMENT_FILE" PAID_DECK_MASTER_KEY_BASE64)"
    then
        write_env_value "$DOCK_ENVIRONMENT_FILE" PAID_DECK_MASTER_KEY_BASE64 "$(generate_base64_key)"
        log_info "Generated PAID_DECK_MASTER_KEY_BASE64 for '$ENVIRONMENT_NAME'."
    fi

    # Validate the user-only secrets. Missing any of these STOPS before we create
    # paid infrastructure (a dry run only warns).
    local missing=()
    value_is_missing "$(read_env_value "$DOCK_ENVIRONMENT_FILE" GOOGLE_CLIENT_ID)"     && missing+=("Dock/$(dock_environment_file_name): GOOGLE_CLIENT_ID")
    value_is_missing "$(read_env_value "$DOCK_ENVIRONMENT_FILE" GOOGLE_CLIENT_SECRET)" && missing+=("Dock/$(dock_environment_file_name): GOOGLE_CLIENT_SECRET")
    if value_is_missing "$(read_env_value "$AGENT_ENVIRONMENT_FILE" GOOGLE_ENTERPRISE_AGENT_PROJECT)" \
       && value_is_missing "$(read_env_value "$AGENT_ENVIRONMENT_FILE" GOOGLE_ENTERPRISE_AGENT_API_KEY)"
    then
        missing+=("Agent/$(agent_environment_file_name): GOOGLE_ENTERPRISE_AGENT_PROJECT + _CREDENTIALS_BASE64 (service account, preferred) or _API_KEY (slow fallback)")
    fi
    value_is_missing "${CLOUDFLARE_TUNNEL_TOKEN:-}"                                    && missing+=("deployment.env: CLOUDFLARE_TUNNEL_TOKEN_${ENVIRONMENT_UPPER}")

    if [ "${#missing[@]}" -gt 0 ]
    then
        echo
        log_warning "These user-supplied secrets are still blank:"
        for entry in "${missing[@]}"; do log_warning "    - $entry"; done
        log_warning "Google OAuth: add the redirect URI  https://${ENVIRONMENT_DOMAIN}/Login/Callback"
        log_warning "Cloudflare:   create a token tunnel routing ${ENVIRONMENT_DOMAIN} -> http://127.0.0.1:3000, paste its token."
        if [ "$DRY_RUN" -eq 0 ] && [ "$DEFER_SECRETS" -eq 0 ]
        then
            log_error "Aborting before creating any paid resources. Fill the values above and re-run (or pass --defer-secrets to prep infra now and add them later)."
            exit 1
        fi
        [ "$DEFER_SECRETS" -eq 1 ] && log_warning "--defer-secrets: prepping infra + install anyway. The tunnel is skipped until the Cloudflare token is set; sign-in + AI stay disabled until Google/Gemini are filled. Re-run deploy after filling them."
    fi
}

# ── 2. Ensure the VPC + firewalls + instances ─────────────────────────────────
ensure_infrastructure()
{
    log_step "Ensuring VPC + subnet ($(label_for_role VPC), $ENVIRONMENT_SUBNET_CIDR)..."
    read VPC_ID SUBNET_ID <<< "$(linode_ensure_vpc "$(label_for_role VPC)" "$ENVIRONMENT_REGION" "$(label_for_role Subnet)" "$ENVIRONMENT_SUBNET_CIDR")"
    log_info "VPC id=$VPC_ID subnet id=$SUBNET_ID"

    log_step "Ensuring Cloud Firewalls..."
    local server_role="server-separate"
    [ "$ENVIRONMENT_MONGO_TOPOLOGY" = "colocated" ] && server_role="server-colocated"

    # Firewall labels are capped at 32 chars by Linode, so firewalls use the short
    # role names SrvFW / DbFW / BurstFW (still CogniumLearn-<Env>- prefixed) — the
    # longer "CogniumLearn" prefix no longer leaves room for "ServerFW"/"DatabaseFW".
    SERVER_FIREWALL_ID="$(linode_ensure_firewall "$(label_for_role SrvFW)" "$(node "$FIREWALL_RULES_SCRIPT" "$server_role" "$ENVIRONMENT_SUBNET_CIDR" "$ADMIN_SSH_CIDR")" "$ENVIRONMENT_TAG")"
    BURST_FIREWALL_ID="$(linode_ensure_firewall "$(label_for_role BurstFW)" "$(node "$FIREWALL_RULES_SCRIPT" burst "$ENVIRONMENT_SUBNET_CIDR" "$ADMIN_SSH_CIDR")" "$ENVIRONMENT_TAG")"
    log_info "Server firewall id=$SERVER_FIREWALL_ID  Burst firewall id=$BURST_FIREWALL_ID"

    DATABASE_FIREWALL_ID=""
    if [ "$ENVIRONMENT_MONGO_TOPOLOGY" = "separate" ]
    then
        DATABASE_FIREWALL_ID="$(linode_ensure_firewall "$(label_for_role DbFW)" "$(node "$FIREWALL_RULES_SCRIPT" database "$ENVIRONMENT_SUBNET_CIDR" "$ADMIN_SSH_CIDR")" "$ENVIRONMENT_TAG")"
        log_info "Database firewall id=$DATABASE_FIREWALL_ID"
    fi

    # Root password for the created VMs: use LINODE_ROOT_PASSWORD from deployment.env
    # (shared) so it is known + consistent; fall back to a random throwaway if unset
    # (SSH-key access works either way).
    local root_password authorized_key
    root_password="${LINODE_ROOT_PASSWORD:-}"
    [ -n "$root_password" ] || root_password="$(node -e "console.log(require('crypto').randomBytes(24).toString('base64') + 'Aa1!')")"
    authorized_key="$(cat "$DEPLOY_SSH_PUBLIC_KEY_PATH" 2>/dev/null || true)"

    log_step "Ensuring the base node instance ($(label_for_role Server))..."
    local base_body
    base_body="$(node -e '
        const [region, type, subnetId, privateIp, firewallId, tag, key, rootPass] = process.argv.slice(1);
        process.stdout.write(JSON.stringify({
            region, type, image: "linode/debian12", booted: true,
            root_pass: rootPass, authorized_keys: key ? [key.trim()] : [], tags: [tag],
            firewall_id: firewallId === "DRYRUN-FW" ? undefined : Number(firewallId),
            interfaces: [
                { purpose: "public" },
                { purpose: "vpc", subnet_id: subnetId === "DRYRUN-SUBNET" ? 0 : Number(subnetId), ipv4: { vpc: privateIp } }
            ]
        }));
    ' "$ENVIRONMENT_REGION" "$ENVIRONMENT_SERVER_TYPE" "$SUBNET_ID" "$ENVIRONMENT_BASE_NODE_PRIVATE_IP" "$SERVER_FIREWALL_ID" "$ENVIRONMENT_TAG" "$authorized_key" "$root_password")"
    BASE_NODE_ID="$(linode_ensure_instance "$(label_for_role Server)" "$base_body")"
    log_info "Base node id=$BASE_NODE_ID"

    MONGO_NODE_ID=""
    if [ "$ENVIRONMENT_MONGO_TOPOLOGY" = "separate" ]
    then
        log_step "Ensuring the Mongo node instance ($(label_for_role MongoDB))..."
        local mongo_body
        mongo_body="$(node -e '
            const [region, type, subnetId, privateIp, firewallId, tag, key, rootPass] = process.argv.slice(1);
            process.stdout.write(JSON.stringify({
                region, type, image: "linode/debian12", booted: true,
                root_pass: rootPass, authorized_keys: key ? [key.trim()] : [], tags: [tag],
                firewall_id: firewallId === "DRYRUN-FW" ? undefined : Number(firewallId),
                interfaces: [
                    { purpose: "public" },
                    { purpose: "vpc", subnet_id: subnetId === "DRYRUN-SUBNET" ? 0 : Number(subnetId), ipv4: { vpc: privateIp } }
                ]
            }));
        ' "$ENVIRONMENT_REGION" "$ENVIRONMENT_MONGO_TYPE" "$SUBNET_ID" "$ENVIRONMENT_MONGO_PRIVATE_IP" "$DATABASE_FIREWALL_ID" "$ENVIRONMENT_TAG" "$authorized_key" "$root_password")"
        MONGO_NODE_ID="$(linode_ensure_instance "$(label_for_role MongoDB)" "$mongo_body")"
        log_info "Mongo node id=$MONGO_NODE_ID"
    fi
}

# ── 3. Compute connection strings + write them into the env files ─────────────
write_connection_configuration()
{
    log_step "Writing resolved ids + connection strings into the env files..."
    # Same DB name + same user across every environment; the password lives only in the
    # app env files (inside MONGODB_URL). Reuse an existing one so re-runs don't rotate it.
    local database_name="cogniumlearn"
    MONGO_USERNAME="cogniumlearn"
    MONGO_PASSWORD="$(extract_mongo_password "$(read_env_value "$DOCK_ENVIRONMENT_FILE" MONGODB_URL)")"
    if value_is_missing "$MONGO_PASSWORD"
    then
        MONGO_PASSWORD="$(generate_password)"
    fi

    local mongo_host mongo_private_host
    if [ "$ENVIRONMENT_MONGO_TOPOLOGY" = "colocated" ]
    then
        mongo_host="127.0.0.1"
        mongo_private_host="$ENVIRONMENT_BASE_NODE_PRIVATE_IP"
    else
        mongo_host="$ENVIRONMENT_MONGO_PRIVATE_IP"
        mongo_private_host="$ENVIRONMENT_MONGO_PRIVATE_IP"
    fi

    local mongo_url="mongodb://${MONGO_USERNAME}:${MONGO_PASSWORD}@${mongo_host}:27017/${database_name}?authSource=admin&directConnection=true"
    local mongo_url_vpc="mongodb://${MONGO_USERNAME}:${MONGO_PASSWORD}@${mongo_private_host}:27017/${database_name}?authSource=admin&directConnection=true"

    # Dock (the server): talks to its data tier locally; forwards VPC URLs to burst workers.
    write_env_value "$DOCK_ENVIRONMENT_FILE" DOMAIN_NAME "$ENVIRONMENT_DOMAIN"
    write_env_value "$DOCK_ENVIRONMENT_FILE" MONGODB_URL "$mongo_url"
    write_env_value "$DOCK_ENVIRONMENT_FILE" MONGODB_DATABASE_NAME "$database_name"
    write_env_value "$DOCK_ENVIRONMENT_FILE" REDIS_URL "redis://127.0.0.1:6379"
    write_env_value "$DOCK_ENVIRONMENT_FILE" AGENT_SERVICE_PATH "${BASE_NODE_REPO_DIR}/Agent"
    write_env_value "$DOCK_ENVIRONMENT_FILE" DOCK_USE_TASK_QUEUE "1"
    write_env_value "$DOCK_ENVIRONMENT_FILE" AGENT_LOCAL_WORKER_COUNT "${ENVIRONMENT_AGENT_LOCAL_WORKER_COUNT:-1}"
    write_env_value "$DOCK_ENVIRONMENT_FILE" DEFAULT_CLOUD_COMPUTE_PROVIDER "LINODE"
    write_env_value "$DOCK_ENVIRONMENT_FILE" LINODE_API_TOKEN "$LINODE_API_TOKEN"
    write_env_value "$DOCK_ENVIRONMENT_FILE" BURST_REGION "$ENVIRONMENT_REGION"
    write_env_value "$DOCK_ENVIRONMENT_FILE" BURST_INSTANCE_TYPE "$ENVIRONMENT_BURST_INSTANCE_TYPE"
    write_env_value "$DOCK_ENVIRONMENT_FILE" BURST_VPC_ID "$VPC_ID"
    write_env_value "$DOCK_ENVIRONMENT_FILE" BURST_SUBNET_ID "$SUBNET_ID"
    write_env_value "$DOCK_ENVIRONMENT_FILE" BURST_FIREWALL_ID "$BURST_FIREWALL_ID"
    write_env_value "$DOCK_ENVIRONMENT_FILE" BURST_WORKER_REDIS_URL "redis://${ENVIRONMENT_BASE_NODE_PRIVATE_IP}:6379"
    write_env_value "$DOCK_ENVIRONMENT_FILE" BURST_WORKER_MONGODB_URL "$mongo_url_vpc"
    write_env_value "$DOCK_ENVIRONMENT_FILE" BURST_WARM_POOL_SIZE "0"
    write_env_value "$DOCK_ENVIRONMENT_FILE" BURST_MAX_INSTANCES "3"
    # Per-environment burst identity is CRITICAL for isolation: the autoscaler deletes
    # every instance carrying its BURST_MANAGEMENT_TAG on startup, so each environment
    # MUST use a distinct tag/prefix or one env's restart would wipe another's fleet.
    write_env_value "$DOCK_ENVIRONMENT_FILE" BURST_MANAGEMENT_TAG "cogniumlearn-${ENVIRONMENT_NAME}-worker"
    write_env_value "$DOCK_ENVIRONMENT_FILE" BURST_LABEL_PREFIX "cogniumlearn-${ENVIRONMENT_NAME}-worker-"

    # Agent (local workers + the template burst workers inherit): its own data tier + LLM keys.
    write_env_value "$AGENT_ENVIRONMENT_FILE" MONGODB_URL "$mongo_url"
    write_env_value "$AGENT_ENVIRONMENT_FILE" MONGODB_DATABASE_NAME "$database_name"
    write_env_value "$AGENT_ENVIRONMENT_FILE" REDIS_URL "redis://127.0.0.1:6379"

    log_info "Connection strings written (Mongo user: $MONGO_USERNAME, topology: $ENVIRONMENT_MONGO_TOPOLOGY)."
}

# ── SSH helpers to freshly-created nodes ──────────────────────────────────────
wait_for_ssh()
{
    local target="$1" elapsed=0
    while [ "$elapsed" -lt 300 ]
    do
        ssh "${SSH_COMMON_OPTIONS[@]}" "$target" true 2>/dev/null && return 0
        sleep 5; elapsed=$((elapsed + 5))
    done
    log_error "SSH to $target not ready within 300s."; return 1
}

# Stream an install script to a node over SSH, retrying if the link drops mid-run.
# The remote scripts are idempotent, so a retry safely resumes. Usage:
#   ssh_install_with_retry <target> <env-prefix-string> <local-script-path>
ssh_install_with_retry()
{
    local target="$1" environment_prefix="$2" script_path="$3" attempt=0
    until ssh "${SSH_COMMON_OPTIONS[@]}" "$target" "$environment_prefix bash -s" < "$script_path"
    do
        attempt=$((attempt + 1))
        if [ "$attempt" -ge 3 ]
        then
            log_error "Remote install on $target failed after $attempt attempts."
            return 1
        fi
        log_warning "Remote install on $target dropped (attempt $attempt); reconnecting + resuming in 20s..."
        wait_for_ssh "$target" || true
        sleep 20
    done
}

# ── 4. Install OS + data tier on the node(s) ──────────────────────────────────
provision_nodes()
{
    log_step "Waiting for the base node to boot + become reachable..."
    linode_wait_for_status "$BASE_NODE_ID" "running" 300
    BASE_NODE_PUBLIC_IP="$(linode_get_public_ipv4 "$BASE_NODE_ID")"
    log_info "Base node public IP: $BASE_NODE_PUBLIC_IP"
    write_deployment_value BASE_NODE_SSH_HOST "$BASE_NODE_PUBLIC_IP"
    BASE_NODE_SSH_HOST="$BASE_NODE_PUBLIC_IP"
    wait_for_ssh "root@${BASE_NODE_PUBLIC_IP}"

    # Separate Mongo node first (so the base node's Dock can reach it on boot).
    if [ "$ENVIRONMENT_MONGO_TOPOLOGY" = "separate" ]
    then
        log_step "Provisioning the Mongo node..."
        linode_wait_for_status "$MONGO_NODE_ID" "running" 300
        local mongo_public_ip
        mongo_public_ip="$(linode_get_public_ipv4 "$MONGO_NODE_ID")"
        wait_for_ssh "root@${mongo_public_ip}"
        ssh_install_with_retry "root@${mongo_public_ip}" \
            "MONGO_BIND_IP='$ENVIRONMENT_MONGO_PRIVATE_IP' MONGO_ROOT_USER='$MONGO_USERNAME' MONGO_ROOT_PASSWORD='$MONGO_PASSWORD'" \
            "$SCRIPT_DIRECTORY/Remote/ProvisionMongoNode.sh"
    fi

    log_step "Uploading code contexts + env files to the base node..."
    local agent_archive dock_archive
    agent_archive="$(mktemp -t cogniumlearn-agent-context.XXXXXX.tar.gz)"
    dock_archive="$(mktemp -t cogniumlearn-dock-context.XXXXXX.tar.gz)"
    (
        cd "$REPOSITORY_ROOT"
        tar --exclude='.venv' --exclude='__pycache__' --exclude='*.pyc' --exclude='*.env' --exclude='Tasks' -czf "$agent_archive" Agent
        tar --exclude='Dock/.env' --exclude='Dock/.*.env' --exclude='Dock/logs' --exclude='Dock/Tasks' -czf "$dock_archive" Dock
    )
    scp "${SSH_COMMON_OPTIONS[@]}" "$agent_archive" "root@${BASE_NODE_PUBLIC_IP}:/tmp/agent-context.tar.gz"
    scp "${SSH_COMMON_OPTIONS[@]}" "$dock_archive" "root@${BASE_NODE_PUBLIC_IP}:/tmp/dock-context.tar.gz"
    rm -f "$agent_archive" "$dock_archive"

    log_step "Installing the OS + data tier on the base node (Redis, Mongo?, Node, venv, npm)..."
    local mongo_user="$MONGO_USERNAME"
    ssh_install_with_retry "root@${BASE_NODE_PUBLIC_IP}" \
        "REPO_DIR='$BASE_NODE_REPO_DIR' COGNIUMLEARN_ENVIRONMENT='$ENVIRONMENT_NAME' MONGO_TOPOLOGY='$ENVIRONMENT_MONGO_TOPOLOGY' BASE_PRIVATE_IP='$ENVIRONMENT_BASE_NODE_PRIVATE_IP' AGENT_CONTEXT_ARCHIVE='/tmp/agent-context.tar.gz' DOCK_CONTEXT_ARCHIVE='/tmp/dock-context.tar.gz' MONGO_ROOT_USER='$mongo_user' MONGO_ROOT_PASSWORD='$MONGO_PASSWORD'" \
        "$SCRIPT_DIRECTORY/Remote/ProvisionBaseNode.sh"

    log_step "Placing the env files on the base node..."
    scp "${SSH_COMMON_OPTIONS[@]}" "$DOCK_ENVIRONMENT_FILE" "root@${BASE_NODE_PUBLIC_IP}:${BASE_NODE_REPO_DIR}/Dock/$(dock_environment_file_name)"
    scp "${SSH_COMMON_OPTIONS[@]}" "$AGENT_ENVIRONMENT_FILE" "root@${BASE_NODE_PUBLIC_IP}:${BASE_NODE_REPO_DIR}/Agent/$(agent_environment_file_name)"
}

print_summary()
{
    echo
    log_success "════════════════════════════════════════════════════════════"
    log_success " Provision of '$ENVIRONMENT_NAME' complete."
    log_success "   Domain:   https://${ENVIRONMENT_DOMAIN}"
    log_success "   VPC:      $VPC_ID (subnet $SUBNET_ID, ${ENVIRONMENT_SUBNET_CIDR})"
    log_success "   Base node: ${BASE_NODE_ID:-?}  ${BASE_NODE_PUBLIC_IP:+($BASE_NODE_PUBLIC_IP)}"
    [ "$ENVIRONMENT_MONGO_TOPOLOGY" = "separate" ] && log_success "   Mongo node: ${MONGO_NODE_ID:-?}"
    log_success "════════════════════════════════════════════════════════════"
    log_info "Confirm the Cloudflare tunnel routes ${ENVIRONMENT_DOMAIN} -> http://127.0.0.1:3000 and the DNS record exists."
    log_info "Confirm the Google OAuth client lists https://${ENVIRONMENT_DOMAIN}/Login/Callback as a redirect URI."
}

# ── Main ──────────────────────────────────────────────────────────────────────
scaffold_environment_files
ensure_infrastructure

if [ "$DRY_RUN" -eq 1 ]
then
    echo
    log_success "Dry run complete for '$ENVIRONMENT_NAME'. Planned resources:"
    log_info "  VPC=$(label_for_role VPC)  Firewalls=$(label_for_role SrvFW),$(label_for_role BurstFW)$([ "$ENVIRONMENT_MONGO_TOPOLOGY" = separate ] && echo ",$(label_for_role DbFW)")"
    log_info "  Base=$(label_for_role Server) ($ENVIRONMENT_SERVER_TYPE)$([ "$ENVIRONMENT_MONGO_TOPOLOGY" = separate ] && echo "  Mongo=$(label_for_role MongoDB) ($ENVIRONMENT_MONGO_TYPE)")"
    log_info "  Burst image series: $(label_for_role BurstImage)<version>"
    exit 0
fi

write_connection_configuration
provision_nodes

if [ "$SKIP_DEPLOY" -eq 1 ]
then
    log_warning "Skipping the deploy step (--skip-deploy). Run 'deploy-environment.sh $ENVIRONMENT_NAME' to bake the image + start Dock."
else
    log_step "Handing off to deploy-environment.sh to bake the burst image + start Dock..."
    bash "$SCRIPT_DIRECTORY/deploy-environment.sh" "$ENVIRONMENT_NAME"
fi

print_summary
