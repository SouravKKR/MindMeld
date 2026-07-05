#!/usr/bin/env bash
#
# Linode API v4 helpers for the deployment orchestrator. Sourced by deploy.sh.
# Every function returns a non-zero status (and logs) on API failure so the
# orchestrator's `set -e` aborts the run rather than continuing on bad data.
#
# Requires (exported by deploy.sh before sourcing): LINODE_API_TOKEN, and the
# Logging.sh helpers. JSON parsing is delegated to Library/JsonQuery.js via Node.

LINODE_API_BASE_URL="https://api.linode.com/v4"
DEPLOYMENT_LIBRARY_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JSON_QUERY_SCRIPT="$DEPLOYMENT_LIBRARY_DIRECTORY/JsonQuery.js"

# Pipe a JSON document on stdin into the Node query helper.
json_query()
{
    node "$JSON_QUERY_SCRIPT" "$@"
}

# Low-level request. Prints the response body to stdout; returns non-zero (and logs
# the error body) on any non-2xx status. Usage: linode_request METHOD /path [jsonBody]
linode_request()
{
    local method="$1"
    local path_suffix="$2"
    local request_body="${3:-}"

    local curl_arguments=(
        --silent --show-error
        --request "$method"
        --header "Authorization: Bearer ${LINODE_API_TOKEN}"
        --header "Content-Type: application/json"
        --write-out $'\n%{http_code}'
    )

    if [ -n "$request_body" ]
    then
        curl_arguments+=(--data "$request_body")
    fi

    local response
    response="$(curl "${curl_arguments[@]}" "${LINODE_API_BASE_URL}${path_suffix}")"

    local status_code response_body
    status_code="$(printf '%s' "$response" | tail -n 1)"
    response_body="$(printf '%s' "$response" | sed '$d')"

    if [ "$status_code" -lt 200 ] || [ "$status_code" -ge 300 ]
    then
        log_error "Linode API $method $path_suffix failed (HTTP $status_code): $response_body"
        return 1
    fi

    printf '%s' "$response_body"
}

# Print the highest existing MindMeldBurstVmImage<version> number (0 if none).
linode_get_highest_image_version()
{
    local label_prefix="$1"
    linode_request GET "/images?page_size=500" | json_query maxImageVersion "$label_prefix"
}

# Print the id of the highest-version managed image (blank if none exist yet).
linode_get_highest_image_id()
{
    local label_prefix="$1"
    linode_request GET "/images?page_size=500" | json_query highestImageId "$label_prefix"
}

# Print (newline-separated) the ids of every managed image with version < keepVersion.
linode_get_older_image_ids()
{
    local label_prefix="$1"
    local keep_version="$2"
    linode_request GET "/images?page_size=500" | json_query olderImageIds "$label_prefix" "$keep_version"
}

# Create a Linode and print its numeric id. Reads the public key from the path in $1.
linode_create_bakebox()
{
    local public_key_path="$1"
    local label="$2"
    local region="$3"
    local instance_type="$4"
    local base_image="$5"
    local management_tag="$6"

    local public_key_contents
    public_key_contents="$(cat "$public_key_path")"

    # A throwaway root password is required by the API even when SSH keys are supplied.
    local throwaway_root_password
    throwaway_root_password="$(node -e "console.log(require('crypto').randomBytes(24).toString('base64') + 'Aa1!')")"

    local request_body
    request_body="$(node -e '
        const [label, region, type, image, tag, key, rootPass] = process.argv.slice(1);
        process.stdout.write(JSON.stringify({
            label,
            region,
            type,
            image,
            tags: [tag],
            booted: true,
            root_pass: rootPass,
            authorized_keys: [key.trim()]
        }));
    ' "$label" "$region" "$instance_type" "$base_image" "$management_tag" "$public_key_contents" "$throwaway_root_password")"

    linode_request POST "/linode/instances" "$request_body" | json_query field "id"
}

# Print a Linode's public IPv4 address (the first non-private address).
linode_get_public_ipv4()
{
    local instance_id="$1"
    linode_request GET "/linode/instances/${instance_id}" | node -e '
        let input = "";
        process.stdin.on("data", chunk => input += chunk);
        process.stdin.on("end", () =>
        {
            const instance = JSON.parse(input);
            const addresses = Array.isArray(instance.ipv4) ? instance.ipv4 : [];
            const isPrivate = (address) => address.startsWith("10.") || address.startsWith("192.168.") || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(address);
            const publicAddress = addresses.find(address => !isPrivate(address)) || "";
            process.stdout.write(publicAddress);
        });
    '
}

