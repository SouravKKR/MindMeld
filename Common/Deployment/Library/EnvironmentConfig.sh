#!/usr/bin/env bash
#
# Shared environment-registry loader for the CogniumLearn deployment orchestrators
# (provision / deploy / teardown / status / rename). Sourced after Logging.sh.
#
# Reads the non-secret desired shape of every environment from
# Common/Deployment/Environments.json and exposes it as ENVIRONMENT_* globals plus
# the label-naming helpers every orchestrator shares, so the naming convention
# (CogniumLearn-<Env>-<Role>) lives in exactly one place.

# This file lives at <repo>/Common/Deployment/Library/EnvironmentConfig.sh, so the
# repo root is three directories up (Library -> Deployment -> Common -> repo root).
ENVIRONMENT_CONFIG_LIBRARY_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOYMENT_DIRECTORY="$(cd "$ENVIRONMENT_CONFIG_LIBRARY_DIRECTORY/.." && pwd)"
REPOSITORY_ROOT="$(cd "$DEPLOYMENT_DIRECTORY/../.." && pwd)"
ENVIRONMENTS_JSON_PATH="$DEPLOYMENT_DIRECTORY/Environments.json"
ENVIRONMENT_JSON_QUERY_SCRIPT="$ENVIRONMENT_CONFIG_LIBRARY_DIRECTORY/JsonQuery.js"

# Print a dotted field from Environments.json (blank if missing).
environment_registry_field()
{
    local dotted_path="$1"
    node "$ENVIRONMENT_JSON_QUERY_SCRIPT" field "$dotted_path" < "$ENVIRONMENTS_JSON_PATH"
}

# Reject anything that is not one of the four known environments.
validate_environment_name()
{
    local candidate="$1"
    case "$candidate" in
        local|development|testing|production) return 0 ;;
        *)
            log_error "Unknown environment '$candidate'. Expected one of: local, development, testing, production."
            return 1
            ;;
    esac
}

# Populate ENVIRONMENT_* globals for the requested environment. Aborts (via the
# caller's set -e) if the environment is unknown or absent from the registry.
load_environment_config()
{
    ENVIRONMENT_NAME="$1"
    validate_environment_name "$ENVIRONMENT_NAME" || return 1

    ENVIRONMENT_PROVISIONING="$(environment_registry_field "${ENVIRONMENT_NAME}.provisioning")"
    ENVIRONMENT_DOMAIN="$(environment_registry_field "${ENVIRONMENT_NAME}.domain")"
    ENVIRONMENT_REGION="$(environment_registry_field "${ENVIRONMENT_NAME}.region")"
    ENVIRONMENT_VPC_CIDR="$(environment_registry_field "${ENVIRONMENT_NAME}.vpcCidr")"
    ENVIRONMENT_SUBNET_CIDR="$(environment_registry_field "${ENVIRONMENT_NAME}.subnetCidr")"
    ENVIRONMENT_BASE_NODE_PRIVATE_IP="$(environment_registry_field "${ENVIRONMENT_NAME}.baseNodePrivateIp")"
    ENVIRONMENT_MONGO_PRIVATE_IP="$(environment_registry_field "${ENVIRONMENT_NAME}.mongoPrivateIp")"
    ENVIRONMENT_MONGO_TOPOLOGY="$(environment_registry_field "${ENVIRONMENT_NAME}.mongoTopology")"
    ENVIRONMENT_SERVER_TYPE="$(environment_registry_field "${ENVIRONMENT_NAME}.serverType")"
    ENVIRONMENT_MONGO_TYPE="$(environment_registry_field "${ENVIRONMENT_NAME}.mongoType")"
    ENVIRONMENT_BURST_INSTANCE_TYPE="$(environment_registry_field "${ENVIRONMENT_NAME}.burstInstanceType")"
    ENVIRONMENT_LABEL_PREFIX="$(environment_registry_field "${ENVIRONMENT_NAME}.labelPrefix")"
    ENVIRONMENT_TAG="$(environment_registry_field "${ENVIRONMENT_NAME}.tag")"
    ENVIRONMENT_AGENT_LOCAL_WORKER_COUNT="$(environment_registry_field "${ENVIRONMENT_NAME}.agentLocalWorkerCount")"

    if [ "$ENVIRONMENT_NAME" != "local" ] && [ -z "$ENVIRONMENT_LABEL_PREFIX" ]
    then
        log_error "Environment '$ENVIRONMENT_NAME' is missing from $ENVIRONMENTS_JSON_PATH."
        return 1
    fi
}

# The CogniumLearn-<Env>-<Role> label for a given role (Server, MongoDB, VPC, Subnet,
# ServerFirewall, DatabaseFirewall, BurstFirewall, BurstImage).
label_for_role()
{
    printf '%s-%s' "$ENVIRONMENT_LABEL_PREFIX" "$1"
}

# If <base>_<SUFFIX> is set and non-empty, copy it into the generic <base> variable
# (so a scoped value wins; otherwise any shared unsuffixed value is left in place).
resolve_environment_scoped_variable()
{
    local base_name="$1" suffix="$2"
    local scoped_name="${base_name}_${suffix}"
    local scoped_value="${!scoped_name:-}"
    if [ -n "$scoped_value" ]
    then
        printf -v "$base_name" '%s' "$scoped_value"
        export "${base_name?}"
    fi
}

# Load deployment secrets from the SINGLE shared deployment.env. Shared values
# (LINODE_API_TOKEN, SSH keys, bakebox settings) are unsuffixed; per-environment
# values are keyed by an uppercase suffix (CLOUDFLARE_TUNNEL_TOKEN_DEVELOPMENT,
# BASE_NODE_SSH_HOST_TESTING, ...). This resolves the scoped keys for the requested
# environment into the generic names the orchestrators use.
load_deployment_secrets()
{
    local target_environment="$1"
    local shared_file="$REPOSITORY_ROOT/deployment.env"

    set -a
    # shellcheck disable=SC1090
    [ -f "$shared_file" ] && source "$shared_file"
    set +a

    local suffix
    suffix="$(printf '%s' "$target_environment" | tr '[:lower:]' '[:upper:]')"
    # Mongo credentials are intentionally NOT here — they live in the app env files
    # (Dock/.<env>.env + Agent/.<env>.env, inside MONGODB_URL).
    local scoped_variable
    for scoped_variable in CLOUDFLARE_TUNNEL_TOKEN BASE_NODE_SSH_HOST BASE_NODE_SSH_USER \
                           BASE_NODE_REPO_DIR BAKEBOX_REGION BASE_NODE_UPDATE_BURST_IMAGE_ID ADMIN_SSH_CIDR
    do
        resolve_environment_scoped_variable "$scoped_variable" "$suffix"
    done

    if [ -z "${LINODE_API_TOKEN:-}" ]
    then
        log_error "LINODE_API_TOKEN not set. Add it to deployment.env."
        return 1
    fi
    export LINODE_API_TOKEN
}

# The per-environment Dock / Agent env files (gitignored) that ship to the node.
dock_environment_file_name()
{
    printf '.%s.env' "$ENVIRONMENT_NAME"
}

agent_environment_file_name()
{
    printf '.%s.env' "$ENVIRONMENT_NAME"
}
