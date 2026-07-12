#!/usr/bin/env bash
#
# MindMeld per-environment code + burst-image roll-out.
#
#     bash Common/Deployment/deploy-environment.sh <development|testing|production> [flags]
#
# Assumes the environment's infrastructure already exists (VPC, firewalls, base
# node, Mongo, tunnel) — provision-environment.sh creates all of that. This script
# is the *update* path: it bakes a fresh burst-worker image, refreshes the Agent +
# Dock code on the base node, points the fleet at the new image and restarts Dock.
#
# It reuses the same Library helpers and bake flow the original single-environment
# deploy.sh used; the only difference is that the environment name selects the
# label prefix, the base-node host, and the .<env>.env files.
#
# Configuration (single file): deployment.env holds shared secrets (LINODE_API_TOKEN,
#   SSH keys, bakebox) unsuffixed, and per-env values suffixed by environment
#   (BASE_NODE_SSH_HOST_<ENV>, CLOUDFLARE_TUNNEL_TOKEN_<ENV>, ...), resolved per run.
#
# Flags (same meaning as the legacy deploy.sh):
#   --skip-base-update  --skip-bake  --skip-frontend-build  --cleanup-bakeboxes  --help
set -euo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIRECTORY/Library/Logging.sh"
source "$SCRIPT_DIRECTORY/Library/LinodeApi.sh"
source "$SCRIPT_DIRECTORY/Library/EnvironmentConfig.sh"

BAKEBOX_MANAGEMENT_TAG="mindmeld-bakebox"

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

expand_path()
{
    printf '%s' "${1/#\~/$HOME}"
}

require_value()
{
    local variable_name="$1"
    if [ -z "${!variable_name:-}" ]
    then
        log_error "Missing a required value for '$ENVIRONMENT_NAME': $variable_name (set it in deployment.env, suffixed _${ENVIRONMENT_NAME^^} if per-environment)."
        exit 1
    fi
}

configure_for_environment()
{
    load_environment_config "$ENVIRONMENT_NAME"
    load_deployment_secrets "$ENVIRONMENT_NAME"

    # Image label prefix is ALWAYS derived per-environment from the naming
    # convention (MindMeld-<Env>-BurstImage) so a stale shared value can never leak
    # one environment's images into another's version series.
    IMAGE_LABEL_PREFIX="$(label_for_role BurstImage)"
    # Bakebox region defaults to the environment's region; a per-env deployment file
    # may override it via BAKEBOX_REGION (captured images are account-global anyway).
    BAKEBOX_REGION="${BAKEBOX_REGION:-$ENVIRONMENT_REGION}"
    BAKEBOX_INSTANCE_TYPE="${BAKEBOX_INSTANCE_TYPE:-g6-standard-4}"
    BAKEBOX_IMAGE="${BAKEBOX_IMAGE:-linode/debian12}"
    BAKEBOX_DISK_CAPTURE_SIZE_MB="${BAKEBOX_DISK_CAPTURE_SIZE_MB:-6144}"

    DEPLOY_SSH_PUBLIC_KEY_PATH="$(expand_path "${DEPLOY_SSH_PUBLIC_KEY_PATH:-}")"
    DEPLOY_SSH_PRIVATE_KEY_PATH="$(expand_path "${DEPLOY_SSH_PRIVATE_KEY_PATH:-}")"

    require_value LINODE_API_TOKEN
    require_value BAKEBOX_REGION
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

    SSH_COMMON_OPTIONS=(
        -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
        -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=10
        -i "$DEPLOY_SSH_PRIVATE_KEY_PATH"
    )
}

run_ssh() { local target="$1"; shift; ssh "${SSH_COMMON_OPTIONS[@]}" "$target" "$@"; }
copy_over_scp() { scp "${SSH_COMMON_OPTIONS[@]}" "$@"; }

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

send_notification()
{
    local status="$1" message="$2"
    [ -n "${NOTIFY_WEBHOOK_URL:-}" ] || return 0
    local payload
    payload="$(node -e '
        const [status, message, env, version, imageId, baseNodeUpdated] = process.argv.slice(1);
        process.stdout.write(JSON.stringify({
            text: `MindMeld [${env}] deploy ${status}: ${message}`,
            status, message, environment: env,
            version: version || null, imageId: imageId || null,
            baseNodeUpdated: baseNodeUpdated === "1"
        }));
    ' "$status" "$message" "$ENVIRONMENT_NAME" "${NEW_IMAGE_VERSION:-}" "${NEW_IMAGE_ID:-}" "$BASE_NODE_UPDATED")"
    curl --silent --show-error --max-time 15 --request POST \
        --header "Content-Type: application/json" --data "$payload" \
        "$NOTIFY_WEBHOOK_URL" >/dev/null 2>&1 \
        && log_info "Posted summary to NOTIFY_WEBHOOK_URL." \
        || log_warning "Could not POST to NOTIFY_WEBHOOK_URL."
}