# Block until a Linode reports the requested status, or fail after timeout seconds.
linode_wait_for_status()
{
    local instance_id="$1"
    local desired_status="$2"
    local timeout_seconds="${3:-300}"

    local elapsed_seconds=0
    while [ "$elapsed_seconds" -lt "$timeout_seconds" ]
    do
        local current_status
        current_status="$(linode_request GET "/linode/instances/${instance_id}" | json_query field "status")"

        if [ "$current_status" = "$desired_status" ]
        then
            return 0
        fi

        sleep 5
        elapsed_seconds=$((elapsed_seconds + 5))
    done

    log_error "Linode ${instance_id} did not reach status '${desired_status}' within ${timeout_seconds}s."
    return 1
}

# Print the id of the ext4 root disk of a Linode (skips the swap disk).
linode_get_ext4_disk_id()
{
    local instance_id="$1"
    linode_request GET "/linode/instances/${instance_id}/disks" | json_query ext4DiskId
}

# Print a disk's current status (e.g. "ready", "resizing").
linode_get_disk_status()
{
    local instance_id="$1"
    local disk_id="$2"
    linode_request GET "/linode/instances/${instance_id}/disks/${disk_id}" | json_query field "status"
}

# Shut a Linode down and wait until it is offline.
linode_power_off()
{
    local instance_id="$1"
    linode_request POST "/linode/instances/${instance_id}/shutdown" "{}" >/dev/null
    linode_wait_for_status "$instance_id" "offline" 180
}

# Resize an (offline) disk and wait for it to be ready again.
linode_resize_disk()
{
    local instance_id="$1"
    local disk_id="$2"
    local size_in_megabytes="$3"

    linode_request POST "/linode/instances/${instance_id}/disks/${disk_id}/resize" "{\"size\": ${size_in_megabytes}}" >/dev/null

    local elapsed_seconds=0
    while [ "$elapsed_seconds" -lt 300 ]
    do
        if [ "$(linode_get_disk_status "$instance_id" "$disk_id")" = "ready" ]
        then
            return 0
        fi
        sleep 5
        elapsed_seconds=$((elapsed_seconds + 5))
    done

    log_error "Disk ${disk_id} did not return to 'ready' after resize within 300s."
    return 1
}

# Capture an image from a disk and print the new image id (e.g. private/12345678).
linode_capture_image()
{
    local disk_id="$1"
    local label="$2"
    local description="$3"
    linode_request POST "/images" "{\"disk_id\": ${disk_id}, \"label\": \"${label}\", \"description\": \"${description}\"}" | json_query field "id"
}

# Block until an image reaches 'available', or fail after timeout seconds.
linode_wait_for_image_available()
{
    local image_id="$1"
    local timeout_seconds="${2:-1200}"

    local elapsed_seconds=0
    while [ "$elapsed_seconds" -lt "$timeout_seconds" ]
    do
        local image_status
        image_status="$(linode_request GET "/images/${image_id}" | json_query field "status")"

        if [ "$image_status" = "available" ]
        then
            return 0
        fi

        if [ "$image_status" = "" ]
        then
            # A capture that exceeds the size cap deletes itself mid-creation, so the
            # image 404s. Surface that clearly rather than spinning to the timeout.
            log_error "Image ${image_id} disappeared during creation — it likely exceeded the 6 GB cap."
            return 1
        fi

        sleep 10
        elapsed_seconds=$((elapsed_seconds + 10))
    done

    log_error "Image ${image_id} did not reach 'available' within ${timeout_seconds}s."
    return 1
}

linode_delete_instance()
{
    local instance_id="$1"
    linode_request DELETE "/linode/instances/${instance_id}" >/dev/null
}

linode_delete_image()
{
    local image_id="$1"
    linode_request DELETE "/images/${image_id}" >/dev/null
}

linode_delete_firewall()
{
    local firewall_id="$1"
    linode_request DELETE "/networking/firewalls/${firewall_id}" >/dev/null
}

linode_delete_vpc()
{
    local vpc_id="$1"
    linode_request DELETE "/vpcs/${vpc_id}" >/dev/null
}

