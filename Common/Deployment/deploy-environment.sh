#!/usr/bin/env bash
#
# CogniumLearn per-environment code + burst-image roll-out.
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
# PRODUCTION deploys are gated on browser suites driven against the freshly-built
# bundle BEFORE anything is baked or shipped: 7 tutorials + 27 critical flows + 19
# sync cases (needs local Redis/MongoDB + TUTORIAL_TEST_SESSION_COOKIE). Development
# and testing run NO gate: frontend build, then straight to the bake. §1.1.1.
#
# Flags (same meaning as the legacy deploy.sh):
#   --skip-base-update  --skip-bake  --skip-frontend-build  --skip-tutorial-tests
#   --keep-node-running  --cleanup-bakeboxes  --help
#
# Before anything expensive runs, the environment's Linode is checked: if it is
# powered off it is booted, and if this machine's public IP is not on the
# firewall's SSH allow-list a temporary rule is added using the Linode token in
# deployment.env. BOTH are reverted on every exit path (--keep-node-running
# leaves a node that was booted for the deploy running).
set -euo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIRECTORY/Library/Logging.sh"
source "$SCRIPT_DIRECTORY/Library/LinodeApi.sh"
source "$SCRIPT_DIRECTORY/Library/EnvironmentConfig.sh"

BAKEBOX_MANAGEMENT_TAG="cogniumlearn-bakebox"

SKIP_BASE_UPDATE=0
SKIP_BAKE=0
SKIP_FRONTEND_BUILD=0
SKIP_TUTORIAL_TESTS=0
KEEP_NODE_RUNNING=0
TUTORIAL_GATE_DOCK_PID=""

# Temporary-access bookkeeping. Every field is the record of something this run
# CHANGED on the account and must therefore put back — see restore_base_node_access.
BASE_NODE_INSTANCE_ID=""
BASE_NODE_WAS_OFFLINE=0
SERVER_FIREWALL_ID=""
FIREWALL_RULES_BACKUP_FILE=""
TEMPORARY_SSH_RULE_LABEL="temp-deploy-ssh"
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
    sed -n '2,33p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
    # convention (CogniumLearn-<Env>-BurstImage) so a stale shared value can never leak
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
            text: `CogniumLearn [${env}] deploy ${status}: ${message}`,
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

    # Never leave the gate's own Dock running, whichever way we exit.
    if [ -n "$TUTORIAL_GATE_DOCK_PID" ]
    then
        kill "$TUTORIAL_GATE_DOCK_PID" 2>/dev/null || true
        TUTORIAL_GATE_DOCK_PID=""
    fi

    # Put back any temporary firewall opening / power-on, on EVERY exit path —
    # success, failure and Ctrl-C. Leaving SSH open to a stale IP is the one
    # side effect of this script that must never survive the run.
    restore_base_node_access || true

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

# The files under Common/ that a RUNNING server executes, as opposed to the ones
# that only build the distribution. Dock ships as its own directory, so anything
# it spawns from a sibling directory has to be shipped deliberately or it is
# simply absent on the node: /Admin/PaidDecks/AuditTrail spawned a renderer that
# had never been deployed, so the endpoint could only ever have failed there.
#
# Listed file by file rather than tarring Common/ wholesale. Common/ holds the
# codegen sources, the audit and test suites, and the deployment scripts
# themselves — none of which a production node should be carrying, and one of
# which (Common/Deployment) reads deployment.env.
build_common_runtime_context()
{
    local output_path="$1"
    tar -czf "$output_path" \
        Common/Scripts/RenderPaidDeckAuditTrail.py \
        Common/Scripts/RenderOrganizationEngagementReport.py
}

