#!/usr/bin/env bash
#
# MindMeld one-shot deployment orchestrator.
#
# Run from your dev box (Git Bash on Windows) after committing your Agent changes:
#     bash Common/Deployment/deploy.sh
#
# It automates the full burst-worker roll-out described in Common/ReadmeFiles/Deployment.md:
#   1. Create a throwaway Debian 12 "bakebox" Linode.
#   2. Copy the Agent build context to it.
#   3. Build the mindmeld-agent Docker image + install the worker service.
#   4. Strip the OS / containerd cache so the disk fits Linode's 6 GB Image cap.
#   5. Shrink the disk and capture it as MindMeldBurstVmImage<version> (auto-incremented).
#   6. Build the production frontend, then SSH the base node and refresh Agent + Dock code + venv.
#   7. Point the fleet at the new image, ensure Dock + cloudflared run as services, restart Dock.
#   8. Delete the bakebox and any older MindMeldBurstVmImage<version> images.
#   9. Print a summary (and POST it to NOTIFY_WEBHOOK_URL if configured).
#
# Configuration lives in deployment.env at the repo root (gitignored). Nothing here
# is destructive to the base node's secrets — the Agent tar excludes env files.
#
# Flags:
#   --skip-base-update     Bake + capture only; do not touch the base node or old images.
#   --skip-bake            Reuse the latest already-baked image (skip bake + capture); just
#                          rebuild the frontend, update the base node, and clean up older
#                          images. Use to resume after a base-node-step failure without
#                          paying for another 15-20 min bake.
#   --skip-frontend-build  Don't rebuild Dock/Static; ship it as-is (use if you already built).
#   --cleanup-bakeboxes    Delete any stray bakebox Linodes from a failed earlier run, then exit.
#   --help                 Show this help.
set -euo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIRECTORY/../.." && pwd)"
BAKEBOX_MANAGEMENT_TAG="mindmeld-bakebox"

# shellcheck source=Library/Logging.sh
source "$SCRIPT_DIRECTORY/Library/Logging.sh"
# shellcheck source=Library/LinodeApi.sh
source "$SCRIPT_DIRECTORY/Library/LinodeApi.sh"

# ── Run state (mutated as the run progresses; read by the exit trap) ──────────
SKIP_BASE_UPDATE=0
SKIP_BAKE=0
SKIP_FRONTEND_BUILD=0
BAKEBOX_INSTANCE_ID=""
BAKEBOX_PUBLIC_IP=""
NEW_IMAGE_VERSION=""
NEW_IMAGE_LABEL=""
NEW_IMAGE_ID=""
BASE_NODE_UPDATED=0
RUN_SUCCEEDED=0
SSH_COMMON_OPTIONS=()