# ── Multi-environment provisioning helpers ────────────────────────────────────
# Every mutating helper below honours LINODE_DRY_RUN=1 (set by the orchestrator):
# it logs what it WOULD do, makes no API write, and prints a "DRYRUN-…" sentinel
# so callers keep flowing without a real id. Look-ups (GET) always run for real —
# they are read-only and let a dry run report exactly which resources exist.
LINODE_DRY_RUN="${LINODE_DRY_RUN:-0}"

linode_is_dry_run()
{
    [ "$LINODE_DRY_RUN" = "1" ]
}

# ── Look-ups (read-only) ──────────────────────────────────────────────────────
linode_find_instance_id_by_label()
{
    linode_request GET "/linode/instances?page_size=500" | json_query idByLabel "$1"
}

linode_find_instance_rows_by_prefix()
{
    linode_request GET "/linode/instances?page_size=500" | json_query rowsByLabelPrefix "$1"
}

linode_find_instance_ids_by_prefix()
{
    linode_request GET "/linode/instances?page_size=500" | json_query idsByLabelPrefix "$1"
}

linode_find_vpc_id_by_label()
{
    linode_request GET "/vpcs?page_size=500" | json_query idByLabel "$1"
}

linode_find_vpc_subnet_id()
{
    linode_request GET "/vpcs?page_size=500" | json_query subnetIdForVpcLabel "$1"
}

linode_find_firewall_id_by_label()
{
    linode_request GET "/networking/firewalls?page_size=500" | json_query idByLabel "$1"
}

linode_find_firewall_ids_by_prefix()
{
    linode_request GET "/networking/firewalls?page_size=500" | json_query idsByLabelPrefix "$1"
}

linode_find_image_id_by_label()
{
    linode_request GET "/images?page_size=500" | json_query idByLabel "$1"
}

linode_find_image_ids_by_prefix()
{
    linode_request GET "/images?page_size=500" | json_query idsByLabelPrefix "$1"
}

# ── Ensure (create-if-absent, idempotent) ─────────────────────────────────────
# Ensure a VPC + its single subnet exist. Prints "<vpcId> <subnetId>".
linode_ensure_vpc()
{
    local vpc_label="$1"
    local region="$2"
    local subnet_label="$3"
    local subnet_cidr="$4"

    local existing_vpc_id
    existing_vpc_id="$(linode_find_vpc_id_by_label "$vpc_label")"
    if [ -n "$existing_vpc_id" ]
    then
        local existing_subnet_id
        existing_subnet_id="$(linode_find_vpc_subnet_id "$vpc_label")"
        log_info "VPC '$vpc_label' already exists (id=$existing_vpc_id, subnet=$existing_subnet_id)." >&2
        printf '%s %s' "$existing_vpc_id" "$existing_subnet_id"
        return 0
    fi

    if linode_is_dry_run
    then
        log_info "[dry-run] Would create VPC '$vpc_label' in $region with subnet $subnet_cidr." >&2
        printf 'DRYRUN-VPC DRYRUN-SUBNET'
        return 0
    fi

    local request_body
    request_body="$(node -e '
        const [label, region, subnetLabel, subnetCidr] = process.argv.slice(1);
        process.stdout.write(JSON.stringify({ label, region, subnets: [{ label: subnetLabel, ipv4: subnetCidr }] }));
    ' "$vpc_label" "$region" "$subnet_label" "$subnet_cidr")"

    local response
    response="$(linode_request POST "/vpcs" "$request_body")"
    printf '%s %s' "$(printf '%s' "$response" | json_query field id)" "$(printf '%s' "$response" | json_query field subnets.0.id)"
}

# Ensure a firewall exists with the given rules. On an existing firewall the rules
# are re-applied (reconciles drift). Prints the firewall id (or a sentinel in dry-run).
linode_ensure_firewall()
{
    local firewall_label="$1"
    local rules_json="$2"
    local management_tag="$3"

    local existing_firewall_id
    existing_firewall_id="$(linode_find_firewall_id_by_label "$firewall_label")"
    if [ -n "$existing_firewall_id" ]
    then
        if linode_is_dry_run
        then
            log_info "[dry-run] Firewall '$firewall_label' exists (id=$existing_firewall_id); would re-apply rules." >&2
        else
            linode_request PUT "/networking/firewalls/${existing_firewall_id}/rules" "$rules_json" >/dev/null
            log_info "Firewall '$firewall_label' exists (id=$existing_firewall_id); rules re-applied." >&2
        fi
        printf '%s' "$existing_firewall_id"
        return 0
    fi

    if linode_is_dry_run
    then
        log_info "[dry-run] Would create firewall '$firewall_label'." >&2
        printf 'DRYRUN-FW'
        return 0
    fi

    local request_body
    request_body="$(node -e '
        const [label, tag, rules] = process.argv.slice(1);
        process.stdout.write(JSON.stringify({ label, tags: [tag], rules: JSON.parse(rules) }));
    ' "$firewall_label" "$management_tag" "$rules_json")"

    linode_request POST "/networking/firewalls" "$request_body" | json_query field id
}