handle_exit()
{
    local exit_code=$?
    [ "$RUN_SUCCEEDED" -eq 1 ] && return
    echo
    log_error "Deployment of '$ENVIRONMENT_NAME' FAILED (exit $exit_code)."
    if [ -n "$BAKEBOX_INSTANCE_ID" ]
    then
        log_warning "The bakebox Linode was left running for inspection:"
        log_warning "  id=$BAKEBOX_INSTANCE_ID  ip=${BAKEBOX_PUBLIC_IP:-unknown}"
        log_warning "  Delete: bash Common/Deployment/deploy-environment.sh $ENVIRONMENT_NAME --cleanup-bakeboxes"
    fi
    send_notification "FAILED" "exit $exit_code (see console output)"
}

cleanup_stray_bakeboxes()
{
    log_step "Looking for stray bakebox Linodes (tag: $BAKEBOX_MANAGEMENT_TAG)..."
    local listing stray_ids
    listing="$(linode_request GET "/linode/instances?page_size=500")"
    stray_ids="$(printf '%s' "$listing" | node -e '
        let input = ""; process.stdin.on("data", chunk => input += chunk);
        process.stdin.on("end", () => {
            const tag = process.argv[1];
            const data = JSON.parse(input).data || [];
            process.stdout.write(data.filter(instance => (instance.tags || []).includes(tag)).map(instance => instance.id).join("\n"));
        });
    ' "$BAKEBOX_MANAGEMENT_TAG")"
    if [ -z "$stray_ids" ]; then log_success "No stray bakeboxes found."; return 0; fi
    while IFS= read -r stray_id
    do
        [ -n "$stray_id" ] || continue
        log_info "Deleting bakebox Linode $stray_id..."
        linode_delete_instance "$stray_id"
    done <<< "$stray_ids"
    log_success "Stray bakeboxes deleted."
}

determine_next_version()
{
    log_step "Determining the next image version for '$ENVIRONMENT_NAME'..."
    local highest_version
    highest_version="$(linode_get_highest_image_version "$IMAGE_LABEL_PREFIX")"
    NEW_IMAGE_VERSION=$((highest_version + 1))
    NEW_IMAGE_LABEL="${IMAGE_LABEL_PREFIX}${NEW_IMAGE_VERSION}"
    log_info "Highest existing version: ${highest_version}. New image: ${NEW_IMAGE_LABEL}."
}

resolve_latest_image()
{
    log_step "Resolving the latest existing image (--skip-bake)..."
    local highest_version
    highest_version="$(linode_get_highest_image_version "$IMAGE_LABEL_PREFIX")"
    [ "$highest_version" -ne 0 ] || { log_error "No existing ${IMAGE_LABEL_PREFIX}<version> image to reuse — run once without --skip-bake first."; exit 1; }
    NEW_IMAGE_VERSION="$highest_version"
    NEW_IMAGE_LABEL="${IMAGE_LABEL_PREFIX}${NEW_IMAGE_VERSION}"
    NEW_IMAGE_ID="$(linode_get_highest_image_id "$IMAGE_LABEL_PREFIX")"
    [ -n "$NEW_IMAGE_ID" ] || { log_error "Could not resolve the id of ${NEW_IMAGE_LABEL}."; exit 1; }
    log_info "Reusing ${NEW_IMAGE_LABEL} (${NEW_IMAGE_ID}) — skipping bake + capture."
}

build_agent_context()
{
    local output_path="$1"
    tar --exclude='.venv' --exclude='venv' --exclude='__pycache__' --exclude='*.pyc' \
        --exclude='.env' --exclude='*.env' --exclude='Tasks' \
        --exclude='.pytest_cache' --exclude='.mypy_cache' --exclude='*.log' \
        -czf "$output_path" Agent
}

build_dock_context()
{
    local output_path="$1"
    tar --exclude='Dock/.production.env' --exclude='Dock/.env' --exclude='Dock/.env.*' \
        --exclude='Dock/.local.env' --exclude='Dock/.development.env' --exclude='Dock/.testing.env' \
        --exclude='Dock/logs' --exclude='Dock/Tasks' \
        -czf "$output_path" Dock
}

