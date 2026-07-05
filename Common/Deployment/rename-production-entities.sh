#!/usr/bin/env bash
#
# One-shot, idempotent migration of the LEGACY production Linode resources to the
# MindMeld-<Env>-<Role> naming convention (Deployment.md). The original production
# environment was provisioned by hand before the convention existed, so its
# resources carry ad-hoc, inconsistently-cased labels and no environment tag.
#
# Every change here is METADATA ONLY — a label rename (PUT label) and a tag merge.
# Nothing is recreated, no IP changes, no service restart: BURST_IMAGE_ID and every
# other reference is by numeric id, not label, so production keeps serving
# throughout. Safe to re-run: once an entity is renamed the old label is no longer
# found and that entity is skipped.
#
# Usage (from the repo root, Git Bash):
#   bash Common/Deployment/rename-production-entities.sh --dry-run   # print the plan
#   bash Common/Deployment/rename-production-entities.sh             # apply it
#
# It leaves the unrelated `InternalTools` Linode and `AcceptSshOnly` firewall alone.
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

load_environment_config production
load_deployment_secrets production
PRODUCTION_TAG="$ENVIRONMENT_TAG"

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
    linode_add_tag "linode/instances" "$entity_id" "$PRODUCTION_TAG"
}

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
    linode_add_tag "networking/firewalls" "$entity_id" "$PRODUCTION_TAG"
}

rename_image()
{
    local legacy_label="$1"
    local new_label="$2"
    local entity_id

    entity_id="$(linode_find_image_id_by_label "$legacy_label")"
    if [ -n "$entity_id" ]
    then
        log_step "Image '$legacy_label' -> '$new_label' (id=$entity_id)"
        linode_rename_entity "images" "$entity_id" "$new_label"
    else
        entity_id="$(linode_find_image_id_by_label "$new_label")"
        if [ -n "$entity_id" ]
        then
            log_info "Image already named '$new_label' (id=$entity_id) — skipping rename."
        else
            log_warning "No image named '$legacy_label' or '$new_label' — skipping."
            return 0
        fi
    fi
    linode_add_tag "images" "$entity_id" "$PRODUCTION_TAG"
}

# The VPC is matched by label; its single subnet is renamed too. VPCs do not carry
# tags in the Linode API, so we rely on the label for identification.
rename_vpc_and_subnet()
{
    local legacy_label="$1"
    local new_label="$2"
    local legacy_subnet_label="$3"
    local new_subnet_label="$4"

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

log_step "Migrating legacy production resources to the MindMeld-Production-* convention..."

# Firewall labels are capped at 32 chars by the Linode API, so firewalls use the
# short role names ServerFW / DatabaseFW / BurstFW (still prefixed MindMeld-<Env>-).
rename_instance "MindmeldServer"          "MindMeld-Production-Server"
rename_instance "MindMeldMongoDB"         "MindMeld-Production-MongoDB"
rename_firewall "MindmeldServerFirewall"  "MindMeld-Production-ServerFW"
rename_firewall "MindMeldDatabaseFirewall" "MindMeld-Production-DatabaseFW"
rename_firewall "MindMeldBurstVmFirewall" "MindMeld-Production-BurstFW"
rename_image    "MindMeldBurstVmImage7"   "MindMeld-Production-BurstImage7"
rename_vpc_and_subnet "MindMeldVPC" "MindMeld-Production-VPC" "MindMeldSubnet" "MindMeld-Production-Subnet"

echo
log_success "Production entities are on the naming convention (tag: $PRODUCTION_TAG)."
log_info "Unrelated resources 'InternalTools' and firewall 'AcceptSshOnly' were left untouched."