# Idempotently attach a Linode to a firewall (no-op if already attached).
linode_ensure_firewall_device()
{
    local firewall_id="$1"
    local instance_id="$2"

    case "$firewall_id$instance_id" in
        *DRYRUN*) return 0 ;;
    esac
    if linode_is_dry_run
    then
        log_info "[dry-run] Would attach instance $instance_id to firewall $firewall_id." >&2
        return 0
    fi

    local existing_device_id
    existing_device_id="$(linode_request GET "/networking/firewalls/${firewall_id}/devices" | json_query firewallLinodeDeviceId "$instance_id")"
    if [ -n "$existing_device_id" ]
    then
        return 0
    fi
    linode_request POST "/networking/firewalls/${firewall_id}/devices" "{\"id\": ${instance_id}, \"type\": \"linode\"}" >/dev/null
}

# Ensure an instance with the given label exists. bodyJson is the full create body
# (built by the orchestrator via node) minus the label, which is injected here.
# Prints the instance id (existing or newly created, or a sentinel in dry-run).
linode_ensure_instance()
{
    local instance_label="$1"
    local body_json="$2"

    local existing_instance_id
    existing_instance_id="$(linode_find_instance_id_by_label "$instance_label")"
    if [ -n "$existing_instance_id" ]
    then
        log_info "Instance '$instance_label' already exists (id=$existing_instance_id)." >&2
        printf '%s' "$existing_instance_id"
        return 0
    fi

    if linode_is_dry_run
    then
        log_info "[dry-run] Would create instance '$instance_label'." >&2
        printf 'DRYRUN-INSTANCE'
        return 0
    fi

    local request_body
    request_body="$(node -e '
        const [label, body] = process.argv.slice(1);
        process.stdout.write(JSON.stringify({ ...JSON.parse(body), label }));
    ' "$instance_label" "$body_json")"

    linode_request POST "/linode/instances" "$request_body" | json_query field id
}

# ── Rename + tag (metadata only; used to migrate legacy production labels) ─────
# collection is the API path segment: "linode/instances", "vpcs",
# "networking/firewalls" or "images".
linode_rename_entity()
{
    local collection="$1"
    local entity_id="$2"
    local new_label="$3"

    if linode_is_dry_run
    then
        log_info "[dry-run] Would rename ${collection}/${entity_id} -> '$new_label'." >&2
        return 0
    fi
    linode_request PUT "/${collection}/${entity_id}" "{\"label\": \"${new_label}\"}" >/dev/null
}

# Merge a tag into an instance's existing tag set (instances, firewalls and images
# support tags; VPCs are matched by label instead).
linode_add_tag()
{
    local collection="$1"
    local entity_id="$2"
    local tag="$3"

    if linode_is_dry_run
    then
        log_info "[dry-run] Would add tag '$tag' to ${collection}/${entity_id}." >&2
        return 0
    fi

    local current_tags_json merged_body
    current_tags_json="$(linode_request GET "/${collection}/${entity_id}" | node -e '
        let input = ""; process.stdin.on("data", chunk => input += chunk);
        process.stdin.on("end", () => { const tags = (JSON.parse(input).tags) || []; process.stdout.write(JSON.stringify(tags)); });
    ')"
    merged_body="$(node -e '
        const [tagsJson, tag] = process.argv.slice(1);
        const tags = JSON.parse(tagsJson);
        if (!tags.includes(tag)) { tags.push(tag); }
        process.stdout.write(JSON.stringify({ tags }));
    ' "$current_tags_json" "$tag")"
    linode_request PUT "/${collection}/${entity_id}" "$merged_body" >/dev/null
}
