#!/usr/bin/env bash
#
# One-shot, idempotent migration of every provisioned environment's Linode resources
# from the old MindMeld-<Env>-<Role> naming convention to the CogniumLearn-<Env>-<Role>
# convention (Deployment.md), following the MindMeld -> CogniumLearn product rebrand.
# Instances are matched and renamed by exact label; firewalls, images, and the VPC +
# its subnet are matched by label PREFIX so newly-baked burst images (whose version
# suffix changes over time) are picked up without hand-editing this script.
#
# Every change here is METADATA ONLY — a label rename (PUT label) and a tag merge.
# Nothing is recreated, no IP changes, no service restart: every reference elsewhere
# is by numeric id, not label, so the environments keep serving throughout. Safe to
# re-run: once an entity is renamed its old label is no longer found and it is skipped.
#
# Usage (from the repo root, Git Bash):
#   bash Common/Deployment/rename-production-entities.sh --dry-run   # print the plan
#   bash Common/Deployment/rename-production-entities.sh             # apply it
#
# Runs against every "linode"-provisioned environment in Environments.json (currently
# development, testing, production). It leaves the unrelated `InternalTools` and
# `HiveCentral` Linodes and the `AcceptSshOnly` firewall alone.
set -euo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIRECTORY/Library/Logging.sh"
source "$SCRIPT_DIRECTORY/Library/LinodeApi.sh"
source "$SCRIPT_DIRECTORY/Library/EnvironmentConfig.sh"

if [ "${1:-}" = "--dry-run" ]
then
    LINODE_DRY_RUN=1
    log_warning "DRY RUN — no changes will be made."
fi

# Rename an instance found by its legacy label to the new label and tag it.
rename_instance()
{
    local legacy_label="$1"
    local new_label="$2"
    local entity_id

    entity_id="$(linode_find_instance_id_by_label "$legacy_label")"
    if [ -n "$entity_id" ]
    then
        log_step "Instance '$legacy_label' -> '$new_label' (id=$entity_id)"
        linode_rename_entity "linode/instances" "$entity_id" "$new_label"
    else
        entity_id="$(linode_find_instance_id_by_label "$new_label")"
        if [ -n "$entity_id" ]
        then
            log_info "Instance already named '$new_label' (id=$entity_id) — skipping rename."
        else
            log_warning "No instance named '$legacy_label' or '$new_label' — skipping."
            return 0
        fi
    fi
    linode_add_tag "linode/instances" "$entity_id" "$ENVIRONMENT_TAG"
}

# Rename a firewall found by its exact legacy label to the new label and tag it.
# Firewall labels are capped at 32 chars by Linode, and the longer "CogniumLearn"
# prefix no longer leaves room for the old "ServerFW"/"DatabaseFW" role names, so
# unlike the other renames below this is an explicit label lookup (old role name ->
# new short role name), not a prefix-preserving substitution. Missing roles (e.g. no
# DbFW in a colocated-Mongo environment) are skipped, same as rename_instance.
rename_firewall()
{
    local legacy_label="$1"
    local new_label="$2"
    local entity_id

    entity_id="$(linode_find_firewall_id_by_label "$legacy_label")"
    if [ -n "$entity_id" ]
    then
        log_step "Firewall '$legacy_label' -> '$new_label' (id=$entity_id)"
        linode_rename_entity "networking/firewalls" "$entity_id" "$new_label"
    else
        entity_id="$(linode_find_firewall_id_by_label "$new_label")"
        if [ -n "$entity_id" ]
        then
            log_info "Firewall already named '$new_label' (id=$entity_id) — skipping rename."
        else
            log_warning "No firewall named '$legacy_label' or '$new_label' — skipping."
            return 0
        fi
    fi
    linode_add_tag "networking/firewalls" "$entity_id" "$ENVIRONMENT_TAG"
}