build_frontend()
{
    log_step "Building the production frontend (codegen + bundle + mangle + obfuscate)..."
    # Retry the whole build: on a Windows dev box the bundler's post-inline unlink of
    # Dock/Static sources intermittently hits EBUSY (Defender/indexer/IDE holding a
    # just-written file). The lock is transient, so a short wait + retry clears it.
    #
    # Each step's exit status is checked EXPLICITLY rather than by wrapping the run
    # in `set -e`. Bash ignores errexit — including a `set -e` a subshell sets on
    # itself — whenever the command sits in an `if` condition or on the left of
    # `||`, and the previous `if ( set -e; ... )` form was exactly that, so it was
    # inert: BundleStaticFiles.js exited 1 on an EBUSY unlink, the run carried on
    # through mangle + obfuscate, reported success, and the retry never fired.
    # Dock/Static was left holding the ~635 raw sources the bundler had not managed
    # to delete alongside the bundles, and would have shipped to production that
    # way. An explicit per-step check cannot be silenced by its calling context.
    #
    # GenerateScriptIntegrityManifest.js is LAST, always — same ordering as
    # Common/Scripts/BuildPipeline.js: it records the hashes of the final served
    # bytes, so it must run after obfuscation rewrites them. Omitting it here
    # shipped a freshly-built Dock/Static next to whatever stale manifest was on
    # disk, and the base node then reported "possible compromise of the origin" on
    # every boot — a permanent false positive that buries a real tamper alert.
    local build_steps=(
        "GenerateServiceManifest.js"
        "GenerateEnumerations.js"
        "GenerateConstants.js"
        "GenerateClasses.js"
        "CopyStaticFiles.js"
        "BundleStaticFiles.js"
        "ManglePrivateMembersInBundle.js"
        "MinifyAndObfuscateStaticFiles.js --aggressive"
        "GenerateScriptIntegrityManifest.js"
    )

    local attempt
    local build_step
    local step_status
    local failed_step
    for attempt in 1 2 3 4 5
    do
        failed_step=""
        for build_step in "${build_steps[@]}"
        do
            step_status=0
            ( cd "$REPOSITORY_ROOT" && node ./Common/Scripts/$build_step ) || step_status=$?
            if [ "$step_status" -ne 0 ]
            then
                failed_step="$build_step"
                log_warning "Build step '$build_step' exited $step_status."
                break
            fi
        done

        if [ -z "$failed_step" ]
        then
            log_success "Frontend built (Dock/Static is production-ready)."
            return 0
        fi
        log_warning "Frontend build attempt $attempt failed at '$failed_step' (transient file lock?); retrying in 10s..."
        sleep 10
    done
    log_error "Frontend build failed after 5 attempts (last failing step: $failed_step)."
    return 1
}

