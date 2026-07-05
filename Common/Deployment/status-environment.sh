#!/usr/bin/env bash
#
# Read-only status of a MindMeld environment: which cloud resources exist (matched
# by the MindMeld-<Env>-* label prefix) and, if the base node is reachable over
# SSH, the state of its services. Makes no changes.
#
# Usage:  bash Common/Deployment/status-environment.sh <development|testing|production>
set -euo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIRECTORY/Library/Logging.sh"
source "$SCRIPT_DIRECTORY/Library/LinodeApi.sh"
source "$SCRIPT_DIRECTORY/Library/EnvironmentConfig.sh"

ENVIRONMENT_NAME_ARGUMENT="${1:-}"
[ -n "$ENVIRONMENT_NAME_ARGUMENT" ] || { log_error "Usage: status-environment.sh <development|testing|production>"; exit 1; }

load_environment_config "$ENVIRONMENT_NAME_ARGUMENT"
load_deployment_secrets "$ENVIRONMENT_NAME_ARGUMENT"

if [ "$ENVIRONMENT_NAME" = "local" ]
then
    log_info "The 'local' environment has no cloud resources (runs via npm on 127.0.0.1:3000)."
    exit 0
fi

log_step "Cloud resources for '$ENVIRONMENT_NAME' (prefix: ${ENVIRONMENT_LABEL_PREFIX}-, domain: ${ENVIRONMENT_DOMAIN})"

echo
log_info "Instances:"
linode_find_instance_rows_by_prefix "${ENVIRONMENT_LABEL_PREFIX}-" | sed 's/^/    /' || true

echo
log_info "Firewalls:"
linode_request GET "/networking/firewalls?page_size=500" | json_query rowsByLabelPrefix "${ENVIRONMENT_LABEL_PREFIX}-" | sed 's/^/    /' || true

echo
log_info "VPC:"
VPC_IDENTIFIER="$(linode_find_vpc_id_by_label "$(label_for_role VPC)")"
if [ -n "$VPC_IDENTIFIER" ]
then
    printf '    id=%s label=%s\n' "$VPC_IDENTIFIER" "$(label_for_role VPC)"
else
    printf '    (none)\n'
fi

echo
log_info "Burst images:"
linode_request GET "/images?page_size=500" | json_query rowsByLabelPrefix "$(label_for_role BurstImage)" | sed 's/^/    /' || true

# Best-effort remote service check (only if the base node host + SSH key are configured).
if [ -n "${BASE_NODE_SSH_HOST:-}" ] && [ -n "${DEPLOY_SSH_PRIVATE_KEY_PATH:-}" ]
then
    echo
    log_info "Base node services (${BASE_NODE_SSH_USER:-root}@${BASE_NODE_SSH_HOST}):"
    ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 \
        -i "${DEPLOY_SSH_PRIVATE_KEY_PATH/#\~/$HOME}" "${BASE_NODE_SSH_USER:-root}@${BASE_NODE_SSH_HOST}" \
        'systemctl is-active mindmeld-dock cloudflared redis-server 2>/dev/null | paste -sd" " -' \
        2>/dev/null | sed 's/^/    dock cloudflared redis: /' || log_warning "    (base node not reachable)"
fi

echo
log_success "Status complete."