build_frontend()
{
    log_step "Building the production frontend (codegen + bundle + mangle + obfuscate)..."
    # Retry the whole build: on a Windows dev box the bundler's post-inline unlink of
    # Dock/Static sources intermittently hits EBUSY (Defender/indexer/IDE holding a
    # just-written file). The lock is transient, so a short wait + retry clears it.
    local attempt
    for attempt in 1 2 3 4 5
    do
        if (
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
        then
            log_success "Frontend built (Dock/Static is production-ready)."
            return 0
        fi
        log_warning "Frontend build attempt $attempt failed (transient file lock?); retrying in 10s..."
        sleep 10
    done
    log_error "Frontend build failed after 5 attempts."
    return 1
}

create_and_provision_bakebox()
{
    log_step "Creating the bakebox Linode (Debian 12, $BAKEBOX_INSTANCE_TYPE, $BAKEBOX_REGION)..."
    local bakebox_label="${IMAGE_LABEL_PREFIX}-bakebox-${NEW_IMAGE_VERSION}"
    BAKEBOX_INSTANCE_ID="$(linode_create_bakebox "$DEPLOY_SSH_PUBLIC_KEY_PATH" "$bakebox_label" "$BAKEBOX_REGION" "$BAKEBOX_INSTANCE_TYPE" "$BAKEBOX_IMAGE" "$BAKEBOX_MANAGEMENT_TAG")"
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
    NEW_IMAGE_ID="$(linode_capture_image "$disk_id" "$NEW_IMAGE_LABEL" "MindMeld ${ENVIRONMENT_NAME} burst worker image, version ${NEW_IMAGE_VERSION}")"
    log_info "New image id: $NEW_IMAGE_ID (waiting for it to become available)..."
    linode_wait_for_image_available "$NEW_IMAGE_ID" 1200
    # Tag the image so it is swept by teardown-environment.sh.
    linode_add_tag "images" "$NEW_IMAGE_ID" "$ENVIRONMENT_TAG" || true
    log_success "Image ${NEW_IMAGE_LABEL} (${NEW_IMAGE_ID}) is available."
}

update_base_node()
{
    local base_node_target="${BASE_NODE_SSH_USER}@${BASE_NODE_SSH_HOST}"
    local image_id_to_set=""
    if [ "${BASE_NODE_UPDATE_BURST_IMAGE_ID:-1}" = "1" ]
    then
        image_id_to_set="$NEW_IMAGE_ID"
    fi

    log_step "Verifying SSH to the '$ENVIRONMENT_NAME' base node ($base_node_target)..."
    wait_for_ssh "$base_node_target"

    if [ "$SKIP_FRONTEND_BUILD" -eq 0 ]; then build_frontend; else log_warning "Skipping frontend build (--skip-frontend-build)."; fi

    log_step "Uploading the Agent + Dock contexts to the base node..."
    local agent_archive dock_archive
    agent_archive="$(mktemp -t mindmeld-agent-context.XXXXXX.tar.gz)"
    dock_archive="$(mktemp -t mindmeld-dock-context.XXXXXX.tar.gz)"
    ( cd "$REPOSITORY_ROOT" && build_agent_context "$agent_archive" && build_dock_context "$dock_archive" )
    copy_over_scp "$agent_archive" "${base_node_target}:/tmp/mindmeld-agent-context.tar.gz"
    copy_over_scp "$dock_archive" "${base_node_target}:/tmp/mindmeld-dock-context.tar.gz"
    rm -f "$agent_archive" "$dock_archive"

    # Ship this environment's Google Cloud Storage service-account key. It is
    # gitignored, so it rides neither git nor the Dock/Agent code tarballs; both Dock
    # and the Agent read Common/Credentials/mindmeld-storage.<env>.json, and without it
    # every Dock->GCS write (mock-test grading payload staging, log archival) fails.
    local storage_credential_file="$REPOSITORY_ROOT/Common/Credentials/mindmeld-storage.${ENVIRONMENT_NAME}.json"
    if [ -f "$storage_credential_file" ]
    then
        log_step "Placing the GCS credential (mindmeld-storage.${ENVIRONMENT_NAME}.json) on the base node..."
        run_ssh "$base_node_target" "mkdir -p '$BASE_NODE_REPO_DIR/Common/Credentials'"
        copy_over_scp "$storage_credential_file" "${base_node_target}:$BASE_NODE_REPO_DIR/Common/Credentials/mindmeld-storage.${ENVIRONMENT_NAME}.json"
    else
        log_warning "GCS credential $storage_credential_file not found locally — Dock/Agent GCS writes will fail on the host."
    fi

    log_step "Refreshing Agent + Dock code, image pointer + restarting Dock for '$ENVIRONMENT_NAME'..."
    run_ssh "$base_node_target" \
        "REPO_DIR='$BASE_NODE_REPO_DIR' \
         AGENT_CONTEXT_ARCHIVE='/tmp/mindmeld-agent-context.tar.gz' \
         DOCK_CONTEXT_ARCHIVE='/tmp/mindmeld-dock-context.tar.gz' \
         NEW_IMAGE_ID='$image_id_to_set' \
         DOCK_ENV_FILE='$(dock_environment_file_name)' \
         MINDMELD_ENVIRONMENT='$ENVIRONMENT_NAME' \
         CLOUDFLARE_TUNNEL_TOKEN='${CLOUDFLARE_TUNNEL_TOKEN:-}' \
         bash -s" \
        < "$SCRIPT_DIRECTORY/Remote/BaseNodeUpdate.sh"

    BASE_NODE_UPDATED=1
    log_success "Base node updated and Dock restarted."
}

cleanup_after_success()
{
    if [ -n "$BAKEBOX_INSTANCE_ID" ]
    then
        log_step "Deleting the bakebox Linode ($BAKEBOX_INSTANCE_ID)..."
        linode_delete_instance "$BAKEBOX_INSTANCE_ID"
        BAKEBOX_INSTANCE_ID=""
        log_success "Bakebox deleted."
    fi

    if [ "$SKIP_BASE_UPDATE" -eq 1 ]; then log_info "Skipping old-image deletion (base not switched)."; return 0; fi

    log_step "Deleting older ${IMAGE_LABEL_PREFIX} images (versions < ${NEW_IMAGE_VERSION})..."
    local older_ids
    older_ids="$(linode_get_older_image_ids "$IMAGE_LABEL_PREFIX" "$NEW_IMAGE_VERSION")"
    if [ -z "$older_ids" ]; then log_info "No older images to delete."; return 0; fi
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
    log_success " Deployment of '$ENVIRONMENT_NAME' complete."
    log_success "   New image:  ${NEW_IMAGE_LABEL}  (${NEW_IMAGE_ID})"
    if [ "$BASE_NODE_UPDATED" -eq 1 ]
    then
        log_success "   Base node:  updated, Dock restarted (fleet now uses the new image)."
    else
        log_success "   Base node:  skipped. Set BURST_IMAGE_ID=${NEW_IMAGE_ID} and restart Dock when ready."
    fi
    log_success "════════════════════════════════════════════════════════════"
    send_notification "SUCCEEDED" "${NEW_IMAGE_LABEL} (${NEW_IMAGE_ID})"
}

main()
{
    ENVIRONMENT_NAME=""
    local cleanup_only=0

    while [ $# -gt 0 ]
    do
        case "$1" in
            --skip-base-update) SKIP_BASE_UPDATE=1 ;;
            --skip-bake) SKIP_BAKE=1 ;;
            --skip-frontend-build) SKIP_FRONTEND_BUILD=1 ;;
            --cleanup-bakeboxes) cleanup_only=1 ;;
            --help|-h) show_help; exit 0 ;;
            -*) log_error "Unknown flag: $1"; show_help; exit 1 ;;
            *) ENVIRONMENT_NAME="$1" ;;
        esac
        shift
    done

    [ -n "$ENVIRONMENT_NAME" ] || { log_error "Usage: deploy-environment.sh <development|testing|production> [flags]"; exit 1; }
    [ "$ENVIRONMENT_NAME" != "local" ] || { log_error "The 'local' environment is not deployed to Linode (use npm run web)."; exit 1; }

    configure_for_environment

    if [ "$cleanup_only" -eq 1 ]; then cleanup_stray_bakeboxes; RUN_SUCCEEDED=1; exit 0; fi

    trap handle_exit EXIT

    if [ "$SKIP_BAKE" -eq 1 ]
    then
        resolve_latest_image
    else
        determine_next_version
        create_and_provision_bakebox
        capture_image
    fi

    if [ "$SKIP_BASE_UPDATE" -eq 0 ]; then update_base_node; else log_warning "Skipping base-node update (--skip-base-update)."; fi

    cleanup_after_success
    print_final_summary
    RUN_SUCCEEDED=1
}

main "$@"