# ── Pre-deploy: is the node actually reachable from HERE? ────────────────────
#
# Two things routinely make a deploy fail late, after a bakebox has been created
# and an image captured — expensive, and confusing because the error surfaces as
# an SSH timeout:
#
#   * the environment's Linode is powered OFF (development / testing get parked
#     to save money), so there is nothing to SSH into; and
#   * the machine you are deploying FROM has a different public IP than the one
#     baked into the environment's firewall (dynamic ISP address, a different
#     office, a VPN), so port 22 is dropped for you specifically.
#
# Both are fixed here, up front, using the Linode token already in
# deployment.env — and both are recorded so restore_base_node_access() can put
# the account back exactly as it found it.
ensure_base_node_access()
{
    log_step "Checking that the '$ENVIRONMENT_NAME' base node is up and reachable from this machine..."

    BASE_NODE_INSTANCE_ID="$(linode_find_instance_id_by_label "$(label_for_role Server)")"

    if [ -z "$BASE_NODE_INSTANCE_ID" ]
    then
        log_error "No Linode labelled '$(label_for_role Server)' exists — provision the environment first (provision-environment.sh)."
        return 1
    fi

    # ── Power state ──────────────────────────────────────────────────────────
    local power_status
    power_status="$(linode_get_instance_status "$BASE_NODE_INSTANCE_ID")"
    log_info "Base node $(label_for_role Server) (id=$BASE_NODE_INSTANCE_ID) is '$power_status'."

    if [ "$power_status" != "running" ]
    then
        BASE_NODE_WAS_OFFLINE=1
        log_warning "Base node is not running — booting it for this deploy."
        linode_power_on "$BASE_NODE_INSTANCE_ID" || { log_error "Could not boot the base node."; return 1; }
        log_success "Base node is running."
    fi

    # ── Firewall: is THIS machine allowed to SSH in? ─────────────────────────
    SERVER_FIREWALL_ID="$(linode_find_firewall_id_by_label "$(label_for_role SrvFW)")"

    if [ -z "$SERVER_FIREWALL_ID" ]
    then
        log_warning "No firewall labelled '$(label_for_role SrvFW)' — skipping the allow-list check (nothing is filtering SSH)."
    else
        local admin_cidr
        admin_cidr="$(detect_admin_cidr)"

        if [ "$admin_cidr" = "0.0.0.0/0" ]
        then
            log_error "Could not determine this machine's public IP, so the firewall allow-list cannot be checked safely."
            log_error "Refusing to open SSH to the world. Set ADMIN_SSH_CIDR in deployment.env, or fix outbound access to api.ipify.org."
            return 1
        fi

        log_info "This machine's public address: $admin_cidr"

        local current_rules
        current_rules="$(linode_get_firewall_rules "$SERVER_FIREWALL_ID")"

        if [ "$(printf '%s' "$current_rules" | node "$SCRIPT_DIRECTORY/Library/FirewallAdminAccess.js" check "$admin_cidr")" = "allowed" ]
        then
            log_success "SSH from $admin_cidr is already allowed by $(label_for_role SrvFW)."
        else
            log_warning "SSH from $admin_cidr is NOT allowed by $(label_for_role SrvFW) — granting temporary access for this deploy."

            # Snapshot the EXACT original rules so the revert is a verbatim
            # restore rather than an attempt to undo a diff.
            FIREWALL_RULES_BACKUP_FILE="$(mktemp -t cogniumlearn-fw-XXXXXX.json)"
            printf '%s' "$current_rules" > "$FIREWALL_RULES_BACKUP_FILE"

            local granted_rules
            granted_rules="$(printf '%s' "$current_rules" | node "$SCRIPT_DIRECTORY/Library/FirewallAdminAccess.js" grant "$admin_cidr" "$TEMPORARY_SSH_RULE_LABEL")"

            if ! linode_set_firewall_rules "$SERVER_FIREWALL_ID" "$granted_rules"
            then
                log_error "Could not add the temporary SSH rule to $(label_for_role SrvFW)."
                rm -f "$FIREWALL_RULES_BACKUP_FILE"
                FIREWALL_RULES_BACKUP_FILE=""
                return 1
            fi

            log_success "Temporary rule '$TEMPORARY_SSH_RULE_LABEL' added — it is removed again when this run ends."
            # Firewall changes take a moment to apply at the edge.
            sleep 5
        fi
    fi

    # ── Prove it, rather than assuming ───────────────────────────────────────
    local base_node_target="${BASE_NODE_SSH_USER}@${BASE_NODE_SSH_HOST}"
    log_step "Verifying SSH to $base_node_target..."
    if ! wait_for_ssh "$base_node_target"
    then
        log_error "Still cannot SSH to $base_node_target after booting the node and opening the firewall."
        log_error "Check BASE_NODE_SSH_HOST_${ENVIRONMENT_NAME^^} in deployment.env and the node's own sshd."
        return 1
    fi
    log_success "SSH to the base node works."
}

