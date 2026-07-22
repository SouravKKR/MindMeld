# Automated burst-worker deployment

One command bakes a fresh burst-worker Image, rolls it out to the base node, and
cleans up after itself. It automates the manual flow in
[Deployment.md](../ReadmeFiles/Deployment.md) §1.10 + §2.1–§2.2.

```bash
# from the repo root, on your dev box (Git Bash):
bash Common/Deployment/deploy.sh
```

## What it does

1. Creates a throwaway Debian 12 **bakebox** Linode (tagged `cogniumlearn-bakebox`).
2. Uploads the `Agent/` build context (excludes the venv, caches and `*.env` secrets).
3. Builds the `cogniumlearn-agent` Docker image and installs the worker systemd unit.
4. Wipes the containerd cache + trims the OS so the disk fits Linode's 6 GB Image cap.
5. Powers off, shrinks the disk to 6144 MB, and captures **`CogniumLearnBurstVmImage<version>`**
   (version = highest existing + 1).
6. SSHes into the always-on **base node** and refreshes the Agent code + venv.
7. Writes the new image id into the base node's `Dock/.production.env`
   (`BURST_IMAGE_ID`), ensures Dock + cloudflared run as services (idempotent), and
   restarts Dock — so the live fleet immediately boots the new image.
8. Deletes the bakebox and any **older** `CogniumLearnBurstVmImage<version>` images.
9. Prints a summary and (if `NOTIFY_WEBHOOK_URL` is set) POSTs it.

On any failure before step 8 the bakebox is **left running** for inspection; the
console prints its IP and the one-liner to delete it.

## Why a bash orchestrator (not Packer/Terraform)

Linode's Image capture requires the disk to be **≤ 6 GB** (stock is 25 GB), so the
mandatory step is **power off → resize disk to 6144 MB → capture** against the Linode
API. Packer's Linode builder can't resize a disk before capture, so the cap-critical
path has to be API-driven regardless. A single, auditable shell orchestrator does the
whole flow reliably with no extra toolchain to install. See Deployment.md §1.10.

## Configuration

All settings live in **`deployment.env`** at the repo root (gitignored). Copy a
Linode API token, your SSH key paths, and the base-node host into it — every field is
documented inline in that file.

## Flags

| Flag | Effect |
|------|--------|
| *(none)* | Full bake → frontend build → roll-out → cleanup. |
| `--skip-base-update` | Bake + capture only; don't touch the base node or delete old images. |
| `--skip-frontend-build` | Don't rebuild `Dock/Static`; ship it as-is (use if you already built). |
| `--cleanup-bakeboxes` | Delete stray `cogniumlearn-bakebox` Linodes from a failed run, then exit. |
| `--help` | Usage. |

## Files

| File | Role |
|------|------|
| `deploy.sh` | Orchestrator — runs the 9 steps from the dev box. |
| `Library/LinodeApi.sh` | Linode API v4 helpers (create / wait / resize / capture / delete). |
| `Library/JsonQuery.js` | jq-free JSON extraction via Node (version math, disk lookup). |
| `Library/Logging.sh` | Console logging helpers. |
| `Remote/BakeboxProvision.sh` | Runs on the bakebox: build image, install worker unit, trim disk. |
| `Remote/BaseNodeUpdate.sh` | Runs on the base node: refresh Agent, set image id, ensure services, restart Dock. |