show_help()
{
    sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# ── Configuration loading + validation ────────────────────────────────────────
load_configuration()
{
    local configuration_file="$REPOSITORY_ROOT/deployment.env"
    [ -f "$configuration_file" ] || { log_error "Missing $configuration_file (see the comments in that file)."; exit 1; }

    set -a
    # shellcheck disable=SC1090
    source "$configuration_file"
    set +a

    DEPLOY_SSH_PUBLIC_KEY_PATH="$(expand_path "${DEPLOY_SSH_PUBLIC_KEY_PATH:-}")"
    DEPLOY_SSH_PRIVATE_KEY_PATH="$(expand_path "${DEPLOY_SSH_PRIVATE_KEY_PATH:-}")"

    SSH_COMMON_OPTIONS=(
        -o BatchMode=yes
        -o StrictHostKeyChecking=no
        -o UserKnownHostsFile=/dev/null
        -o ConnectTimeout=10
        -i "$DEPLOY_SSH_PRIVATE_KEY_PATH"
    )
}

expand_path()
{
    local path_value="$1"
    printf '%s' "${path_value/#\~/$HOME}"
}

require_value()
{
    local variable_name="$1"
    if [ -z "${!variable_name:-}" ]
    then
        log_error "deployment.env is missing a required value: $variable_name"
        exit 1
    fi
}

validate_environment()
{
    require_value LINODE_API_TOKEN
    require_value BURST_REGION
    require_value BAKEBOX_INSTANCE_TYPE
    require_value BAKEBOX_IMAGE
    require_value BAKEBOX_DISK_CAPTURE_SIZE_MB
    require_value IMAGE_LABEL_PREFIX
    require_value DEPLOY_SSH_PUBLIC_KEY_PATH
    require_value DEPLOY_SSH_PRIVATE_KEY_PATH

    [ -f "$DEPLOY_SSH_PUBLIC_KEY_PATH" ]  || { log_error "SSH public key not found: $DEPLOY_SSH_PUBLIC_KEY_PATH"; exit 1; }
    [ -f "$DEPLOY_SSH_PRIVATE_KEY_PATH" ] || { log_error "SSH private key not found: $DEPLOY_SSH_PRIVATE_KEY_PATH"; exit 1; }

    if [ "$SKIP_BASE_UPDATE" -eq 0 ]
    then
        require_value BASE_NODE_SSH_HOST
        require_value BASE_NODE_SSH_USER
        require_value BASE_NODE_REPO_DIR
    fi

    for required_tool in curl ssh scp tar node
    do
        command -v "$required_tool" >/dev/null 2>&1 || { log_error "Required tool not on PATH: $required_tool"; exit 1; }
    done
}

# ── SSH helpers (SSH_COMMON_OPTIONS is populated by load_configuration) ────────
run_ssh()
{
    local target="$1"; shift
    ssh "${SSH_COMMON_OPTIONS[@]}" "$target" "$@"
}

copy_over_scp()
{
    scp "${SSH_COMMON_OPTIONS[@]}" "$@"
}

wait_for_ssh()
{
    local target="$1"

    local elapsed_seconds=0
    while [ "$elapsed_seconds" -lt 300 ]
    do
        if ssh "${SSH_COMMON_OPTIONS[@]}" "$target" true 2>/dev/null
        then
            return 0
        fi
        sleep 5
        elapsed_seconds=$((elapsed_seconds + 5))
    done

    log_error "SSH to $target was not ready within 300s."
    return 1
}

# ── Notification (step 9) ─────────────────────────────────────────────────────
send_notification()
{
    local status="$1"
    local message="$2"

    if [ -z "${NOTIFY_WEBHOOK_URL:-}" ]
    then
        return 0
    fi

    local payload
    payload="$(node -e '
        const [status, message, version, imageId, baseNodeUpdated] = process.argv.slice(1);
        process.stdout.write(JSON.stringify({
            text: `MindMeld deploy ${status}: ${message}`,
            status, message,
            version: version || null,
            imageId: imageId || null,
            baseNodeUpdated: baseNodeUpdated === "1",
            timestamp: new Date().toISOString()
        }));
    ' "$status" "$message" "${NEW_IMAGE_VERSION:-}" "${NEW_IMAGE_ID:-}" "$BASE_NODE_UPDATED")"

    curl --silent --show-error --max-time 15 \
        --request POST \
        --header "Content-Type: application/json" \
        --data "$payload" \
        "$NOTIFY_WEBHOOK_URL" >/dev/null 2>&1 \
        && log_info "Posted summary to NOTIFY_WEBHOOK_URL." \
        || log_warning "Could not POST to NOTIFY_WEBHOOK_URL."
}

# ── Exit trap: report outcome + preserve the bakebox on failure ───────────────
handle_exit()
{
    local exit_code=$?

    if [ "$RUN_SUCCEEDED" -eq 1 ]
    then
        return
    fi

    echo
    log_error "Deployment FAILED (exit $exit_code)."

    if [ -n "$BAKEBOX_INSTANCE_ID" ]
    then
        log_warning "The bakebox Linode was left running for inspection:"
        log_warning "  id=$BAKEBOX_INSTANCE_ID  ip=${BAKEBOX_PUBLIC_IP:-unknown}"
        log_warning "  SSH:    ssh -i $DEPLOY_SSH_PRIVATE_KEY_PATH root@${BAKEBOX_PUBLIC_IP:-<ip>}"
        log_warning "  Delete: bash Common/Deployment/deploy.sh --cleanup-bakeboxes"
    fi

    send_notification "FAILED" "exit $exit_code (see console output)"
}

# ── Stray-bakebox cleanup (--cleanup-bakeboxes) ───────────────────────────────
cleanup_stray_bakeboxes()
{
    log_step "Looking for stray bakebox Linodes (tag: $BAKEBOX_MANAGEMENT_TAG)..."
    local listing
    listing="$(linode_request GET "/linode/instances?page_size=500")"

    local stray_ids
    stray_ids="$(printf '%s' "$listing" | node -e '
        let input = "";
        process.stdin.on("data", chunk => input += chunk);
        process.stdin.on("end", () =>
        {
            const tag = process.argv[1];
            const data = JSON.parse(input).data || [];
            process.stdout.write(data.filter(instance => (instance.tags || []).includes(tag)).map(instance => instance.id).join("\n"));
        });
    ' "$BAKEBOX_MANAGEMENT_TAG")"

    if [ -z "$stray_ids" ]
    then
        log_success "No stray bakeboxes found."
        return 0
    fi

    while IFS= read -r stray_id
    do
        [ -n "$stray_id" ] || continue
        log_info "Deleting bakebox Linode $stray_id..."
        linode_delete_instance "$stray_id"
    done <<< "$stray_ids"

    log_success "Stray bakeboxes deleted."
}

# ── The bake (steps 1–5) ──────────────────────────────────────────────────────
determine_next_version()
{
    log_step "Determining the next image version..."
    local highest_version
    highest_version="$(linode_get_highest_image_version "$IMAGE_LABEL_PREFIX")"
    NEW_IMAGE_VERSION=$((highest_version + 1))
    NEW_IMAGE_LABEL="${IMAGE_LABEL_PREFIX}${NEW_IMAGE_VERSION}"
    log_info "Highest existing version: ${highest_version}. New image: ${NEW_IMAGE_LABEL}."
}

# --skip-bake path: reuse the latest already-baked image instead of baking a new one.
# Resolves NEW_IMAGE_VERSION/LABEL/ID from the highest existing managed image so the rest
# of the run (base-node update, old-image cleanup) behaves exactly as it would after a
# fresh bake. Used to resume a run whose only failure was a base-node step.
resolve_latest_image()
{
    log_step "Resolving the latest existing image (--skip-bake)..."
    local highest_version
    highest_version="$(linode_get_highest_image_version "$IMAGE_LABEL_PREFIX")"
    if [ "$highest_version" -eq 0 ]
    then
        log_error "No existing ${IMAGE_LABEL_PREFIX}<version> image to reuse — run once without --skip-bake first."
        exit 1
    fi
    NEW_IMAGE_VERSION="$highest_version"
    NEW_IMAGE_LABEL="${IMAGE_LABEL_PREFIX}${NEW_IMAGE_VERSION}"
    NEW_IMAGE_ID="$(linode_get_highest_image_id "$IMAGE_LABEL_PREFIX")"
    [ -n "$NEW_IMAGE_ID" ] || { log_error "Could not resolve the id of ${NEW_IMAGE_LABEL}."; exit 1; }
    log_info "Reusing ${NEW_IMAGE_LABEL} (${NEW_IMAGE_ID}) — skipping bake + capture."
}

create_and_provision_bakebox()
{
    log_step "Creating the bakebox Linode (Debian 12, $BAKEBOX_INSTANCE_TYPE, $BURST_REGION)..."
    local bakebox_label="${IMAGE_LABEL_PREFIX}-bakebox-${NEW_IMAGE_VERSION}"
    BAKEBOX_INSTANCE_ID="$(linode_create_bakebox "$DEPLOY_SSH_PUBLIC_KEY_PATH" "$bakebox_label" "$BURST_REGION" "$BAKEBOX_INSTANCE_TYPE" "$BAKEBOX_IMAGE" "$BAKEBOX_MANAGEMENT_TAG")"
    log_info "Bakebox Linode id: $BAKEBOX_INSTANCE_ID"

    log_step "Waiting for the bakebox to boot..."
    linode_wait_for_status "$BAKEBOX_INSTANCE_ID" "running" 300
    BAKEBOX_PUBLIC_IP="$(linode_get_public_ipv4 "$BAKEBOX_INSTANCE_ID")"
    log_info "Bakebox public IP: $BAKEBOX_PUBLIC_IP"
    wait_for_ssh "root@${BAKEBOX_PUBLIC_IP}"
    log_success "Bakebox is reachable over SSH."

    log_step "Building the Agent context archive locally..."
    local context_archive
    context_archive="$(mktemp -t mindmeld-agent-context.XXXXXX.tar.gz)"
    ( cd "$REPOSITORY_ROOT" && build_agent_context "$context_archive" )

    log_step "Uploading the context + provisioning script to the bakebox..."
    copy_over_scp "$context_archive" "root@${BAKEBOX_PUBLIC_IP}:/root/agent-context.tar.gz"
    copy_over_scp "$SCRIPT_DIRECTORY/Remote/BakeboxProvision.sh" "root@${BAKEBOX_PUBLIC_IP}:/root/BakeboxProvision.sh"
    rm -f "$context_archive"

    log_step "Building the image + trimming the OS on the bakebox (this takes a few minutes)..."
    run_ssh "root@${BAKEBOX_PUBLIC_IP}" "bash /root/BakeboxProvision.sh"
    log_success "Bakebox provisioned and trimmed."
}

build_agent_context()
{
    local output_path="$1"
    # Mirror Agent/.dockerignore — scp/tar do not honour it — so the venv, caches and
    # (critically) the *.env secrets never leave the dev box.
    tar --exclude='.venv' --exclude='venv' --exclude='__pycache__' --exclude='*.pyc' \
        --exclude='.env' --exclude='*.env' --exclude='Tasks' \
        --exclude='.pytest_cache' --exclude='.mypy_cache' --exclude='*.log' \
        -czf "$output_path" Agent
}

build_frontend()
{
    # The production-frontend build (the `setup.bat --aggressive` equivalent, run as
    # the cross-platform Node scripts documented in Deployment.md §1.7) so the
    # Dock/Static/ that gets shipped is always the latest codegen + bundled + mangled
    # + obfuscated build — never a stale or dev build.
    log_step "Building the production frontend (codegen + bundle + mangle + obfuscate)..."
    (
        cd "$REPOSITORY_ROOT"
        node ./Common/Scripts/GenerateServiceManifest.js
        node ./Common/Scripts/GenerateEnumerations.js
        node ./Common/Scripts/GenerateConstants.js
        node ./Common/Scripts/GenerateClasses.js
        node ./Common/Scripts/CopyStaticFiles.js
        node ./Common/Scripts/BundleStaticFiles.js
        node ./Common/Scripts/ManglePrivateMembersInBundle.js
        node ./Common/Scripts/MinifyAndObfuscateStaticFiles.js --aggressive
    )
    log_success "Frontend built (Dock/Static is production-ready)."
}

build_dock_context()
{
    local output_path="$1"
    # Brute-force copy of Dock INCLUDING node_modules + the built Static/ — no npm
    # install on the server. Excludes ONLY the env secrets so the live
    # Dock/.production.env is never clobbered. Shipping the dev box's node_modules
    # as-is is safe only while Dock has no native (.node) modules (all current deps
    # are pure JS); re-verify with `find Dock/node_modules -name '*.node'` if you add one.
    tar --exclude='Dock/.production.env' --exclude='Dock/.env' --exclude='Dock/.env.*' \
        --exclude='Dock/logs' --exclude='Dock/Tasks' \
        -czf "$output_path" Dock
}

capture_image()
{
    log_step "Powering off the bakebox to shrink its disk..."
    linode_power_off "$BAKEBOX_INSTANCE_ID"

    log_step "Shrinking the disk to ${BAKEBOX_DISK_CAPTURE_SIZE_MB} MB (for the 6 GB Image cap)..."
    local disk_id
    disk_id="$(linode_get_ext4_disk_id "$BAKEBOX_INSTANCE_ID")"
    [ -n "$disk_id" ] || { log_error "Could not find the ext4 root disk on the bakebox."; exit 1; }
    linode_resize_disk "$BAKEBOX_INSTANCE_ID" "$disk_id" "$BAKEBOX_DISK_CAPTURE_SIZE_MB"

    log_step "Capturing the image as ${NEW_IMAGE_LABEL}..."
    NEW_IMAGE_ID="$(linode_capture_image "$disk_id" "$NEW_IMAGE_LABEL" "MindMeld burst worker image, version ${NEW_IMAGE_VERSION}")"
    log_info "New image id: $NEW_IMAGE_ID (waiting for it to become available)..."
    linode_wait_for_image_available "$NEW_IMAGE_ID" 1200
    log_success "Image ${NEW_IMAGE_LABEL} (${NEW_IMAGE_ID}) is available."
}

# ── Base node roll-out (steps 6–7) ────────────────────────────────────────────
update_base_node()
{
    local base_node_target="${BASE_NODE_SSH_USER}@${BASE_NODE_SSH_HOST}"
    local image_id_to_set=""
    if [ "${BASE_NODE_UPDATE_BURST_IMAGE_ID:-1}" = "1" ]
    then
        image_id_to_set="$NEW_IMAGE_ID"
    fi

    log_step "Verifying SSH to the base node ($base_node_target)..."
    wait_for_ssh "$base_node_target"

    if [ "$SKIP_FRONTEND_BUILD" -eq 0 ]
    then
        build_frontend
    else
        log_warning "Skipping frontend build (--skip-frontend-build) — shipping Dock/Static as-is."
    fi

    log_step "Uploading the Agent + Dock contexts to the base node..."
    local agent_archive dock_archive
    agent_archive="$(mktemp -t mindmeld-agent-context.XXXXXX.tar.gz)"
    dock_archive="$(mktemp -t mindmeld-dock-context.XXXXXX.tar.gz)"
    ( cd "$REPOSITORY_ROOT" && build_agent_context "$agent_archive" && build_dock_context "$dock_archive" )
    copy_over_scp "$agent_archive" "${base_node_target}:/tmp/mindmeld-agent-context.tar.gz"
    copy_over_scp "$dock_archive" "${base_node_target}:/tmp/mindmeld-dock-context.tar.gz"
    rm -f "$agent_archive" "$dock_archive"

    log_step "Refreshing Agent + Dock code, venv, image pointer + (re)starting the Dock service..."
    run_ssh "$base_node_target" \
        "REPO_DIR='$BASE_NODE_REPO_DIR' AGENT_CONTEXT_ARCHIVE='/tmp/mindmeld-agent-context.tar.gz' DOCK_CONTEXT_ARCHIVE='/tmp/mindmeld-dock-context.tar.gz' NEW_IMAGE_ID='$image_id_to_set' bash -s" \
        < "$SCRIPT_DIRECTORY/Remote/BaseNodeUpdate.sh"

    BASE_NODE_UPDATED=1
    log_success "Base node updated and Dock restarted."
}

# ── Cleanup (step 8) ──────────────────────────────────────────────────────────
cleanup_after_success()
{
    if [ -n "$BAKEBOX_INSTANCE_ID" ]
    then
        log_step "Deleting the bakebox Linode ($BAKEBOX_INSTANCE_ID)..."
        linode_delete_instance "$BAKEBOX_INSTANCE_ID"
        BAKEBOX_INSTANCE_ID=""
        log_success "Bakebox deleted."
    else
        log_info "No bakebox to delete (--skip-bake reused an existing image)."
    fi

    if [ "$SKIP_BASE_UPDATE" -eq 1 ]
    then
        log_info "Skipping old-image deletion (base node was not switched to the new image)."
        return 0
    fi

    log_step "Deleting older ${IMAGE_LABEL_PREFIX} images (versions < ${NEW_IMAGE_VERSION})..."
    local older_ids
    older_ids="$(linode_get_older_image_ids "$IMAGE_LABEL_PREFIX" "$NEW_IMAGE_VERSION")"

    if [ -z "$older_ids" ]
    then
        log_info "No older images to delete."
        return 0
    fi

    while IFS= read -r older_id
    do
        [ -n "$older_id" ] || continue
        log_info "Deleting old image $older_id..."
        linode_delete_image "$older_id"
    done <<< "$older_ids"
    log_success "Old images deleted."
}

print_final_summary()
{
    echo
    log_success "════════════════════════════════════════════════════════════"
    log_success " Deployment complete."
    log_success "   New image:  ${NEW_IMAGE_LABEL}  (${NEW_IMAGE_ID})"
    if [ "$BASE_NODE_UPDATED" -eq 1 ]
    then
        log_success "   Base node:  updated, Dock restarted (fleet now uses the new image)."
    else
        log_success "   Base node:  skipped (--skip-base-update). Set BURST_IMAGE_ID=${NEW_IMAGE_ID} and restart Dock when ready."
    fi
    log_success "════════════════════════════════════════════════════════════"
    send_notification "SUCCEEDED" "${NEW_IMAGE_LABEL} (${NEW_IMAGE_ID})"
}

# ── Main ──────────────────────────────────────────────────────────────────────
main()
{
    local cleanup_only=0

    while [ $# -gt 0 ]
    do
        case "$1" in
            --skip-base-update) SKIP_BASE_UPDATE=1 ;;
            --skip-bake) SKIP_BAKE=1 ;;
            --skip-frontend-build) SKIP_FRONTEND_BUILD=1 ;;
            --cleanup-bakeboxes) cleanup_only=1 ;;
            --help|-h) show_help; exit 0 ;;
            *) log_error "Unknown flag: $1"; show_help; exit 1 ;;
        esac
        shift
    done

    load_configuration
    validate_environment

    if [ "$cleanup_only" -eq 1 ]
    then
        cleanup_stray_bakeboxes
        RUN_SUCCEEDED=1
        exit 0
    fi

    trap handle_exit EXIT

    if [ "$SKIP_BAKE" -eq 1 ]
    then
        resolve_latest_image
    else
        determine_next_version
        create_and_provision_bakebox
        capture_image
    fi

    if [ "$SKIP_BASE_UPDATE" -eq 0 ]
    then
        update_base_node
    else
        log_warning "Skipping base-node update (--skip-base-update)."
    fi

    cleanup_after_success
    print_final_summary

    RUN_SUCCEEDED=1
}

main "$@"