# Puts back everything ensure_base_node_access changed. Called from the exit
# trap, so it runs on success, on failure, and on Ctrl-C alike. Every step is
# individually guarded — a failure to revert one thing must not stop the others.
restore_base_node_access()
{
    if [ -n "$FIREWALL_RULES_BACKUP_FILE" ] && [ -f "$FIREWALL_RULES_BACKUP_FILE" ]
    then
        log_step "Removing the temporary SSH rule from $(label_for_role SrvFW)..."
        if linode_set_firewall_rules "$SERVER_FIREWALL_ID" "$(cat "$FIREWALL_RULES_BACKUP_FILE")"
        then
            log_success "Firewall rules restored to their original state."
        else
            log_error "COULD NOT RESTORE THE FIREWALL. Rule '$TEMPORARY_SSH_RULE_LABEL' may still allow SSH from your IP."
            log_error "Original rules were saved at: $FIREWALL_RULES_BACKUP_FILE"
            log_error "Restore by hand: PUT /networking/firewalls/${SERVER_FIREWALL_ID}/rules with that file's contents."
            # Deliberately NOT deleted — it is the only copy of the original.
            FIREWALL_RULES_BACKUP_FILE=""
            return
        fi
        rm -f "$FIREWALL_RULES_BACKUP_FILE"
        FIREWALL_RULES_BACKUP_FILE=""
    fi

    if [ "$BASE_NODE_WAS_OFFLINE" -eq 1 ] && [ -n "$BASE_NODE_INSTANCE_ID" ]
    then
        BASE_NODE_WAS_OFFLINE=0

        # Production is never parked on purpose. If it was somehow off and we
        # booted it to deploy, powering it back off would take the site down —
        # leave it running and say so loudly.
        if [ "$ENVIRONMENT_NAME" = "production" ]
        then
            log_warning "PRODUCTION was powered off before this run and was booted to deploy. Leaving it RUNNING."
            log_warning "That is deliberate — shutting it back down would take production offline. Power it off yourself if that was intended."
            return
        fi

        if [ "$KEEP_NODE_RUNNING" -eq 1 ]
        then
            log_info "Base node was offline before this run; leaving it running (--keep-node-running)."
            return
        fi

        log_step "Base node was offline before this run — powering it back off..."
        if linode_power_off "$BASE_NODE_INSTANCE_ID"
        then
            log_success "Base node returned to its original 'offline' state. The deployed code is on disk and will be live when it next boots."
        else
            log_warning "Could not power the base node back off — it is still running (id=$BASE_NODE_INSTANCE_ID)."
        fi
    fi
}