# Rename every entity in the given collection whose label starts with legacy_prefix,
# preserving the role suffix after the prefix (e.g. "...-BurstImage11" survives a
# version bump untouched). collection is the API path segment ("images" here — image
# role names are unaffected by the 32-char firewall cap); list_path is the GET path
# used to enumerate entities.
rename_by_prefix()
{
    local collection="$1"
    local list_path="$2"
    local legacy_prefix="$3"
    local new_prefix="$4"
    local row entity_id entity_label role_suffix new_label

    while IFS='|' read -r entity_id entity_label || [ -n "$entity_id" ]
    do
        [ -n "$entity_id" ] || continue
        role_suffix="${entity_label#"$legacy_prefix"}"
        new_label="${new_prefix}${role_suffix}"
        log_step "${collection} '$entity_label' -> '$new_label' (id=$entity_id)"
        linode_rename_entity "$collection" "$entity_id" "$new_label"
        linode_add_tag "$collection" "$entity_id" "$ENVIRONMENT_TAG"
    done < <(linode_request GET "$list_path" | json_query rowsByLabelPrefix "$legacy_prefix")
}

# The VPC is matched by label; its single subnet is renamed too. VPCs do not carry
# tags in the Linode API, so we rely on the label for identification.
rename_vpc_and_subnet()
{
    local legacy_prefix="$1"
    local new_prefix="$2"
    local legacy_label="${legacy_prefix}-VPC"
    local new_label="${new_prefix}-VPC"
    local legacy_subnet_label="${legacy_prefix}-Subnet"
    local new_subnet_label="${new_prefix}-Subnet"

    local vpc_id
    vpc_id="$(linode_find_vpc_id_by_label "$legacy_label")"
    if [ -n "$vpc_id" ]
    then
        log_step "VPC '$legacy_label' -> '$new_label' (id=$vpc_id)"
        linode_rename_entity "vpcs" "$vpc_id" "$new_label"
    else
        vpc_id="$(linode_find_vpc_id_by_label "$new_label")"
        if [ -n "$vpc_id" ]
        then
            log_info "VPC already named '$new_label' (id=$vpc_id)."
        else
            log_warning "No VPC named '$legacy_label' or '$new_label' — skipping."
            return 0
        fi
    fi

    local vpc_document subnet_id
    vpc_document="$(linode_request GET "/vpcs/${vpc_id}")"
    subnet_id="$(printf '%s' "$vpc_document" | json_query field subnets.0.id)"
    if [ -n "$subnet_id" ]
    then
        log_step "Subnet '$legacy_subnet_label' -> '$new_subnet_label' (id=$subnet_id)"
        if linode_is_dry_run
        then
            log_info "[dry-run] Would rename subnet ${subnet_id} -> '$new_subnet_label'."
        else
            linode_request PUT "/vpcs/${vpc_id}/subnets/${subnet_id}" "{\"label\": \"${new_subnet_label}\"}" >/dev/null
        fi
    fi
}

migrate_environment()
{
    local environment_name="$1"

    load_environment_config "$environment_name"
    load_deployment_secrets "$environment_name"

    local new_prefix="$ENVIRONMENT_LABEL_PREFIX"
    local legacy_prefix="MindMeld-${new_prefix#CogniumLearn-}"

    log_step "Migrating '$environment_name' resources ($legacy_prefix-* -> $new_prefix-*)..."

    rename_instance "${legacy_prefix}-Server"     "${new_prefix}-Server"
    rename_instance "${legacy_prefix}-MongoDB"    "${new_prefix}-MongoDB"
    rename_firewall "${legacy_prefix}-ServerFW"   "${new_prefix}-SrvFW"
    rename_firewall "${legacy_prefix}-DatabaseFW" "${new_prefix}-DbFW"
    rename_firewall "${legacy_prefix}-BurstFW"    "${new_prefix}-BurstFW"
    rename_by_prefix "images" "/images?page_size=500" "${legacy_prefix}-" "${new_prefix}-"
    rename_vpc_and_subnet "$legacy_prefix" "$new_prefix"

    log_success "'$environment_name' resources are on the naming convention (tag: $ENVIRONMENT_TAG)."
    echo
}

for environment_name in development testing production
do
    migrate_environment "$environment_name"
done

log_success "All environments are on the CogniumLearn-<Env>-* naming convention."
log_info "Unrelated resources 'InternalTools', 'HiveCentral' and firewall 'AcceptSshOnly' were left untouched."
