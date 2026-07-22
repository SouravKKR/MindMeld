#!/usr/bin/env bash
#
# Idempotently tear down every cloud resource of a CogniumLearn environment. Resources
# are found by the CogniumLearn-<Env>-* label prefix (and the VPC by its exact label),
# then deleted in dependency order: instances first (which frees their VPC + firewall
# attachments), then burst images, then firewalls, then the VPC.
#
# SAFETY:
#   * Production is refused unless --force-production is given.
#   * The plan is always printed first. Nothing is deleted unless --yes is passed
#     (so a bare run is effectively a dry run you can read before committing).
#
# Usage:
#   bash Common/Deployment/teardown-environment.sh development            # print plan only
#   bash Common/Deployment/teardown-environment.sh development --yes      # actually delete
#   bash Common/Deployment/teardown-environment.sh production --force-production --yes
set -euo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIRECTORY/Library/Logging.sh"
source "$SCRIPT_DIRECTORY/Library/LinodeApi.sh"
source "$SCRIPT_DIRECTORY/Library/EnvironmentConfig.sh"

ENVIRONMENT_NAME_ARGUMENT=""
CONFIRM_DELETE=0
FORCE_PRODUCTION=0
for argument in "$@"
do
    case "$argument" in
        --yes) CONFIRM_DELETE=1 ;;
        --force-production) FORCE_PRODUCTION=1 ;;
        -*) log_error "Unknown flag: $argument"; exit 1 ;;
        *) ENVIRONMENT_NAME_ARGUMENT="$argument" ;;
    esac
done
[ -n "$ENVIRONMENT_NAME_ARGUMENT" ] || { log_error "Usage: teardown-environment.sh <development|testing|production> [--yes] [--force-production]"; exit 1; }

load_environment_config "$ENVIRONMENT_NAME_ARGUMENT"
load_deployment_secrets "$ENVIRONMENT_NAME_ARGUMENT"

if [ "$ENVIRONMENT_NAME" = "local" ]
then
    log_error "The 'local' environment has no cloud resources to tear down."
    exit 1
fi

if [ "$ENVIRONMENT_NAME" = "production" ] && [ "$FORCE_PRODUCTION" -ne 1 ]
then
    log_error "Refusing to tear down PRODUCTION without --force-production. This deletes the live site."
    exit 1
fi

log_step "Discovering '$ENVIRONMENT_NAME' resources (prefix: ${ENVIRONMENT_LABEL_PREFIX}-)..."
INSTANCE_IDS="$(linode_find_instance_ids_by_prefix "${ENVIRONMENT_LABEL_PREFIX}-")"
IMAGE_IDS="$(linode_find_image_ids_by_prefix "$(label_for_role BurstImage)")"
FIREWALL_IDS="$(linode_find_firewall_ids_by_prefix "${ENVIRONMENT_LABEL_PREFIX}-")"
VPC_IDENTIFIER="$(linode_find_vpc_id_by_label "$(label_for_role VPC)")"

echo
log_info "Planned deletions for '$ENVIRONMENT_NAME':"
printf '    Instances: %s\n' "$(printf '%s' "$INSTANCE_IDS" | tr '\n' ' ')"
printf '    Images:    %s\n' "$(printf '%s' "$IMAGE_IDS" | tr '\n' ' ')"
printf '    Firewalls: %s\n' "$(printf '%s' "$FIREWALL_IDS" | tr '\n' ' ')"
printf '    VPC:       %s\n' "${VPC_IDENTIFIER:-none}"

if [ "$CONFIRM_DELETE" -ne 1 ]
then
    echo
    log_warning "Plan only. Re-run with --yes to actually delete these resources."
    exit 0
fi

delete_each()
{
    local id_list="$1"
    local delete_function="$2"
    while IFS= read -r resource_id
    do
        [ -n "$resource_id" ] || continue
        log_info "Deleting via ${delete_function}: ${resource_id}"
        "$delete_function" "$resource_id"
    done <<< "$id_list"
}

echo
log_step "Deleting instances..."
delete_each "$INSTANCE_IDS" linode_delete_instance

# Also sweep any live burst worker VMs the autoscaler may have left running.
log_step "Sweeping stray burst worker VMs for this environment..."
BURST_WORKER_IDS="$(linode_find_instance_ids_by_prefix "cogniumlearn-${ENVIRONMENT_NAME}-worker")"
delete_each "$BURST_WORKER_IDS" linode_delete_instance

log_step "Deleting burst images..."
delete_each "$IMAGE_IDS" linode_delete_image

# Instances take a few seconds to fully detach from their firewalls + VPC.
log_info "Waiting 20s for instance detachment before deleting firewalls + VPC..."
sleep 20

log_step "Deleting firewalls..."
delete_each "$FIREWALL_IDS" linode_delete_firewall

if [ -n "$VPC_IDENTIFIER" ]
then
    log_step "Deleting VPC ${VPC_IDENTIFIER}..."
    linode_delete_vpc "$VPC_IDENTIFIER"
fi

echo
log_success "Environment '$ENVIRONMENT_NAME' torn down."