# ── Pre-deploy browser gates ─────────────────────────────────────────────────
#
# Three Puppeteer suites drive the REAL UI against the freshly-built bundle
# before anything is baked or shipped. ALL THREE ARE PRODUCTION-ONLY:
#
#   * Tutorial walkthrough  — the guided tours click real tiles, menu entries,
#     popups and editors, which makes them the first thing a frontend change
#     breaks, and the breakage is invisible in code review: a renamed class, a
#     new intermediate popup, or a page that mounts one element differently is
#     enough to strand a user mid-tour. The Beginners tour also auto-plays on
#     first launch, so a broken tour is the first thing a new user sees.
#
#   * Critical user flows   — PRODUCTION only. 25 everyday operations (create /
#     rename / nest / delete decks, author and edit cards and study materials,
#     browse and search them, every study mode, persistence across a reload).
#     Slower and more data-churning than the tour walk, so it gates the one
#     environment where a regression reaches real users.
#
#   * Synchronisation       — PRODUCTION only. 19 cases across THREE independent
#     devices (separate browser contexts, so separate device ids, sync logs and
#     IndexedDB copies): push, cross-device pull, deletion propagation, offline
#     queueing, a multi-chunk drain of a seeded 260-card library, and
#     convergence. Every case is asserted against MongoDB as well as the screen,
#     because a broken sync still renders a tidy "Synced ✓".
#
# Both need (see Deployment.md §1.1.1):
#   - Redis + MongoDB reachable per Dock/.env  (the same stack local dev uses)
#   - TUTORIAL_TEST_SESSION_COOKIE in deployment.env — a sessionId for a seeded,
#     terms-accepted LOCAL test account. Never a production session: the suites
#     create and delete decks on whatever account they run as.
run_browser_test_gates()
{
    # Production is the ONLY environment these run on. Development and testing
    # exist to be deployed to often and exercised by hand; paying the gates'
    # wall-clock on every roll-out there discourages exactly that, and a
    # regression caught on them reaches nobody but us. Production is the one
    # environment where a regression reaches real users, so it is the one that
    # pays. Accepted cost: a broken tour is not caught until the production
    # deploy that ships it — run the suites by hand (the run-browser-gates
    # skill) after a frontend change if that signal is wanted earlier.
    if [ "$ENVIRONMENT_NAME" != "production" ]
    then
        log_info "Browser gates are production-only — skipping them for '$ENVIRONMENT_NAME' (Deployment.md §1.1.1)."
        return 0
    fi

    if [ "$SKIP_TUTORIAL_TESTS" -eq 1 ]
    then
        log_warning "Skipping the browser test gates (--skip-tutorial-tests). Frontend regressions in the guided tours and everyday flows will NOT be caught."
        return 0
    fi

    if [ -z "${TUTORIAL_TEST_SESSION_COOKIE:-}" ]
    then
        log_error "TUTORIAL_TEST_SESSION_COOKIE is not set in deployment.env — the browser test gates cannot run."
        log_error "Set it to a sessionId for a seeded, terms-accepted LOCAL test account (see Deployment.md §1.1.1),"
        log_error "or pass --skip-tutorial-tests to deploy without the gates."
        return 1
    fi

    local test_directory="$REPOSITORY_ROOT/Common/Testing/Main"
    if [ ! -d "$test_directory/node_modules" ]
    then
        log_step "Installing the browser-test dependencies (Puppeteer)..."
        ( cd "$test_directory" && npm install --no-audit --no-fund ) || { log_error "npm install failed in $test_directory."; return 1; }
    fi

    local base_url="${TUTORIAL_TEST_BASE_URL:-http://127.0.0.1:3000}"
    local started_dock=0
    local dock_log="$REPOSITORY_ROOT/Common/Reports/.results/browser-gate-dock.log"
    mkdir -p "$(dirname "$dock_log")"

    # Reuse an already-running server when the operator has one up; otherwise
    # start our own. Dock indexes Dock/Static ONCE at boot, so a server that was
    # running before build_frontend would still be serving the previous bundle's
    # (now deleted) chunk files — always start a fresh one in that case.
    if curl -sf -o /dev/null --max-time 3 "$base_url/index.html"
    then
        log_warning "A server is already responding at $base_url — reusing it. Restart it if it predates this build, or it will serve stale bundle chunks."
    else
        log_step "Starting a local Dock for the browser test gates..."
        # --environment=local is mandatory, not cosmetic. A bare `node index.js`
        # resolves to the PRODUCTION environment (Dock/index.js: no flag, no
        # COGNIUMLEARN_ENVIRONMENT -> "production"), which would point the gate
        # at the production database — and these suites create and delete decks
        # on whatever account they run as. The gate must only ever touch the
        # local stack.
        ( cd "$REPOSITORY_ROOT/Dock" && node index.js --environment=local >"$dock_log" 2>&1 ) &
        TUTORIAL_GATE_DOCK_PID=$!
        started_dock=1

        local waited=0
        until curl -sf -o /dev/null --max-time 3 "$base_url/index.html"
        do
            waited=$((waited + 1))
            if [ "$waited" -gt 40 ]
            then
                log_error "Dock did not come up at $base_url within 40s. Last lines of $dock_log:"
                tail -n 20 "$dock_log" >&2 || true
                log_error "The browser gates need Redis + MongoDB running locally (same as 'npm run web')."
                return 1
            fi
            sleep 1
        done
    fi

    local gate_status=0

    run_browser_suite "Tutorial walkthrough" "Common/Testing/Main/run_tutorial_ui_tests.js" "$REPOSITORY_ROOT/Common/Reports/.results/tutorial-ui.json" "$base_url" || gate_status=1

    # The critical-flow suite writes and deletes a lot more than the tour walk,
    # and it is the last line before real users.
    if [ "$gate_status" -eq 0 ]
    then
        run_browser_suite "Critical user flows" "Common/Testing/Main/run_critical_flow_tests.js" "$REPOSITORY_ROOT/Common/Reports/.results/critical-flow-ui.json" "$base_url" || gate_status=1
    fi

    # The sync suite matters more than any of the others: sync is where a
    # regression DESTROYS data rather than merely breaking a screen. It drives
    # three independent devices, seeds a library large enough to force the
    # server's chunked pull, and asserts every browser-visible outcome against
    # MongoDB — so it is also the slowest of the three.
    if [ "$gate_status" -eq 0 ]
    then
        run_browser_suite "Synchronisation" "Common/Testing/Main/run_sync_ui_tests.js" "$REPOSITORY_ROOT/Common/Reports/.results/sync-ui.json" "$base_url" || gate_status=1
    fi

    # Organization surfaces — membership, delegated powers, the spend report and
    # the engagement report. None of it was covered by any browser suite while
    # carrying the features an institute pays for.
    if [ "$gate_status" -eq 0 ]
    then
        run_browser_suite "Organization" "Common/Testing/Main/run_organization_ui_tests.js" "$REPOSITORY_ROOT/Common/Reports/.results/organization-ui.json" "$base_url" || gate_status=1
    fi

    # The paid-deck lifecycle, and specifically the pair that has to hold in
    # both directions: a held deck refuses deletion by default, and a forced
    # deletion revokes every licence in the same operation. Forcing without
    # revoking would leave buyers holding an entitlement to content that no
    # longer exists — which fails silently, and only for them.
    if [ "$gate_status" -eq 0 ]
    then
        run_browser_suite "Paid decks" "Common/Testing/Main/run_paid_deck_ui_tests.js" "$REPOSITORY_ROOT/Common/Reports/.results/paid-deck-ui.json" "$base_url" || gate_status=1
    fi

    if [ "$started_dock" -eq 1 ]
    then
        log_step "Stopping the browser-gate Dock..."
        kill "$TUTORIAL_GATE_DOCK_PID" 2>/dev/null || true
        wait "$TUTORIAL_GATE_DOCK_PID" 2>/dev/null || true
        TUTORIAL_GATE_DOCK_PID=""
    fi

    return "$gate_status"
}

# Runs one Puppeteer suite and reads its verdict out of the result JSON.
# A SKIPPED verdict fails the gate just like a FAIL: it means the suite never
# proved the behaviour, which is not something to deploy on.
#
# Every suite is run under a hard `timeout`. A Puppeteer suite CAN hang — a wait
# on something that never arrives (a sync modal that never clears, a page that
# never settles) is an infinite loop, not a slow test — and a hung gate is worse
# than a red one: the deploy waits on it forever, produces no result file, and
# nobody learns anything. The ceiling is deliberately generous; it is a
# backstop, not a performance budget. Override with BROWSER_SUITE_TIMEOUT_MINUTES.
run_browser_suite()
{
    local suite_label="$1"
    local suite_script="$2"
    local result_file="$3"
    local base_url="$4"

    local suite_timeout_minutes="${BROWSER_SUITE_TIMEOUT_MINUTES:-45}"

    log_step "$suite_label — driving Chromium against the freshly-built bundle (${suite_timeout_minutes}m ceiling)..."

    local suite_exit=0
    (
        cd "$REPOSITORY_ROOT"
        BASE_URL="$base_url" TEST_SESSION_COOKIE="$TUTORIAL_TEST_SESSION_COOKIE" VERBOSE=1 \
            timeout --signal=KILL "${suite_timeout_minutes}m" node "$suite_script"
    ) || suite_exit=$?

    # 137 is SIGKILL, i.e. the timeout fired. Call that out specifically: a
    # hang and a crash need completely different investigation.
    if [ "$suite_exit" -eq 137 ] || [ "$suite_exit" -eq 124 ]
    then
        log_error "$suite_label: HUNG — killed after ${suite_timeout_minutes} minutes without finishing."
        log_error "This is not a slow suite; something is waiting on a condition that never becomes true."
        log_error "Check Redis and MongoDB latency first (the sync engine stalls the whole app when either is slow),"
        log_error "then $result_file for the last case that reported."
        return 1
    fi

    if [ "$suite_exit" -ne 0 ]
    then
        log_error "$suite_label: the suite errored."
        return 1
    fi

    local result_status
    result_status="$(node -e "try{process.stdout.write(require(process.argv[1]).status||'MISSING')}catch(error){process.stdout.write('MISSING')}" "$result_file")"

    if [ "$result_status" != "PASS" ]
    then
        log_error "$suite_label gate: $result_status — deployment aborted."
        log_error "Full per-case detail: $result_file"
        return 1
    fi

    log_success "$suite_label gate: passed."
    return 0
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
    context_archive="$(mktemp -t cogniumlearn-agent-context.XXXXXX.tar.gz)"
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
    NEW_IMAGE_ID="$(linode_capture_image "$disk_id" "$NEW_IMAGE_LABEL" "CogniumLearn ${ENVIRONMENT_NAME} burst worker image, version ${NEW_IMAGE_VERSION}")"
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

    log_step "Uploading the Agent + Dock + Common runtime contexts to the base node..."
    local agent_archive dock_archive common_archive
    agent_archive="$(mktemp -t cogniumlearn-agent-context.XXXXXX.tar.gz)"
    dock_archive="$(mktemp -t cogniumlearn-dock-context.XXXXXX.tar.gz)"
    common_archive="$(mktemp -t cogniumlearn-common-context.XXXXXX.tar.gz)"
    ( cd "$REPOSITORY_ROOT" && build_agent_context "$agent_archive" && build_dock_context "$dock_archive" && build_common_runtime_context "$common_archive" )
    copy_over_scp "$agent_archive" "${base_node_target}:/tmp/cogniumlearn-agent-context.tar.gz"
    copy_over_scp "$dock_archive" "${base_node_target}:/tmp/cogniumlearn-dock-context.tar.gz"
    copy_over_scp "$common_archive" "${base_node_target}:/tmp/cogniumlearn-common-context.tar.gz"
    rm -f "$agent_archive" "$dock_archive" "$common_archive"

    log_step "Refreshing Agent + Dock code, image pointer + restarting Dock for '$ENVIRONMENT_NAME'..."
    run_ssh "$base_node_target" \
        "REPO_DIR='$BASE_NODE_REPO_DIR' \
         AGENT_CONTEXT_ARCHIVE='/tmp/cogniumlearn-agent-context.tar.gz' \
         DOCK_CONTEXT_ARCHIVE='/tmp/cogniumlearn-dock-context.tar.gz' \
         COMMON_CONTEXT_ARCHIVE='/tmp/cogniumlearn-common-context.tar.gz' \
         NEW_IMAGE_ID='$image_id_to_set' \
         DOCK_ENV_FILE='$(dock_environment_file_name)' \
         COGNIUMLEARN_ENVIRONMENT='$ENVIRONMENT_NAME' \
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
            --skip-tutorial-tests) SKIP_TUTORIAL_TESTS=1 ;;
            --keep-node-running) KEEP_NODE_RUNNING=1 ;;
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

    # Reachability BEFORE anything expensive: a parked Linode or a firewall that
    # does not know this machine's IP would otherwise surface as an SSH timeout
    # after a bakebox has been created and an image captured. Skipped when we
    # are not touching the node at all.
    if [ "$SKIP_BASE_UPDATE" -eq 0 ]
    then
        ensure_base_node_access || exit 1
    fi

    # The frontend is built on EVERY environment, here rather than inside the
    # gates or update_base_node. Three reasons: the production suites must drive
    # the exact bundle that ships; update_base_node must not rebuild it; and
    # building here keeps the Windows "file changed as we read it" tar race away
    # from a freshly-rewritten Dock/Static, which is what happens when the build
    # sits immediately before build_dock_context.
    if [ "$SKIP_FRONTEND_BUILD" -eq 0 ]
    then
        build_frontend || exit 1
        SKIP_FRONTEND_BUILD=1
    else
        log_warning "Skipping frontend build (--skip-frontend-build)."
    fi

    # Gate SECOND (production only): a broken tour or flow should cost nothing
    # but the run itself — no bakebox spun up, no image captured, nothing
    # shipped to the base node.
    run_browser_test_gates || exit 1

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
