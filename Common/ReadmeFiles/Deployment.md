# CogniumLearn Deployment Guide

This is the complete, start-to-finish guide for deploying CogniumLearn to production on
Linode — the Dock web server, the Agent task processor, the burst worker fleet, and
scheduled maintenance. It is organized **by machine, in the exact order you should
do things**.

There are four sections:

- **[Section 0 — Environments](#section-0--environments-read-this-first)** — the four
  isolated environments (local / development / testing / production) and how to spin any
  of them up or tear it down on demand, idempotently, with the `manage-environment` skill.
- **[Section 1 — Initial deployment](#section-1--initial-deployment)** — the per-machine
  mechanics to go from nothing to a running server (what the automation runs under the hood).
- **[Section 2 — Update deployment](#section-2--update-deployment)** — how to push
  changes to an environment afterwards.
- **[Section 3 — Desktop & mobile app distribution](#section-3--desktop--mobile-app-distribution)** —
  building, signing and serving the installable desktop/mobile apps.

Read [Concepts](#concepts) first — it defines the machines and terms used throughout — then
**[Section 0](#section-0--environments-read-this-first)** for the multi-environment model.

> **Local build/run commands.** On your dev box the repo root is an npm package:
> `npm run setup` runs the full aggressive frontend build, `npm run web` builds then
> starts Dock with `--debug`, and `npm run production` builds then starts Dock **without**
> `--debug` (the local equivalent of the base-node systemd command). The production
> deploy paths below — `Common/Deployment/deploy.sh`, the base-node build steps, and the
> systemd unit — invoke the individual `Common/Scripts/*` node scripts **directly** and
> are **unchanged** by the npm launcher; they never depended on the old `setup.bat`.

---

## Concepts

### The machines

| Machine | Role |
|---------|------|
| **Dev workstation** (your Windows PC) | Where you write code, run `npm run setup`, and build the worker Docker image. |
| **Base node** (a strong Linode) | Always-on. Runs the Dock web server, MongoDB, Redis, and a warm baseline of Agent workers. Provisioned by hand. |
| **Burst VMs** (cheap Linodes) | Created/destroyed automatically by the autoscaler under load. Run only the Agent worker container. |
| **Image-bake box** (a throwaway Linode) | Used once to produce the burst VM's custom Image. Deleted afterwards. |

### How task processing works

By default Dock runs Agent tasks as **local Python subprocesses**. In production you
enable **distributed mode**, where:

- Dock pushes tasks onto a **Redis queue** (`TaskQueue/pending`) and polls for each
  task's terminal status.
- **Long-lived workers** (`Agent/Worker.py`) drain that queue — a few always on the
  base node (the `LocalWorkerSupervisor`), plus burst VMs.
- The **`BurstAutoscaler`** polls the queue depth every interval and creates/destroys
  burst VMs to match load, never exceeding a **hard cap** (so it can't overspend).
  On startup it deletes all burst VMs first, so a restart never inherits stray ones.

Distributed mode is active only when the server runs **without `--debug`** **and**
`DOCK_USE_TASK_QUEUE=1`. Otherwise tasks run locally as before.

### Scheduled maintenance

An admin can schedule maintenance windows (Admin Panel → Maintenance). During an
active window the server blocks **new** AI work (generation, AskAi, mock-test LLM
grading, deck analysis) with an HTTP `503` and a "check back at \<time\>" message,
**without disrupting tasks already running**. Users see an advance-notice banner.

### Architecture

```
                        ┌─────────────────────── Base node (strong, always on) ─────────────────────┐
   user request         │  systemd → node Dock/index.js   (NO --debug)                              │
        │               │   ├─ TaskManager.execute(): enqueue → Redis TaskQueue/pending, then poll  │
        ▼               │   ├─ LocalWorkerSupervisor → AGENT_LOCAL_WORKER_COUNT worker processes     │
   /Generate ───────────┼──▶│   └─ BurstAutoscaler → polls queue depth, creates/destroys burst VMs   │
   /AskAi/...           │  MongoDB + Redis  (bound to the VPC private IP)                            │
                        └───────────────────────────────────┬───────────────────────────────────────┘
                                                             │ Linode VPC (private network)
                            ┌─────────────────────────────────┴─────────────────────────────┐
                            ▼                                                                 ▼
                 Burst VM → docker: cogniumlearn-agent                            Burst VM → docker: cogniumlearn-agent
                  └─ Worker.py polls the queue                                 └─ Worker.py polls the queue
```

---

# Section 0 — Environments (read this first)

CogniumLearn runs in **four fully-isolated environments**. Everything in Sections 1–2 below
describes the per-machine mechanics for **one** environment; this section explains how the
four are kept separate and how to stand any of them up or tear it down **on demand and
idempotently** with the `manage-environment` skill (which drives the orchestrators under
`Common/Deployment/`).

| Environment | Domain | Base node | Mongo | How it's built |
|---|---|---|---|---|
| **local** | `127.0.0.1:3000` | your dev box | local | `npm run web` (no Linode) |
| **development** | `development-learn.cogniumlabs.io` | own Linode | **colocated** on the base node | `provision-environment.sh development` |
| **testing** | `testing-learn.cogniumlabs.io` | own Linode | **separate Mongo VM** (prod-like) | `provision-environment.sh testing` |

> **Domains are first-level subdomains on purpose.** Cloudflare's free Universal SSL only
> covers the apex + one wildcard level (`*.cogniumlabs.io`), so a nested name like
> `testing.learn.cogniumlabs.io` (two levels) gets no edge cert
> (`ERR_SSL_VERSION_OR_CIPHER_MISMATCH`). Dev/test therefore use `<env>-learn.cogniumlabs.io`.
> To use a nested scheme instead, enable Cloudflare Advanced Certificate Manager / Total TLS.
| **production** | `learn.cogniumlabs.io` | own Linode | separate Mongo VM | already live (built by hand) |

Each cloud environment has its **own** VPC, subnet CIDR, three firewalls, base node, Mongo,
burst-worker image and credentials. The **only** shared thing is the single Linode API
token — isolation comes from separate resources, not separate accounts.

## 0.1 Naming convention

Every resource is labelled **`CogniumLearn-<Env>-<Role>`** and tagged **`cogniumlearn-<env>`**
(the tag is how the tooling finds and tears down an environment). The non-secret desired
shape of each environment lives in
[Common/Deployment/Environments.json](../Deployment/Environments.json).

| Role | Label | Dev CIDR | Test CIDR | Prod CIDR |
|---|---|---|---|---|
| VPC / Subnet | `CogniumLearn-<Env>-VPC` / `-Subnet` | `10.10.0.0/24` | `10.20.0.0/24` | `10.0.0.0/24` |
| Base node | `CogniumLearn-<Env>-Server` | | | |
| Mongo VM | `CogniumLearn-<Env>-MongoDB` | (colocated) | separate | separate |
| Firewalls | `CogniumLearn-<Env>-{Srv,Db,Burst}FW` (32-char cap; short role names since the "CogniumLearn" prefix is longer than the old "MindMeld" one) | | | |
| Burst image | `CogniumLearn-<Env>-BurstImage<version>` | | | |

The original production resources were built before this convention and are migrated to it
(metadata only, no downtime) by `bash Common/Deployment/rename-production-entities.sh`.

## 0.2 Env-file scheme

Each service selects its env file **by environment name**, resolved in this order:
`--environment=<name>` flag → `COGNIUMLEARN_ENVIRONMENT` variable (exported by the base node's
systemd unit) → legacy `--debug` → `production`. Each name maps to `Dock/.<name>.env` and
`Agent/.<name>.env` (`local` also falls back to the historic `.env`). The resolver is in
[Dock/index.js](../../Dock/index.js) and mirrored in
[Agent/Globals/Utility/EnvironmentLoader.py](../../Agent/Globals/Utility/EnvironmentLoader.py),
so Dock and the Agent subprocesses it spawns always agree on the environment.

Real env files are gitignored and are **created by the provisioner itself** (no per-env
templates); `Dock/.env.example` remains the committed reference for the full Dock variable
set. All deploy secrets live in a **single `deployment.env`**: shared values (Linode token,
SSH keys) are unsuffixed, and per-environment values are keyed by an uppercase suffix
(`CLOUDFLARE_TUNNEL_TOKEN_DEVELOPMENT`, `BASE_NODE_SSH_HOST_TESTING`, …).

> **Central secret store (optional).** Instead of hand-editing these per-environment
> files, you can make **Google Secret Manager** the source of truth and have the same files
> *rendered* onto the base node — no application code changes. See
> [§0.7](#07-managing-secrets-with-google-secret-manager).

## 0.3 Credentials — generated vs. supplied

Provisioning **auto-generates** `PAID_DECK_MASTER_KEY_BASE64` (per env; production's is
fixed forever), the Mongo password, and every `MONGODB_URL` / `REDIS_URL` / `BURST_*` / VPC
/ firewall value. It **stops before creating any paid resource** if a secret only you can
supply is missing, namely, per environment:

- `deployment.env` → **`CLOUDFLARE_TUNNEL_TOKEN_<ENV>`** — a remotely-managed (token-based)
  tunnel whose hostname `<env-domain>` routes to `http://127.0.0.1:3000`, created in the
  Cloudflare Zero Trust dashboard.
- `Agent/.<env>.env`: **Vertex AI auth** — `GOOGLE_ENTERPRISE_AGENT_PROJECT` (the GCP project) +
  `GOOGLE_ENTERPRISE_AGENT_CREDENTIALS_BASE64` (a base64-encoded *Vertex AI User* service-account key
  JSON for that project), plus optional `OPENAI_API_KEY`. A per-environment project keeps usage/billing
  separate. **Use a service account, not an API key** — Vertex's API-key path is ~10× slower to first
  token for streaming (see the AI / Agent note in §1.5).
- `Dock/.<env>.env`: **`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`**, with redirect URI
  `https://<env-domain>/Login/Callback` added to the OAuth client.

Object storage credentials need no separate file — see the Storage note in §0.7.

## 0.4 Linode token scopes

One Personal Access Token with **Read/Write** on **Linodes, Images, VPCs, Firewalls**
(Cloud Manager → Profile → API Tokens) drives everything. A rejected write surfaces as
`401/403` mid-run; add the scope and re-run (idempotent).

## 0.5 The commands (idempotent; production guarded)

```bash
# Full provision-from-zero (VPC, firewalls, node(s), Mongo, tunnel, image, services).
bash Common/Deployment/provision-environment.sh <env> [--dry-run] [--skip-deploy]
# Code + burst-image roll-out to an already-provisioned env (no infra changes).
bash Common/Deployment/deploy-environment.sh <env> [flags]
# Read-only status of the env's resources + services.
bash Common/Deployment/status-environment.sh <env>
# Idempotent teardown (prints the plan; deletes only with --yes; prod needs --force-production).
bash Common/Deployment/teardown-environment.sh <env> [--yes] [--force-production]
# Migrate the legacy production labels to the convention (safe, no downtime).
bash Common/Deployment/rename-production-entities.sh [--dry-run]
```

`provision` runs the exact steps of Sections 1–2 for you (VPC + firewalls + node install +
frontend build + burst-image bake + tunnel + systemd), just parameterised by environment;
`deploy` is the old `deploy.sh` (now a thin wrapper for `deploy-environment.sh production`).

## 0.6 Burst-fleet isolation (important)

The autoscaler **deletes every instance carrying its `BURST_MANAGEMENT_TAG` on startup**.
Each environment therefore gets a distinct tag/prefix — `cogniumlearn-<env>-worker` — written
into its `Dock/.<env>.env`, so one environment's Dock restart can **never** delete another
environment's burst VMs. Combined with separate VPCs, firewalls and burst images, the
fleets are fully isolated.

## 0.7 Managing secrets with Google Secret Manager

Everything above stores each environment's secrets as **hand-written files on the base
node** (`Dock/.<env>.env` and `Agent/.<env>.env`).
This section replaces the *source of truth* for those files with **Google Secret Manager
(GSM)** — a central, IAM-controlled, versioned, audited secret store — and renders them to a
**RAM-backed tmpfs mount so no plaintext secret ever touches persistent disk** (keeping them
out of snapshots and backups). GSM holds the values; a small refresh step **renders the env
files into tmpfs** at every Dock (re)start, and every consumer reads them exactly as before.

GSM is a natural fit here: CogniumLearn is already a Google Cloud tenant — the Agent
authenticates to Vertex AI with a **per-environment GCP project + service account** (§1.5),
so the projects, billing and IAM you need already exist. Enabling Secret Manager is one API
away.

**The app change is minimal and additive.** Dock ([Dock/index.js](../../Dock/index.js)), the
Agent ([EnvironmentLoader.py](../../Agent/Globals/Utility/EnvironmentLoader.py)) and Dock's
burst-forwarding ([BurstFleetSettings.js](../../Dock/Globals/Classes/Burst/BurstFleetSettings.js))
gained one opt-in: when `COGNIUMLEARN_SECRETS_DIRECTORY` is set they read the env file from that
tmpfs directory (`<dir>/Dock`, `<dir>/Agent`); unset, they read the repo directory exactly as
before, so **local development is untouched**.

**What does NOT change:** Dock still loads `Dock/.<env>.env` via dotenv
([Dock/index.js](../../Dock/index.js)); the Agent still loads `Agent/.<env>.env` via
`load_dotenv` ([EnvironmentLoader.py](../../Agent/Globals/Utility/EnvironmentLoader.py)); and
`BurstFleetSettings` still reads the Agent env file **from disk** to forward keys to burst
workers ([BurstFleetSettings.js](../../Dock/Globals/Classes/Burst/BurstFleetSettings.js)).
All of that is untouched — the files are simply generated from Secret Manager instead of
edited by hand.

> **Storage note.** CogniumLearn stores objects exclusively in **Linode Object Storage**, whose
> credentials are ordinary environment variables (`LINODE_STORAGE_BUCKET_ACCESS_KEY`,
> `LINODE_STORAGE_BUCKET_SECRET`, `LINODE_S3_ENDPOINT_HOSTNAMES`) that already live in the
> Dock and Agent env files — so they are captured automatically by the two bundled secrets
> below, with **no separate credential file** to manage. (Google Cloud Storage support was
> fully removed from `Persistence` — no fallback path exists anymore.)

### 0.7.1 Why render-to-file, not in-process injection

There are two ways to consume Secret Manager:

- **In-process injection** — a wrapper or the client library loads secrets into the process
  environment at launch (nothing on disk).
- **Render-to-file** — a step pulls the secrets and writes the env files, which the app then
  reads exactly as it does now.

CogniumLearn needs **render-to-file**, because several consumers read the secret *files from
disk*, not just `process.env`: the local Agent workers load their own `Agent/.<env>.env`,
and Dock's burst-forwarding reads the Agent env file off disk to hand its keys to burst VMs
via cloud-init. In-process injection would populate only Dock's own process environment, and
those on-disk reads would come up empty — which would require code changes. Rendering the
files keeps the change at **zero code** and preserves every existing read path. It also fits
CogniumLearn's "read secrets once at boot" model: refreshing the files on each Dock restart is
enough.

### 0.7.2 The one-secret-per-file (bundle) pattern

Do **not** store one GSM secret per variable — that is dozens of secrets per environment.
Instead store **each whole env file as a single secret**. Two secrets per environment:

| GSM secret | Value (the entire file) | Rendered to |
|---|---|---|
| `dock-env` | the contents of `Dock/.<env>.env` (`MONGODB_URL`, `GOOGLE_CLIENT_ID/SECRET`, `PAID_DECK_MASTER_KEY_BASE64`, `ZOHO_*`, `RAZORPAY_*`, `SMTP_*`, `LINODE_API_TOKEN`, the Linode Object Storage keys `LINODE_STORAGE_BUCKET_ACCESS_KEY` / `LINODE_STORAGE_BUCKET_SECRET` / `LINODE_S3_ENDPOINT_HOSTNAMES`, all `BURST_*`, `DOMAIN_NAME`, …) | `Dock/.<env>.env` |
| `agent-env` | the contents of `Agent/.<env>.env` (`GOOGLE_ENTERPRISE_AGENT_PROJECT` / `_LOCATION` / `_CREDENTIALS_BASE64` / `_API_KEY`, `OPENAI_API_KEY`, `MONGODB_URL`, `MONGODB_DATABASE_NAME`, `REDIS_URL`, the same Linode Object Storage keys, `WEB_SCRAPE_CONTACT_EMAIL`) | `Agent/.<env>.env` |

This keeps you to **two active secret versions per environment (six total)**, which sits
inside Secret Manager's monthly free allowance, and makes rendering one command per file (no
per-key plumbing). The trade-off is editing ergonomics: changing one value means uploading a
**new version of the whole file** (`gcloud secrets versions add …`), which is fine for
read-once-at-boot config. If you would rather edit per key in the console, use one secret per
variable instead — at a small per-secret cost (see the official
[Secret Manager pricing](https://cloud.google.com/secret-manager/pricing)).

The Linode Object Storage credentials are ordinary env vars already inside those files, so
they are captured automatically — there is no separate storage credential to render or manage.

> **`PAID_DECK_MASTER_KEY_BASE64` is the one secret to treat specially.** Store the *exact
> existing production value* — Secret Manager's versioning then proves it never drifts — and
> keep an independent offline backup regardless (per §1.5 / §2.5, changing or losing it makes
> every paid deck permanently undecryptable). Never enable rotation on it.

### 0.7.3 Environment isolation — one GCP project per environment

Model each CogniumLearn environment as its **own GCP project** — the same split you already use
for Vertex AI (a per-environment project keeps usage, billing and IAM separate, §1.5). That
environment's secret-reader service account can then read **only** its own project's secrets,
giving true per-environment isolation at no cost. `local` stays on hand-written files on your
dev box and never uses GSM.

| CogniumLearn environment | GCP project (holds `dock-env` + `agent-env`) | `deployment.env` key |
|---|---|---|
| `local` (dev box) | — (keep hand-written `Dock/.env` / `Agent/.env`) | — |
| `development` | your development GCP project (may reuse the Vertex one) | `GCP_PROJECT_ID_DEVELOPMENT` |
| `testing` | your testing GCP project | `GCP_PROJECT_ID_TESTING` |
| `production` | your production GCP project | `GCP_PROJECT_ID_PRODUCTION` |

> **Single-project alternative:** if you keep everything in one GCP project, name the secrets
> per environment instead (`dock-env-production`, `dock-env-development`, …) and scope IAM per
> secret. The per-project split above is cleaner and matches your Vertex layout.

### 0.7.4 One-time GCP setup (per environment project)

Run these once per environment, from the repo root on your dev box, with `gcloud`
authenticated as an owner/editor of that environment's project. Replace `PROJECT_ID` with
that project. These are the official Secret Manager / IAM `gcloud` commands.

1. **Enable the Secret Manager API:**
   ```bash
   gcloud services enable secretmanager.googleapis.com --project=PROJECT_ID
   ```
2. **Create the two secrets from your current live env files** (automatic replication):
   ```bash
   gcloud secrets create dock-env --project=PROJECT_ID --replication-policy="automatic" --data-file="Dock/.production.env"
   gcloud secrets create agent-env --project=PROJECT_ID --replication-policy="automatic" --data-file="Agent/.production.env"
   ```
   To change a value later, edit the file and add a **new version**:
   ```bash
   gcloud secrets versions add dock-env --project=PROJECT_ID --data-file="Dock/.production.env"
   ```
3. **Create a dedicated least-privilege reader service account:**
   ```bash
   gcloud iam service-accounts create cogniumlearn-secret-reader \
       --project=PROJECT_ID --display-name="CogniumLearn base-node secret reader"
   ```
   Its email is `cogniumlearn-secret-reader@PROJECT_ID.iam.gserviceaccount.com`.
4. **Grant it read + version-add on ONLY those two secrets** (least privilege — not
   project-wide). `secretAccessor` lets the node render (read the payload);
   `secretVersionAdder` lets the deploy-time sync (§0.7.8) push updated env files back up.
   Neither can read other secrets or destroy versions:
   ```bash
   for grantedRole in roles/secretmanager.secretAccessor roles/secretmanager.secretVersionAdder
   do
       for secretName in dock-env agent-env
       do
           gcloud secrets add-iam-policy-binding "$secretName" --project=PROJECT_ID \
               --member="serviceAccount:cogniumlearn-secret-reader@PROJECT_ID.iam.gserviceaccount.com" \
               --role="$grantedRole"
       done
   done
   ```
   If you keep the deploy-time sync on the dev box instead of the node (the alternative in
   §0.7.8), grant only `roles/secretmanager.secretAccessor` here.
5. **Download the reader's JSON key** — the base node's bootstrap credential (its
   "secret-zero"). Store it gitignored:
   ```bash
   gcloud iam service-accounts keys create Common/Credentials/gcp-accessor.production.json \
       --iam-account="cogniumlearn-secret-reader@PROJECT_ID.iam.gserviceaccount.com"
   ```
   `Common/Credentials/` is gitignored, so the key never enters git or the code tarballs.

Repeat for the development and testing projects, writing `gcp-accessor.development.json` /
`gcp-accessor.testing.json`. The rest is on the base node.

### 0.7.5 Base node wiring (CLI + systemd — additive only)

1. **Install the Google Cloud CLI** on the base node (official Debian apt repo). These
   commands are idempotent — safe to re-run on every build:
   ```bash
   # Prerequisites. gnupg is required for the key import; without it the dearmor step
   # yields an empty keyring and apt fails with "NO_PUBKEY … / not signed".
   sudo apt-get install -y apt-transport-https ca-certificates gnupg curl
   # Import the signing key. Remove any stale keyring first; --yes forces a clean, non-
   # interactive overwrite (gpg --dearmor -o refuses to overwrite otherwise).
   sudo rm -f /usr/share/keyrings/cloud.google.gpg
   curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo gpg --dearmor --yes -o /usr/share/keyrings/cloud.google.gpg
   # Add the repo with `tee` (overwrite, not `tee -a`) so re-runs never duplicate the line.
   echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | sudo tee /etc/apt/sources.list.d/google-cloud-sdk.list
   sudo apt-get update && sudo apt-get install -y google-cloud-cli
   ```
2. **Place the reader key + project config** (root-only). Put the JSON key at
   `/etc/cogniumlearn/gcp-accessor.json` (chmod `600`) and write `/etc/cogniumlearn/gcp.env`:
   ```ini
   GCP_PROJECT_ID=<this environment's GCP project id>
   GCP_SERVICE_ACCOUNT_KEY_PATH=/etc/cogniumlearn/gcp-accessor.json
   COGNIUMLEARN_SECRETS_DIRECTORY=/run/cogniumlearn
   ```
   > **`COGNIUMLEARN_SECRETS_DIRECTORY` renders the env files to RAM, never persistent disk.**
   > `/run` is a systemd **tmpfs** (RAM-backed) mount, so the rendered
   > `Dock/.<env>.env` / `Agent/.<env>.env` never touch the disk — they stay out of
   > snapshots and backups, and are wiped on reboot (re-rendered from Secret Manager at the
   > next Dock start). Dock, the Agent (`EnvironmentLoader`) and Dock's burst-forwarding
   > (`BurstFleetSettings`) all read from `<COGNIUMLEARN_SECRETS_DIRECTORY>/Dock` and `/Agent` when
   > this variable is set, falling back to the repo directory when it is not (local
   > development). Because the systemd unit loads `gcp.env` as its `EnvironmentFile`, the
   > variable is inherited by the local Agent worker subprocesses Dock spawns. **Leave it unset
   > to keep the legacy on-disk behaviour.**
3. **Add the refresh script** `/etc/cogniumlearn/refresh-secrets.sh` (chmod `700`). It
   authenticates the reader service account, renders the two files, and is **fail-soft**: if
   Secret Manager is unreachable but the files already exist, it keeps them and exits `0`, so
   an outage can never block a Dock restart.
   ```bash
   #!/usr/bin/env bash
   # /etc/cogniumlearn/refresh-secrets.sh <cogniumlearnEnvironmentName>
   # Renders the env files for one environment from Google Secret Manager into the RAM-backed
   # tmpfs secrets mount, so no plaintext secret ever lands on persistent disk. GCP_PROJECT_ID
   # + GCP_SERVICE_ACCOUNT_KEY_PATH + COGNIUMLEARN_SECRETS_DIRECTORY come from /etc/cogniumlearn/gcp.env
   # (loaded by the systemd unit as EnvironmentFile).
   set -u
   cogniumlearnEnvironment="$1"

   : "${COGNIUMLEARN_SECRETS_DIRECTORY:=/run/cogniumlearn}" # RAM-backed tmpfs; never persistent disk
   dockDirectory="$COGNIUMLEARN_SECRETS_DIRECTORY/Dock"
   agentDirectory="$COGNIUMLEARN_SECRETS_DIRECTORY/Agent"
   mkdir -p "$dockDirectory" "$agentDirectory"
   chmod 700 "$COGNIUMLEARN_SECRETS_DIRECTORY" "$dockDirectory" "$agentDirectory" 2>/dev/null || true
   dockEnvironmentFile="$dockDirectory/.${cogniumlearnEnvironment}.env"
   agentEnvironmentFile="$agentDirectory/.${cogniumlearnEnvironment}.env"

   # Authenticate the base node's secret-reader service account (idempotent).
   gcloud auth activate-service-account --key-file="$GCP_SERVICE_ACCOUNT_KEY_PATH" --quiet 2>/dev/null

   renderSucceeded=1
   umask 077 # rendered files are readable only by the owner
   gcloud secrets versions access latest --project="$GCP_PROJECT_ID" --secret="dock-env" --out-file="$dockEnvironmentFile.tmp" 2>/dev/null && mv "$dockEnvironmentFile.tmp" "$dockEnvironmentFile" || renderSucceeded=0
   gcloud secrets versions access latest --project="$GCP_PROJECT_ID" --secret="agent-env" --out-file="$agentEnvironmentFile.tmp" 2>/dev/null && mv "$agentEnvironmentFile.tmp" "$agentEnvironmentFile" || renderSucceeded=0

   if [ "$renderSucceeded" -ne 1 ]; then
       if [ -f "$dockEnvironmentFile" ] && [ -f "$agentEnvironmentFile" ]; then
           echo "refresh-secrets: Secret Manager unreachable; keeping cached on-disk secrets." >&2
           exit 0
       fi
       echo "refresh-secrets: Secret Manager unreachable and no cached secrets on disk — aborting." >&2
       exit 1
   fi
   ```
   (The `.tmp` + `mv` pattern makes each write atomic, so Dock never reads a half-written
   file; `--out-file` writes the raw secret payload straight to disk.)
   > **`latest` vs pinned version.** Secret Manager's docs recommend pinning a *specific*
   > version rather than `latest` in production. To do that, replace `latest` with the version
   > number and bump it whenever you add a version. For CogniumLearn's read-once-at-boot config,
   > `latest` with refresh-on-restart is the hands-off choice — use whichever you prefer.
4. **Hook it into Dock's startup with a systemd drop-in** — deliberately *additive*, so it
   survives `deploy.sh` rewriting the main unit
   ([Remote/BaseNodeUpdate.sh](../Deployment/Remote/BaseNodeUpdate.sh)). Create
   `/etc/systemd/system/cogniumlearn-dock.service.d/secret-manager.conf`:
   ```ini
   [Service]
   EnvironmentFile=/etc/cogniumlearn/gcp.env
   ExecStartPre=/etc/cogniumlearn/refresh-secrets.sh production
   ```
   Then:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl restart cogniumlearn-dock
   ```
   Now every Dock (re)start first re-pulls fresh secrets from Secret Manager into the files,
   then boots and reads them; the local Agent workers Dock spawns read the just-refreshed
   `Agent/.<env>.env`, and burst forwarding reads the just-refreshed files. Use the matching
   name in the drop-in on each node — `production` on the production node, `development` on
   the dev node, `testing` on the test node.
   > **Optional periodic refresh** to pick up rotated secrets without a restart: add a
   > `cogniumlearn-secrets-refresh.timer` that runs the same script hourly. Because the app
   > reads env only at boot, a refresh alone does not take effect until the next Dock
   > restart, so pair the timer with a restart only for values you actually rotate. For
   > CogniumLearn, refresh-on-restart is usually enough.

### 0.7.6 Migrating an already-live environment

Production is already running from hand-written files. Migrate it with zero downtime and an
instant rollback:

1. Load the **current live** values into Secret Manager (§0.7.4 steps 1–2) — build the
   secrets straight from the running base node's files (or your verified dev-box copies) so
   nothing changes value.

   > **Reconciling local vs. node (important).** The dev-box copy and the node's live file
   > often diverge: the node has **deploy/provision-written keys the dev box lacks**
   > (`BURST_IMAGE_ID`, provision-appended `MONGODB_URL` / `REDIS_URL`), while your local copy
   > may hold values you've updated (storage keys, `OPENAI_API_KEY`). If you seed Secret
   > Manager from *only* the dev-box file, the render-on-restart **drops** the node-only keys
   > and can disable burst or break the DB connection. Seed with a **union merge** instead:
   > take your authoritative file as the base and **append every key the node has that the
   > base lacks**, so nothing runtime-critical is lost. Then always run step 2's diff — it
   > shows exactly what the render will add/change, and must never *remove* a key the node
   > needs. (Production was seeded from its own live node files, so its diff was a clean
   > no-op; development and testing were seeded from the authoritative local files
   > union-merged with each node's `BURST_IMAGE_ID`.)
2. On the base node, install the CLI + key + `gcp.env` + script, then render **by hand** and
   `diff` the result against the originals (back them up first, since the render overwrites
   the live file):
   ```bash
   cp Dock/.production.env Dock/.production.env.bak
   set -a; . /etc/cogniumlearn/gcp.env; set +a # load GCP_PROJECT_ID as the unit would
   sudo -E /etc/cogniumlearn/refresh-secrets.sh production
   diff Dock/.production.env.bak Dock/.production.env
   ```
   They must match exactly — especially `PAID_DECK_MASTER_KEY_BASE64`.
3. Only once the diff is clean, add the systemd drop-in and restart.
4. **Rollback** is trivial: remove the drop-in (`rm …/secret-manager.conf` + `daemon-reload`)
   and restore the `.bak` files — you are back to hand-written files with no code change.

### 0.7.7 Automated credential injection via `deployment.env`

Instead of hand-placing the key + config on each node (§0.7.5 step 2), let the deploy
automation carry them. In the gitignored **`deployment.env`** (which **never leaves your dev
box**), add the per-environment GCP project id, following the file's uppercase-suffix
convention (exactly like `CLOUDFLARE_TUNNEL_TOKEN_<ENV>`):

```ini
# Google Secret Manager — one GCP project per environment.
GCP_PROJECT_ID_PRODUCTION=<production GCP project id>
GCP_PROJECT_ID_DEVELOPMENT=<development GCP project id>
GCP_PROJECT_ID_TESTING=<testing GCP project id>
```

The reader **service-account key** is a JSON *file*, not a line value: keep it at
`Common/Credentials/gcp-accessor.<env>.json` on your dev box (gitignored), and the deploy
`scp`s it to the node.

For the deploy to push these to the node, two small hooks mirror how
`CLOUDFLARE_TUNNEL_TOKEN_<ENV>` is already resolved and shipped:

1. In [EnvironmentConfig.sh](../Deployment/Library/EnvironmentConfig.sh), add `GCP_PROJECT_ID`
   to the `for scoped_variable in …` loop, so `GCP_PROJECT_ID_PRODUCTION` resolves to the bare
   `GCP_PROJECT_ID` for the target environment.
2. In [BaseNodeUpdate.sh](../Deployment/Remote/BaseNodeUpdate.sh), before the Dock restart,
   `scp` `Common/Credentials/gcp-accessor.<env>.json` to `/etc/cogniumlearn/gcp-accessor.json`
   (mode `600`) and write `/etc/cogniumlearn/gcp.env`, then install `refresh-secrets.sh` + the
   drop-in from §0.7.5:
   ```bash
   install -m 600 /dev/null /etc/cogniumlearn/gcp.env
   cat >/etc/cogniumlearn/gcp.env <<EOF
   GCP_PROJECT_ID=${GCP_PROJECT_ID}
   GCP_SERVICE_ACCOUNT_KEY_PATH=/etc/cogniumlearn/gcp-accessor.json
   EOF
   ```

Until those hooks are added, place `/etc/cogniumlearn/gcp-accessor.json` + `/etc/cogniumlearn/gcp.env`
on the node by hand (§0.7.5) — the rest of the flow is identical.

> **`deployment.env` is the single most sensitive file you own** — Linode API token, root
> password, SSH keys, tunnel tokens, and the GCP project ids. It is gitignored
> (`deployment.env` / `deployment.*.env`) and must **only ever exist on your dev box**: never
> `scp` it to a node, never commit it, never paste its contents. The project ids are not
> secret, but the reader **key** file (`Common/Credentials/gcp-accessor.<env>.json`) is —
> guard it like any credential. If a key is ever exposed, disable and delete it
> (`gcloud iam service-accounts keys delete <KEY_ID> --iam-account=…`) and create a new one.

### 0.7.8 Keeping Secret Manager in sync on every deploy (idempotent — mandatory)

**Once render-on-restart is live, this step is required on every build.** The deploy
pipeline writes some values **into the node's env files** — most importantly `deploy.sh`
stamps the freshly-baked `BURST_IMAGE_ID` into `Dock/.<env>.env` on the node
([BaseNodeUpdate.sh](../Deployment/Remote/BaseNodeUpdate.sh)) and then restarts Dock. But the
drop-in's `ExecStartPre` re-renders those files **from Secret Manager** on that same restart,
so if Secret Manager still holds the *old* value the deploy's change is silently reverted
(e.g. burst VMs boot the previous image).

**This is now wired into the deploy automation.** Right before its Dock restart,
[BaseNodeUpdate.sh](../Deployment/Remote/BaseNodeUpdate.sh) runs a diff-guarded sync **on the
node**: when `/etc/cogniumlearn/gcp.env` is present (i.e. render-on-restart is set up on this
node), it pushes the just-updated `dock-env` / `agent-env` files back up to Secret Manager —
but **only when the content changed**, so the version history never bloats. The subsequent
restart then renders those same values, so nothing reverts. It is best-effort: a failure
warns in the deploy log but never aborts the deploy.

For this, the node's `cogniumlearn-secret-reader` service account needs
`roles/secretmanager.secretVersionAdder` on the two secrets (in addition to `secretAccessor`)
— granted in §0.7.4 step 4. That is the only extra privilege; the key still cannot read other
secrets or destroy versions.

> **Active-version limit.** Secret Manager's free allowance counts *active* versions. The
> diff-guard keeps new versions to genuine changes; periodically destroy superseded versions
> (`gcloud secrets versions destroy <N> --secret=dock-env --project=<project>`) to keep the
> active count small.

**Alternative (keep the node read-only):** instead of the node self-syncing, push from the
dev box (owner auth) as the final step of `deploy.sh` — after the node's env files are updated
and before a final restart — and grant the node only `secretAccessor`:

```bash
NODE=172.232.112.40
PROJECT=cogniumlearn-500509
for secretPair in "dock-env:Dock/.production.env" "agent-env:Agent/.production.env"
do
    secretName="${secretPair%%:*}"
    nodeRelativePath="${secretPair##*:}"
    localCopy=$(mktemp)
    scp -q "root@${NODE}:/root/cogniumlearn/${nodeRelativePath}" "$localCopy"
    if gcloud secrets versions access latest --project="$PROJECT" --secret="$secretName" 2>/dev/null | diff -q - "$localCopy" >/dev/null
    then
        echo "${secretName}: unchanged — no new version."
    else
        gcloud secrets versions add "$secretName" --project="$PROJECT" --data-file="$localCopy"
    fi
    shred -u "$localCopy" 2>/dev/null || rm -f "$localCopy"
done
ssh "root@${NODE}" 'systemctl restart cogniumlearn-dock'
```

### 0.7.9 Post-deployment secret hygiene (what can and cannot be deleted)

With Secret Manager as the source of truth the plaintext env files are redundant *as a
source* — but they are **not** all safe to delete, because the render-to-file model (§0.7.1)
means some are read at **runtime**, not just at boot. Per file:

| File(s) | Delete after deploy? | Why |
|---|---|---|
| **Dev-box** `Dock/.<env>.env`, `Agent/.<env>.env` for cloud envs | **Yes — shred them** | Secret Manager is now the source; these are stale copies that can only drift. Back up `PAID_DECK_MASTER_KEY_BASE64` offline first. |
| **Dev-box** `Common/Credentials/gcp-accessor.<env>.json` (reader key) | **No — keep** | Bootstrap credential file the deploy still `scp`s to the node; gitignored. Guard it like any key. |
| **Dev-box** `Common/Credentials/cogniumlearn-storage.<env>.json` | **Yes — safe to delete** | Leftover from the removed Google Cloud Storage support; `Persistence` no longer references it and the deploy no longer ships it. |
| **Dev-box** `Dock/.env`, `Agent/.env` (local) | **No — keep** | `local` stays off GSM; `npm run web` reads these. |
| **Base-node** `Dock/.<env>.env`, `Agent/.<env>.env` on **persistent disk** | **Yes — shred them** | With `COGNIUMLEARN_SECRETS_DIRECTORY` set they are rendered to the tmpfs mount instead, so any copy left in the repo directory is redundant **and** a snapshot/backup exposure. Also shred stale backups (`.env`, `.<env>.env.bak*`). |
| **Base-node** tmpfs `/run/cogniumlearn/{Dock,Agent}/.<env>.env` | **Leave — RAM only** | The live env files. In tmpfs (RAM, never persistent disk), `600`, wiped on reboot and re-rendered from Secret Manager by the `ExecStartPre` refresh at the next start. dotenv, the Agent (`EnvironmentLoader`) and burst forwarding (`BurstFleetSettings`) read them from here. |
| **Base-node** `/etc/cogniumlearn/gcp-accessor.json` + `/etc/cogniumlearn/gcp.env` | **No — must persist** | The bootstrap reader key + project config the refresh script needs on every restart. The key is the one unavoidable secret at rest on Linode (no keyless auth). |
| **Committed** `*.env.example` / `.<env>.env.example` | **No — keep** | They hold **no secrets** (blank templates) and document the variable set; deleting them is a git change with zero security benefit. |

So the honest answer to "no env file on disk": on the **base node** the live env files exist
only in **tmpfs (RAM)** — none on persistent disk — and any persistent-disk copy or backup
should be shredded (the `*.env.example` files carry no secrets and stay). On the **dev box**,
shred the now-redundant per-environment secret files once a deploy has verified the node
renders correctly from Secret Manager (§0.7.6):

```bash
# On the dev box, AFTER a verified deploy. Removes the now-redundant per-environment env
# files; keeps the local .env, the committed .example templates, and gcp-accessor.<env>.json
# (the credential file the deploy still ships).
for secretFile in Dock/.production.env Dock/.development.env Dock/.testing.env \
                  Agent/.production.env Agent/.development.env Agent/.testing.env; do
    [ -f "$secretFile" ] && { shred -u "$secretFile" 2>/dev/null || rm -f "$secretFile"; }
done
```

> **Provisioner note.** `provision-environment.sh` still `scp`s `Dock/.<env>.env` /
> `Agent/.<env>.env` to the node's **repo** directory. With tmpfs rendering, Dock ignores those
> (it reads `COGNIUMLEARN_SECRETS_DIRECTORY`), so that upload is now redundant **and** re-lands a
> plaintext secret on persistent disk — remove/skip it so provisioning stays fileless. Not yet
> wired.

### 0.7.10 Gotchas specific to CogniumLearn

- **Warm restarts are fail-soft; cold reboots need Secret Manager.** On a `systemctl restart`
  the tmpfs files persist, so the fail-soft script keeps them if Secret Manager is briefly
  unreachable. But `/run` (tmpfs) is **wiped on reboot**, so after a reboot the first render has
  no cache to fall back on — the node needs the Secret Manager API enabled and reachable to
  come up. That is the deliberate trade for keeping secrets off persistent disk.
- **Secret-zero is the reader key.** The service-account JSON at `/etc/cogniumlearn/gcp-accessor.json`
  is the one credential that cannot come from GSM. Keep it `600`; the service account holds
  `secretAccessor` on **only** its two secrets; and because each environment is a **separate
  GCP project**, a leaked key can read only that one environment — true per-environment
  isolation at no cost (the advantage over a single shared-scope store).
- **Burst VMs are outside the tmpfs change.** They still get secrets via cloud-init
  `worker.env` (§0.3, §1.10) — a file on the burst VM's own disk. Burst VMs are **ephemeral**
  (not snapshotted), so the exposure is smaller, but to make them fileless too you would render
  `worker.env` to a tmpfs path in the burst image's worker unit + cloud-init — a burst-image
  re-bake. The base-node tmpfs change does not touch this.
- **`deploy.sh` will not clobber the rendered files** — it already excludes `Dock/.env` /
  `Dock/.production.env` from the Dock copy (§2.0 / §2.1), and the drop-in re-renders on the
  restart it triggers.
- **Keep `local` off GSM.** Your dev box uses the historic `Dock/.env` / `Agent/.env`; it does
  not need a GCP project.
- **Cost.** The bundle pattern (two secrets per environment, six total) stays within Secret
  Manager's monthly free allowance, and access operations are a couple per Dock restart —
  negligible. Confirm current figures on the official
  [Secret Manager pricing](https://cloud.google.com/secret-manager/pricing) page.
- **Rotate the reader key periodically.** Service-account keys do not expire on their own —
  create a new key, update the node, then delete the old one with
  `gcloud iam service-accounts keys delete`.
- **Node-side setup needs SSH, which each environment's own `*-SrvFW` gates by admin IP.**
  If your public IP has changed since an environment was provisioned, its firewall's
  `allow-ssh-admin` rule (port 22) still points at the stale address and SSH will time out —
  even though the node is up. Update the SSH source to your current IP (`/32`) on that
  environment's `CogniumLearn-<Env>-SrvFW` (Linode Cloud Manager, or `PUT
  /v4/networking/firewalls/<id>/rules`). The Linode firewall-rules API can also return
  transient `500`s during a platform wobble — retry, or use the Cloud Manager UI, which uses a
  separate backend.

---

# Section 1 — Initial deployment

> Sections 1–2 document the per-machine mechanics for a **single** environment. For
> development/testing you normally never run these by hand — `provision-environment.sh
> <env>` (Section 0) performs every step below, per environment. They remain the reference
> for what the automation does and for hand-operating the production base node.

Do these in order. Step 1.1 is on your dev workstation; 1.3 onward are on Linode.
**The worker Docker image is built on a Debian 12 Linode bake box, not on Windows** —
§1.2 explains why and §1.10 is where the build actually runs.

## 1.1 Dev workstation — prepare and (optionally) test locally

1. Have the repo on your Windows dev machine with the Agent venv (`Agent/.venv`) and
   `Dock/.env` working for local dev.
2. **(Recommended) dry-run test** before you touch the cloud — proves the queue,
   workers, autoscaler math (incl. the hard cap) and maintenance with **zero spend**:
   - In `Dock/.env` set `DOCK_USE_TASK_QUEUE=1` and `BURST_DRY_RUN=1`.
   - Start a local Redis, then run Dock **without** `--debug` (from `Dock/`):
     `node index.js`.
   - Trigger a generation and confirm a worker drains it; add a maintenance window
     and confirm it blocks new work but not running work. Then revert
     `DOCK_USE_TASK_QUEUE`/`BURST_DRY_RUN` for normal dev.

## 1.1.1 The browser test gates (production deploys only)

Every **production** `deploy-environment.sh` run drives the real UI in a real
Chromium against the freshly-built bundle **before anything is baked or shipped**,
and aborts the deployment if it does not come back clean. Three suites:

| Suite | Runs on | What it proves |
|---|---|---|
| **Tutorial walkthrough** — `Common/Testing/Main/run_tutorial_ui_tests.js` | **production only** | All seven guided tours walk start to finish; every step's spotlight exposes a real, clickable element; no step teleports the user between pages. |
| **Critical user flows** — `Common/Testing/Main/run_critical_flow_tests.js` | **production only** | 27 everyday operations still work by hand (below), including that the credit ledger still charges. |
| **Synchronisation** — `Common/Testing/Main/run_sync_ui_tests.js` | **production only** | 19 sync behaviours across three independent devices (below), each asserted against MongoDB as well as the screen. |

**Development and testing deploys run no browser gate at all** — they ship
straight from the frontend build to the bake. That is deliberate: those
environments exist to *find* breakage by being deployed to and used, and paying
the gate's wall-clock on every dev roll-out discourages deploying there often.
Production is the one environment where a regression reaches real users, so it is
the one that pays for the gate. The consequence to accept knowingly: a frontend
change that strands a user mid-tour will not be caught until the production
deploy that ships it — run the suites by hand (or the **`run-browser-gates`**
skill) after a frontend change if you want that signal earlier.

All three are gated by the same `--skip-tutorial-tests` flag and the same
`TUTORIAL_TEST_SESSION_COOKIE` prerequisite, and on development/testing neither
the cookie nor a local Redis/MongoDB is needed, since no suite runs.

### The 19 synchronisation cases

Sync is the subsystem the app is least able to tell you is broken. A client that
pushed nothing still shows "Synced ✓"; a client that dropped half the server's
rows shows a smaller library, not an error; a pull that never converges shows a
bar that keeps moving. All three look healthy from inside the browser, so every
case here pairs a browser-visible outcome with MongoDB's own state — and the
cross-device cases drive genuinely separate devices (separate browser contexts,
therefore separate device ids, sync logs and IndexedDB copies), because two tabs
in one context share all three and cannot tell a real pull from a local read.

| # | Case |
|---|---|
| 01 | Device A boots and its first sync settles without error |
| 02 | Device A's root grid matches the deck count the server holds |
| 03 | A deck created on Device A reaches the server |
| 04 | A card authored on Device A reaches the server |
| 05 | Device B boots fresh and receives Device A's deck |
| 06 | Device B lists the card Device A authored |
| 07 | A rename on Device A reaches Device B |
| 08 | A deletion on Device A reaches Device B and is tombstoned server-side |
| 09 | Reloading Device A preserves the library rather than re-pulling an empty one |
| 10 | Seed 260 server-side cards so the next pull must chunk |
| 11 | The chunked drain runs to completion and delivers every card |
| 12 | **The drain's "X / Y items" total never grows** |
| 13 | The drain finishes on "X / X" with the blocking modal cleared |
| 14 | The drain deleted nothing — no deck was tombstoned while chunks were still pending |
| 15 | A brand-new device receives the whole multi-hundred-entity library |
| 16 | Two devices sync in turn without either being blocked on the lock |
| 17 | An edit made offline is queued and reaches the server once back online |
| 18 | Every device converges on the server's view once all have synced |
| 19 | No uncaught client script errors during the sync flows |

Case 12 is the one this suite was written for. A chunked pull hands the client
the *smallest* overflow watermark as its next cursor, but every collection is
queried with an open-ended `serverUpdatedAt > lastSync` — so rows above that
cursor in a collection that did not overflow were re-sent on every cycle, and
counted a second time in `remainingEntityCount` on top. The denominator the user
watches therefore **climbed** on every round trip instead of counting down, and a
returning device could sit there indefinitely while the number got bigger.

Case 10 seeds its cards by CLONING one the suite really did author through the
card editor, so the fixture's shape can never drift from what the app writes.
`DRAIN_CARD_COUNT` (default 260) must stay above the server's
`MAX_PULL_PER_COLLECTION`, or the pull fits in one cycle and cases 11–14 prove
nothing — case 11 fails loudly rather than passing vacuously if that happens.

Every fixture is prefixed `ZZSync`; a run sweeps up its own rows *and their
deletion tombstones* at the end, and sweeps anything an interrupted previous run
left behind before it starts. A leftover deck tombstone would otherwise be
replayed to every device on the next pull.

### The 27 critical user flows

Run in order against one throwaway fixture deck the suite creates and deletes
itself (every fixture is prefixed `ZZTest`, and a run sweeps up anything an
interrupted previous run left behind):

| # | Flow |
|---|---|
| 1 | App boots to the authenticated Home page with the deck grid |
| 2 | Create a deck from the + tile (chooser → editor → save) |
| 3 | Saving a deck with no name is rejected; nothing is created |
| 4 | Rename a deck via the options menu → Edit → Save |
| 5 | Drill into a deck — contents shown, climb-out control appears |
| 6 | Create a sub-deck inside the open deck, then climb back out |
| 7 | Add a flashcard (menu → Add → Card → question + answer → Save) |
| 8 | Saving a card with no question is rejected |
| 9 | Add a second flashcard so the study queue has depth |
| 10 | Browse the deck's cards — both are listed |
| 11 | Search inside Browse filters the card list, clearing restores it |
| 12 | Edit an existing card from Browse; the change shows in the list |
| 13 | Add a study material and see it under Browse → Study Materials |
| 14 | Everything created survives a full page reload |
| 15 | Spaced Repetition — Show Answer reveals the back of the card |
| 16 | Study — the Assistant panel opens and closes on demand |
| 17 | Study — Mark for Review toggles the card's review state |
| 18 | Study — zoom controls scale the card and reset to 100% |
| 19 | Spaced Repetition — rating a card advances to the next one |
| 20 | Leaving a study session returns to Home with the grid intact |
| 21 | **Ask AI actually charges the account** (a real ledger row and a real balance drop) |
| 22 | Revise mode plays back only the cards marked for review |
| 23 | Revise — Next / Previous page through the queue |
| 24 | Content Study renders the deck's study material |
| 25 | Deck Insights opens from the deck menu and renders |
| 26 | **Start Generation prices the run before submitting anything** (no AI spend) |
| 27 | Delete a deck (menu → Edit → Delete Deck → confirm) |

Mock-test authoring and grading are deliberately **not** repeated here — the
tutorial suite already takes the sample deck's mock test end to end (launch →
answer → finish → graded answer key) on every deploy.

**Flows 21 and 26 are the credit guarantee.** Credit charging leaves no trace in
the UI — a generation that completes and charges nothing produces decks, a happy
user, and no signal anywhere on screen — so both read the ledger straight from
MongoDB via `Common/Testing/Main/CreditLedgerProbe.js`. They are deliberately
cheap: 26 calls `/Generate/EstimateCost`, which is pure arithmetic over the
stored pricing and spends nothing at all, and 21 costs one flat 0.1-credit
`ASK_AI_BASIC` call. Between them they catch a credit system that has stopped
pricing work and one that has stopped recording it. Flow 21 SKIPs (rather than
fails) when the Agent venv or the model credentials are missing on the deploying
machine, since neither is the app being wrong. The expensive end-to-end
proof — upload a document, run a real generation, assert the token-metered
charge — is a separate on-demand suite, below.

### The on-demand credit-charging suite (NOT a gate)

`Common/Testing/Main/run_credit_charging_tests.js` is the full proof that a user
who uploads a document and runs a real AI generation is **actually charged**. It
uploads the committed fixture in `Common/Testing/Main/fixtures/`, configures the
cheapest run the form accepts (flashcards only, 6 cards, no images), waits for
the generation to reach a terminal state, and then asserts against MongoDB that:

- applied `TASK_CHARGE` rows exist for the run and all of them debit;
- at least one is from a token-metered worker (17/18/19) **with non-zero
  `metadata.usage.inputTokens` and `outputTokens`** — this is the regression the
  suite exists for, and the one that made generations silently free;
- the balance dropped by the sum of the charges, and `lifetimeCreditsSpent` rose
  by the same amount; and
- the credit table the user is shown on the progress page agrees with the ledger.

```bash
TEST_SESSION_COOKIE=<seeded session id> VERBOSE=1 \
    node Common/Testing/Main/run_credit_charging_tests.js
```

It is **deliberately not** wired into `deploy-environment.sh`. It spends real
credits and real model tokens, takes minutes, and needs object storage plus a
working Agent venv on top of Mongo and Redis — so its failures are as often
environmental as they are the app's fault, and the gate treats `SKIPPED` as a
stop. Run it after any change to the credit, metering or generation paths, and
periodically: its `metrics` block reports credits charged and tokens metered per
run, which is exactly the pricing-calibration data `CreditConfiguration`'s own
comments ask for.

The gate-side decisions it is too slow to enumerate — the paid-deck exemption,
the per-task meter reset, cache-hit billing — are pinned cheaply by
`Agent/Verification/VerifyCreditGate.py`, which needs no model calls:

```bash
cd Agent && .venv/Scripts/python.exe Verification/VerifyCreditGate.py
```

> **A SKIPPED case fails the gate.** Both suites mark a case SKIPPED when the
> environment could not exercise it — most often because the sync backend never
> settles and leaves the app behind the non-dismissible "Restoring sync state"
> modal. That is not a pass, so the gate stops the deploy and names the reason.
> If you hit it, check that Dock's MongoDB and Redis are reachable **and
> responsive** from the machine you are deploying from.

### Why these run at all

**Why this is a deployment gate and not an optional check.** These suites drive
the real UI — they click real deck tiles, three-dot menus, popups, pickers and
editors, and they assert that each highlighted control is genuinely on screen and
clickable. That makes them the first thing an unrelated frontend change breaks,
and the breakage is invisible in code review: a renamed CSS class, a newly
introduced intermediate popup, a panel that now mounts collapsed, or a page that
leaves an extra element in the DOM is enough to strand a new user mid-tour. A
broken tour is also the *first* thing a brand-new user sees, since the Beginners
tour auto-plays on first launch.

**What a run does:**

1. Builds the production frontend. This happens on **every** environment, before
   and independently of the gates, so the suites test the exact bundle that will
   ship and `update_base_node` does not rebuild it. (Building up front also keeps
   the Windows `tar` race away from the freshly-written `Dock/Static`.)
2. Starts a local Dock if one isn't already answering (installing Puppeteer into
   `Common/Testing/Main` on first use).
3. Runs the tutorial walkthrough, then the critical-flow and synchronisation
   suites. All three load the app with `?tutorialE2E=1` — for the tours that is the
   control seam, for the flow suite it only suppresses first-launch autoplay so
   the tour overlay does not swallow the suite's clicks.
4. Stops the Dock it started and fails the deploy unless every suite reports
   `PASS`. A `SKIPPED` result **also fails the gate** — a skipped run proves
   nothing.

**Prerequisites (one-time; needed only for a production deploy or a hand-run
suite — a development/testing deploy needs none of them):**

- **Redis + MongoDB reachable per `Dock/.env`** — the same local stack
  `npm run web` uses.
- **`TUTORIAL_TEST_SESSION_COOKIE`** in `deployment.env`: a `sessionId` for a
  seeded, **terms-accepted local test account**. Create one and print the id
  with:
  ```bash
  node Common/Testing/Main/seed_browser_test_account.js
  ```
  Then confirm the machine can actually host the suites — reachable **and
  responsive** Mongo/Redis, Dock serving the current build, session reaching the
  authenticated shell:
  ```bash
  TEST_SESSION_COOKIE=<sessionId> node Common/Testing/Main/check_browser_gate_environment.js
  ```
  Use a dedicated throwaway account, never a real or production session — the
  suites create and delete decks, cards and study materials on whatever account
  they run as (tutorial-created entities are flagged and cleaned up on
  finish/skip, and the flow suite deletes its own fixture, but they are still
  real writes). Optionally set `TUTORIAL_TEST_BASE_URL` (default
  `http://127.0.0.1:3000`) to point at a server you manage yourself.

> **Running and repairing these interactively** — bringing the environment up in
> the right order, driving the suites in a visible browser, and the
> symptom → cause → fix table for everything they commonly trip over — is
> packaged as the **`run-browser-gates`** skill
> ([.claude/skills/run-browser-gates/SKILL.md](../../.claude/skills/run-browser-gates/SKILL.md)).
> Reach for it whenever a deploy is blocked here or a tour misbehaves.

**Reading a failure.** The console prints a per-step / per-case trace; the full
structured result is written to `Common/Reports/.results/tutorial-ui.json` and
`Common/Reports/.results/critical-flow-ui.json` — for the tours, what the
spotlight landed on and which popups were open at each step; for the flows, what
each case observed. To reproduce and watch it happen in a visible window:

```bash
HEADFUL=1 SLOW_MO_MS=120 VERBOSE=1 \
TEST_SESSION_COOKIE=<local-session-id> \
    node Common/Testing/Main/run_tutorial_ui_tests.js

HEADFUL=1 VERBOSE=1 TEST_SESSION_COOKIE=<local-session-id> \
    node Common/Testing/Main/run_critical_flow_tests.js

HEADFUL=1 VERBOSE=1 TEST_SESSION_COOKIE=<local-session-id> \
    node Common/Testing/Main/run_sync_ui_tests.js
```

The sync suite's result lands in `Common/Reports/.results/sync-ui.json`. Two of
its knobs are worth knowing: `KEEP_FIXTURES=1` leaves the fixture deck and its
seeded cards behind so a failure can be inspected in the app, and
`DRAIN_CARD_COUNT` raises or lowers how much data the drain cases move (keep it
above the server's `MAX_PULL_PER_COLLECTION`).

> **Restart Dock after any rebuild.** Dock indexes `Dock/Static/` **once at
> boot**, so a server started before a `npm run setup` keeps serving the previous
> build's bundle-chunk filenames and every chunk 404s — the app then never boots
> and the suite reports "seam not found". The gate starts its own Dock after
> building for exactly this reason.

`--skip-tutorial-tests` bypasses all three gates. Since they are production-only,
the flag is a no-op on development and testing. It exists for infrastructure-only
production roll-outs (a config or scaling change with no frontend delta); do not
use it to push past a red suite.

## 1.1.2 Node reachability — power state + firewall allow-list (automatic)

Before it spends a minute on anything else, `deploy-environment.sh` checks that
the environment's Linode is actually **on** and that **this machine** can SSH to
it, and fixes both if not — using the `LINODE_API_TOKEN` already in
`deployment.env`. Everything it changes is reverted when the run ends.

This runs first on purpose. Both failure modes otherwise surface as an SSH
timeout *after* a bakebox has been created and an image captured — expensive,
slow, and misleading.

**What it checks, in order:**

1. **Does the base node exist?** Looks up the Linode labelled
   `CogniumLearn-<Env>-Server`. If there isn't one, the environment was never
   provisioned — it stops and tells you to run `provision-environment.sh`.
2. **Is it powered on?** Development and testing get parked to save money. If
   the node is `offline` it is **booted** and the run waits for `running`.
3. **Is this machine's IP allowed to SSH in?** Your public address is detected
   (`api.ipify.org`, falling back to `checkip.amazonaws.com`) and checked
   against the inbound rules of `CogniumLearn-<Env>-SrvFW`. The check
   understands CIDR containment and port ranges, so a rule covering
   `203.0.113.0/24` or ports `20-30` correctly counts as already allowing you.
4. **If not allowed**, the firewall's **exact current rules are snapshotted to a
   temp file** and a temporary `temp-deploy-ssh` ACCEPT rule for TCP/22 from
   your `/32` is **prepended** to inbound (prepended, not appended — Linode
   evaluates inbound rules in order).
5. **Then it proves it** by actually SSHing in, rather than assuming steps 2–4
   worked.

**What is reverted, on every exit path** — success, failure and Ctrl-C alike
(it hangs off the same `trap ... EXIT` as the rest of the cleanup):

| Change | Revert |
|---|---|
| Temporary firewall rule | The snapshotted rules are written back **verbatim** — a restore, not an attempted undo of a diff. If that API call fails, the snapshot file is **kept** and its path plus the exact `PUT /networking/firewalls/<id>/rules` to run is printed. |
| Node booted from `offline` | Powered back off, returning it to the state it was found in. The deployed code is already on disk and goes live the next time it boots. |

> **The shutdown retries on "Linode busy".** A node that has just booted refuses
> power commands for a while (`HTTP 400 — Linode busy.`), so `linode_power_off`
> waits for the instance to leave its transitional state and retries up to five
> times. Without that the very node the run had promised to put back was left
> running — observed on the first live run against development.

> **Production is never powered back off.** If production was somehow found
> offline and booted to deploy, shutting it down again would take the site down,
> so the run leaves it **running** and says so loudly. That asymmetry is
> deliberate.

> **`--keep-node-running`** leaves a node that was booted for the deploy up
> afterwards — use it when you are about to deploy again, or want to poke at the
> environment.

> **If your public IP cannot be determined, the deploy stops.** It will not fall
> back to opening SSH to `0.0.0.0/0`. Set `ADMIN_SSH_CIDR` in `deployment.env`
> or fix outbound access to the IP-echo services.

Skipped entirely when `--skip-base-update` is passed — that run never touches
the node, so it needs neither power nor access.

## 1.2 The worker Docker image — built on the bake box, not on Windows

Burst VMs run the Agent as a Docker container, built from the `Agent/` directory with:

```bash
docker build -t cogniumlearn-agent -f Dockerfile .
```

> **Build this on the Debian 12 Linode bake box (§1.10), not on your Windows dev box.**
> Docker Desktop on Windows *can* produce the Linux image, but in practice it's the
> worst place to build this one:
> - **It's slow and fragile.** The build pulls ~2 GB of wheels (CPU `torch`, `opencv`,
>   `PyMuPDF`, `scipy`, …) plus a large apt layer. On a home connection that's 20–40 min
>   of downloads through the Docker Desktop Linux VM, and the daemon/WSL backend wedges
>   often enough to be a recurring time sink.
> - **You'd then have to ship a ~3 GB image *up* your home uplink.** The documented
>   alternative was `docker save` → `scp` the tar to the bake box → `docker load` — and
>   that multi-GB upload over a residential connection is the single most painful step in
>   the whole deploy, often slower than the build itself.
>
> Building **on the bake box** eliminates both: a Linode in the datacenter pulls the same
> wheels at tens of MB/s (build drops to a few minutes), and the image lands **already on
> the machine where you bake it** — no `save`/`scp`/`load` of a 3 GB tar at all. You build
> where you bake. See §1.10 for the exact commands (clone the repo on the box → `docker
> build` → trim → capture). The Windows `prepare-for-deployment` skill remains available
> for a local sanity build, but is no longer the deployment path.

The image properties below are location-independent — they hold wherever you build it:

- The image is **Debian/glibc, multi-stage** — deliberately not Alpine, because the
  worker pulls `torch`, `opencv`, `scipy`, `pypdfium2`, etc., which ship prebuilt
  glibc wheels; musl (Alpine) would force slow, fragile source builds.
- **Kept small for the 6 GB Image cap** (~2.5 GB): `requirements.txt` pins
  **`torch`/`torchvision` to the `+cpu` build** from the PyTorch CPU index (burst VMs
  have no GPU; the default Linux CUDA wheels drag in ~2.5 GB of `nvidia-*` libs), and
  the Dockerfile **strips debug symbols** from the compiled `.so` files. Don't undo
  either or the bake-box capture (step 1.10) will blow the cap.
- **OCR stack baked in** — the runtime stage apt-installs `ocrmypdf` + `tesseract-ocr`
  + `ghostscript` (the `OcrPdf` workflow shells out to `ocrmypdf`, a system binary).
  Adds ~0.3–0.5 GB, so the image lands ~3 GB — still under the cap, but mind the margin
  when capturing. **If you change this, re-bake the burst Image (§1.10).**
- `Agent/requirements.txt` is an exact `pip freeze` of the Agent venv. If you changed
  Agent dependencies, refresh it first:
  ```bash
  python -m pip freeze | grep -v -i '^asyncio==' > requirements.txt
  ```
  > The `asyncio` PyPI package is excluded on purpose — it shadows the Python 3.12
  > stdlib `asyncio` and breaks the container.
  > After a re-freeze, **re-add** the `--extra-index-url https://download.pytorch.org/whl/cpu`
  > line and the `+cpu` suffixes on `torch`/`torchvision` (freeze drops them).
  > A re-freeze also drops the explanatory comments above `pypdfium2` and `svglib` —
  > **re-add those too**; they are what stops someone reintroducing an AGPL PDF
  > library. Then run the licence gate (§2.2.1) before baking.

There's no image to move — you build it on the bake box in §1.10 and capture it there.

## 1.3 Linode — create the VPC and base node

1. Create a **Linode VPC** in your target region with one **subnet**. Note the VPC
   id and subnet id (used later as `BURST_VPC_ID`, `BURST_SUBNET_ID`).
2. Create the **base node** (a strong Linode) and attach it to the VPC.
3. Install on the base node:
   - **Node.js** (to run Dock).
   - **Python 3.12** for the local workers — it must match the worker image's 3.12.
     Debian's apt usually lacks 3.12 (bookworm ships 3.11, so `apt install python3.12`
     fails with "Unable to locate package"); install a standalone build with `uv`
     instead — see step 1.4 (no apt, no compiling).
   - **MongoDB** and **Redis**.
   - **OCR stack** — `ocrmypdf`, `tesseract-ocr`, `ghostscript`. The `OcrPdf` workflow
     shells out to the `ocrmypdf` CLI (a *system* binary, not a pip wheel); without it
     the worker fails with `spawn ocrmypdf ENOENT`. Add `tesseract-ocr-<lang>` for
     non-English documents.
   - Docker is **not** required on the base node (its workers run from the venv, not
     a container).
4. **Bind Redis and MongoDB to the base node's private VPC IP** (not the public IP).
   Burst VMs will reach them over the VPC; nothing is exposed publicly. Note those
   URLs (e.g. `redis://10.0.0.2:6379`, `mongodb://10.0.0.2:27017`) — they become
   `BURST_WORKER_REDIS_URL` / `BURST_WORKER_MONGODB_URL`. Redis/Mongo can live on the
   base node or on separate Linodes in the same VPC; if separate, each gets its own VPC
   IP (e.g. Mongo at `10.0.0.3`) and its own firewall (below).
5. **Create Cloud Firewalls** — all with **inbound policy DROP, outbound ACCEPT**, and
   sources for data ports set to the **VPC CIDR** (e.g. `10.0.0.0/24`), never public:

   | Firewall | Inbound rules | Attach to |
   |---|---|---|
   | **Base/Dock** | SSH `22` ← *your admin IP* ; Redis `6379` ← VPC CIDR (if Redis is here) | base node |
   | **Database** | SSH `22` ← *your admin IP* ; Mongo `27017` ← VPC CIDR | the Mongo node |
   | **Burst** (`BURST_FIREWALL_ID`) | **none** — inbound DROP, no rules | every burst VM, set via `BURST_FIREWALL_ID` |

   - **No public web port** anywhere — Dock is reached through the Cloudflare Tunnel
     (step 1.8), so the base firewall needs no `80`/`443`/`3000`.
   - **Burst VMs need zero inbound** — they only make outbound connections (Redis/Mongo
     over the VPC, Gemini/OpenAI over the internet), and Cloud Firewalls are stateful so
     replies are allowed automatically. Keep the burst firewall inbound-empty; **do not**
     leave an SSH rule on it (every burst VM would get world-open SSH).
   - **SSH** — restrict the `22` source to your admin IP `/32`, not `0.0.0.0/0`.
6. **Default-route gotcha (dual-homed nodes).** If you create a node in the Cloud Manager
   with **both** a VPC and a public interface using the newer **Linode Interfaces** model,
   make sure the **public** interface holds the **IPv4 default route** — otherwise SSH and
   all outbound internet break (reply packets route out the dead-end VPC interface and the
   instance looks "up but unreachable"). Fix: power off → set the public interface as the
   IPv4 default route (Network tab, or `PUT …/interfaces/settings`
   `{"default_route":{"ipv4_interface_id":<publicInterfaceId>}}`) → boot. Burst VMs created
   by the autoscaler use the legacy config-interface model with the public interface as
   `eth0`, so they're unaffected — this only bites manually-created nodes.

## 1.4 Base node — deploy the code and Python venv

> ⚡ **Automated path.** Once the repo is cloned and `Dock/.production.env` +
> `Agent/.production.env` (§0.3 — gitignored, so copy them in manually) are in place,
> **[`Common/Scripts/setup-base-node.sh`](../Scripts/setup-base-node.sh)**
> does all of §1.4–§1.7 in one shot: installs the OCR stack + Redis (bound to the VPC
> IP) + Node, sets up Python 3.12 via `uv` and the Agent venv, runs `npm install`, and
> registers + starts the Dock systemd service. Run it with
> `sudo bash Common/Scripts/setup-base-node.sh`. The manual steps below document what
> it does (and the Cloudflare Tunnel in §1.8 + the burst firewall stay manual).

1. Clone/copy the repo to a directory of your choice — call it `<repo-dir>`. The paths
   in this guide use `/opt/cogniumlearn/CogniumLearn` as the example, but anywhere works (e.g.
   `/root/cogniumlearn` if you deploy as root). **Whatever you pick, the same absolute path
   must be used consistently in three places** or the local workers won't start:
   - the **Agent venv** lives at `<repo-dir>/Agent/.venv` (created in step 3 below),
   - **`AGENT_SERVICE_PATH`** in `Dock/.production.env` is set to `<repo-dir>/Agent` (§1.5),
   - the **systemd unit**'s `WorkingDirectory` is `<repo-dir>/Dock` (§1.9).

   > Pick the layout up front. If you deploy under `/root/...`, run everything as `root`
   > and **drop the `User=cogniumlearn` line** from the systemd unit (§1.9) — a non-root
   > `cogniumlearn` user can't traverse `/root`. If you want a dedicated `cogniumlearn` user,
   > deploy under `/opt/cogniumlearn` (or another world-traversable path) instead. Don't mix
   > the two.
2. **Install Python 3.12** (no apt package on Debian — use a standalone build via `uv`,
   which needs no compiling):
   ```bash
   curl -LsSf https://astral.sh/uv/install.sh | sh
   source $HOME/.local/bin/env
   ```
3. **Create the Agent venv and install dependencies** (CPU torch + ML stack, ~10–15 min):
   ```bash
   cd <repo-dir>/Agent                      # the Agent dir inside wherever you cloned
   uv venv --python 3.12 .venv
   uv pip install --python .venv/bin/python --index-strategy unsafe-best-match -r requirements.txt
   ```
   (`--index-strategy unsafe-best-match` is required: `requirements.txt` adds the
   PyTorch CPU index for `torch`, and uv otherwise resolves every package against the
   first index that has it — finding e.g. `certifi` there at the wrong version and
   failing. The flag makes uv consider all indexes, like pip does.)
   The venv **must** live at exactly `Agent/.venv`. Dock's `LocalWorkerSupervisor`
   (and the AskAi / paid-deck subprocess spawns) launch `Agent/.venv/bin/python3`
   directly via `getPythonExecutablePathFromVenv`, so a global Python or a venv
   elsewhere produces `spawn …/Agent/.venv/bin/python3 ENOENT` and the workers never
   start (Dock still serves, but nothing drains the queue locally).
   > If `pip`/`uv` is OOM-killed installing `torch`/`scipy` on a small base node, add
   > temporary swap and re-run:
   > `sudo fallocate -l 4G /swap && sudo mkswap /swap && sudo swapon /swap`
   > Once the install finishes, remove it (it was only needed for the build):
   > `sudo swapoff /swap && sudo rm /swap`

## 1.5 Base node — configure `Dock/.env`

Dock reads `Dock/.env` at boot (via dotenv, relative to its working directory). Copy
`Dock/.env.example` to `Dock/.env` and fill it in. **Every term explained:**

**Required**

- `MONGODB_URL` — MongoDB connection string. If Mongo runs on a **separate** node whose
  firewall only allows `27017` from the VPC (`10.0.0.0/24`), Dock must connect over the
  **VPC private IP** (e.g. `mongodb://…@10.0.0.3:27017/…`), **not** the public IP — a
  public-IP connection comes from Dock's public address and gets dropped by that
  firewall. Also ensure Mongo's `bindIp` includes the VPC IP (or `0.0.0.0`), or it
  won't accept the VPC connection at all.
- `MONGODB_DATABASE_NAME` — the database name (e.g. `cogniumlearn`).
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Google OAuth credentials for sign-in
  (from Google Cloud Console). The authorized redirect URI must be
  `https://<your domain>/Login/Callback`.
- `PAID_DECK_MASTER_KEY_BASE64` — root secret of the paid-deck encryption scheme; a
  base64-encoded **32-byte** AES key. Generate once:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```
  **Back it up and never change it once any paid deck exists** — changing/losing it
  makes all encrypted assets and buyer licenses permanently undecryptable. If unset
  or not exactly 32 bytes, every paid-deck write endpoint returns 503.

**Recommended**

- `DOMAIN_NAME` — your public domain (e.g. `app.example.com`). Used to build OAuth
  redirect URLs. If blank, Dock assumes `127.0.0.1:3000` (dev only).
- `REDIS_URL` — Redis URL for the task queue and FX cache (defaults to
  `redis://127.0.0.1:6379`).
- `ECB_RATES_URL` — European Central Bank FX feed for regional pricing (has a sane
  default).

**AI / Agent**

- **LLM auth is NOT set in `Dock/.env`.** Dock makes **no** LLM calls — every AI
  request is delegated to the Agent (run locally as a spawned/queued worker, or on a
  burst VM). The Agent talks to Google's enterprise **Vertex AI** backend and
  authenticates with a **service account** (strongly preferred) or an API key
  (slow fallback):
  - `GOOGLE_ENTERPRISE_AGENT_PROJECT` — the GCP project id (e.g. `cogniumlearn-500509`).
  - `GOOGLE_ENTERPRISE_AGENT_LOCATION` — Vertex region; defaults to `global`.
  - `GOOGLE_ENTERPRISE_AGENT_CREDENTIALS_BASE64` — `base64 -w0` of a *Vertex AI User*
    service-account key JSON for that project. Blank ⇒ ambient ADC.
  - `GOOGLE_ENTERPRISE_AGENT_API_KEY` — **fallback only,** used when no project is set.
    Vertex's API-key path is ~5–6× slower to first token for streaming (~12 s vs ~1 s
    with a service account — the model is fine, the auth path isn't), so AskAi and
    every other call are dramatically faster on the service account. Prefer it.

  These live **only** in the **Agent** env file (`Agent/.env` with `--debug`, else
  `Agent/.<env>.env`), alongside `OPENAI_API_KEY`. Dock reads that **sibling** file
  (same relative layout: `Agent/` next to `Dock/`) for the **single** purpose of
  forwarding these values to burst workers via cloud-init — see
  `BurstFleetSettings.getWorkerRuntimeEnvironment` → `#readAgentLlmKeys` (project /
  location / credentials / api-key / OpenAI). Dock never injects them into its own
  process. Consequence: the Agent env file must exist next to `Dock/` on the base
  node, and you edit auth in **one place** (the Agent env file), never in Dock's.

  **Creating the service-account key** (once per environment/project): Google Cloud
  console → IAM & Admin → Service Accounts → create → grant **Vertex AI User**
  (`roles/aiplatform.user`; the console may display this as "Agent Platform User") →
  Keys → Add key → JSON → download; ensure the **Vertex AI API** is enabled in the
  project. Then `base64 -w0 the-key.json` and paste the output as
  `GOOGLE_ENTERPRISE_AGENT_CREDENTIALS_BASE64`. Base64 (not a file path) is used so the
  same value ships in the line-based env file and is injected verbatim into each burst
  VM's `worker.env` — no key file on disk, none baked into an image.
- `AGENT_SERVICE_PATH` — absolute path to the Agent service so Dock can launch local
  workers reliably. Set it to `<repo-dir>/Agent` (e.g. `/opt/cogniumlearn/CogniumLearn/Agent`,
  or `/root/cogniumlearn/Agent` for a root deploy). It **must** match where the venv was
  created in §1.4 — Dock spawns `<AGENT_SERVICE_PATH>/.venv/bin/python3`, so a mismatch
  gives `spawn …/.venv/bin/python3 ENOENT` and nothing drains the queue locally.

**Payments (set the providers you use)**

- `DEFAULT_PAYMENT_PROVIDER` — `RAZORPAY` | `STRIPE` | `PAYPAL`.
- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`,
  `STRIPE_SECRET_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` — provider creds.

**Email (SMTP, optional)** — `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`,
`SMTP_SOURCE_EMAIL` for transactional email.

**Rate limiting (optional)** — `RATE_LIMIT_*` knobs; blank values use sane defaults.

> The task-queue / burst-fleet / maintenance variables are also in this file; they
> are explained in [step 1.9](#19-base-node--configure-the-fleet) where you turn the
> fleet on.

## 1.6 Base node — configure `Agent/.env`

The Agent workers read `Agent/.env` (the local workers run with the Agent directory
as their working directory). It needs:

- `REDIS_URL` — the queue (same Redis as Dock).
- `MONGODB_URL`, `MONGODB_DATABASE_NAME` — the database the workflows read/write.
- `GOOGLE_ENTERPRISE_AGENT_PROJECT` + `GOOGLE_ENTERPRISE_AGENT_CREDENTIALS_BASE64`
  (+ optional `GOOGLE_ENTERPRISE_AGENT_LOCATION`, default `global`) — Vertex AI
  service-account auth for the workflows. `GOOGLE_ENTERPRISE_AGENT_API_KEY` is a slow
  fallback; prefer the service account (see §1.5).
- `OPENAI_API_KEY` — only if you use OpenAI-backed workflows.
- `WEB_SCRAPE_CONTACT_EMAIL` — optional contact email used in the web-scraping
  workflow's User-Agent.

### Content guardrail (all optional; the defaults are the intended production posture)

Every piece of text a model returns inside the Agent is scanned against the vendored
LDNOOBW word list ([Agent/ThirdParty/Ldnoobw/](../../Agent/ThirdParty/Ldnoobw/README.md)).
A hit is sent to `gemini-2.5-flash-lite` with 25 words of context either side to judge
whether the usage is abusive or merely clinical, quoted or academic; an abusive verdict
removes the sentence and writes a `CONTENT_GUARDRAIL` entry to `logEvents`. It is on by
default and needs no configuration — these knobs exist for rollout and incident response.

- `CONTENT_GUARDRAIL_ENABLED` — default `true`. The kill switch. `false` takes the whole
  feature out of the path without a deploy.
- `CONTENT_GUARDRAIL_ENFORCEMENT_ENABLED` — default `true`. `false` is shadow mode: it
  still scans, adjudicates and logs (outcome `SHADOW_LOGGED`, with `wouldBeOutcomeName`
  recording what enforcement would have done) but removes nothing. Run this for a week
  on a new environment if you want the real hit rate before it starts editing text.
- `CONTENT_GUARDRAIL_INCLUDE_CLINICAL_TERMS` — default `false`. The word list contains
  `sex`, `rape`, `anus`, `semen`, `xx` and about ninety more terms that are ordinary
  vocabulary in NEET Biology, medicine and IPC/POCSO law, so they are subtracted via
  [AcademicTermAllowlist.txt](../../Agent/Globals/Classes/Compliance/AcademicTermAllowlist.txt).
  Setting this to `true` scans the full upstream list — expect a verification call on
  nearly every biology and law generation.
- `CONTENT_GUARDRAIL_FAIL_CLOSED` — default `false` (fail **open**). When the
  adjudication cannot be completed — timeout, provider error, unparseable reply — the
  text is kept and the failure logged. A wrongly deleted sentence silently corrupts
  study material a student paid for; a wrongly kept one is in `logEvents` and reviewable.
  `true` inverts that and removes the sentence instead.

Verify a change to any of these with
`Agent/.venv/bin/python Verification/VerifyContentGuardrail.py` (add
`VERIFY_CONTENT_GUARDRAIL_NETWORK=1` for one real adjudication).

## 1.7 Base node — build the frontend & generated files

The Node server serves the SPA from `Dock/Static/`, which is produced by the build.
On your dev box you'd run `npm run setup` (which runs exactly the steps below — the
aggressive build is always applied); on the Debian base node run the same steps
directly (they are the plain Node scripts `npm run setup` invokes). What each does:

```bash
cd /opt/cogniumlearn/CogniumLearn
node ./Common/Scripts/GenerateServiceManifest.js   # service registry for codegen
node ./Common/Scripts/GenerateEnumerations.js      # Common/Enumerations → each service
node ./Common/Scripts/GenerateConstants.js         # Common/Constants    → each service
node ./Common/Scripts/GenerateClasses.js           # Common/Classes      → each service
node ./Common/Scripts/CopyStaticFiles.js           # Main/ → Dock/Static/ (what the server serves)
# bundling + obfuscation for production (the aggressive part `npm run setup` always runs):
node ./Common/Scripts/BundleStaticFiles.js
node ./Common/Scripts/ManglePrivateMembersInBundle.js
node ./Common/Scripts/MinifyAndObfuscateStaticFiles.js --aggressive
```

- The first five steps are the **mandatory** codegen + static sync. Without
  `CopyStaticFiles.js`, `Dock/Static/` is empty and the app won't load.
- The last three are the production hardening: they bundle, mangle private members,
  and minify/obfuscate the served frontend. `npm run setup` always runs them (there
  is no non-aggressive build), so a dev build and a deploy build are identical.

> If you prefer, build on your dev box with `npm run setup` and deploy the whole repo
> (including the built `Dock/Static/`). Either way the artifacts are identical — these
> are cross-platform Node scripts, driven by the root `package.json`. To run the server
> the way the base node does (no `--debug`), use `npm run production` locally.

## 1.8 Base node — expose it on your domain via Cloudflare Tunnel

OAuth requires your real `https://<domain>`. This deployment uses a **Cloudflare
Tunnel**, which terminates TLS at Cloudflare's edge and forwards to Dock on
`127.0.0.1:3000` over an encrypted outbound tunnel — so the base node exposes **no
inbound ports** (no public `3000`, no nginx/certs to manage).

Every environment — including production — uses a **remotely-managed (token-based)
tunnel**, the same mechanism described in §0.3: no local `config.yml` or credentials
JSON on the base node at all. `BaseNodeUpdate.sh` installs `cloudflared` if missing
and runs `cloudflared service install "$CLOUDFLARE_TUNNEL_TOKEN"` on every deploy
(idempotent — safe to re-run), where `CLOUDFLARE_TUNNEL_TOKEN` is resolved from
`CLOUDFLARE_TUNNEL_TOKEN_<ENV>` in `deployment.env`.

To set it up (once per environment):

1. In the Cloudflare Zero Trust dashboard, create (or reuse) a tunnel and add a
   **Public Hostname** route for that environment's domain
   (`learn.cogniumlabs.io` for production, `development-learn.cogniumlabs.io`,
   `testing-learn.cogniumlabs.io`) pointing at `http://127.0.0.1:3000` (`HTTP`,
   not `HTTPS` — Dock terminates plain HTTP behind the tunnel). This also creates
   the DNS CNAME automatically.
2. Copy the tunnel's **token** (Zero Trust → Networks → Tunnels → the tunnel →
   Configure → the `cloudflared service install <token>` command shown there —
   just the token portion) into `deployment.env` as `CLOUDFLARE_TUNNEL_TOKEN_<ENV>`.
3. Deploy (or re-run `BaseNodeUpdate.sh` via `deploy-environment.sh`) — cloudflared
   installs itself as a systemd service and starts routing immediately.

Then in `Dock/.env` set `DOMAIN_NAME=learn.cogniumlabs.io`, and in the Google
OAuth client set the authorized redirect URI to
`https://learn.cogniumlabs.io/Login/Callback`. (In Cloudflare, keep SSL/TLS mode
at **Full** so the edge trusts the tunnel.)

## 1.9 Base node — run Dock on boot (systemd)

This is what makes everything start when the server boots: a systemd service runs
`node index.js` (no `--debug`), which on launch starts the local workers and the
autoscaler. **Working directory must be `Dock/`** so dotenv loads `Dock/.env`.

`/etc/systemd/system/cogniumlearn-dock.service`:

```ini
[Unit]
Description=CogniumLearn Dock server
After=network-online.target redis-server.service mongod.service
Wants=network-online.target

[Service]
Type=simple
User=cogniumlearn
WorkingDirectory=/opt/cogniumlearn/CogniumLearn/Dock
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

> Set `WorkingDirectory` to **`<repo-dir>/Dock`** — it must match the layout you chose
> in §1.4 (e.g. `/root/cogniumlearn/Dock` for a root deploy). If you deployed under `/root`,
> **delete the `User=cogniumlearn` line** (it runs as `root` by default); a non-root user
> can't traverse `/root`, so leaving it there gives a `status=200/CHDIR` start failure.
> Keep `User=cogniumlearn` only when the repo lives somewhere that user can read/execute
> (e.g. under `/opt/cogniumlearn`) and you've created that user.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cogniumlearn-dock.service
sudo journalctl -u cogniumlearn-dock -f      # watch the logs
```

> No `--debug` here — that's exactly what enables distributed mode in production.
> Restarting this service cleanly cycles the fleet (teardown → rebuild warm pool).

At this point the **server is up** and works with the base node's local workers even
before any burst VMs exist. The remaining steps add cloud bursting.

## 1.10 Image-bake box — bake the burst worker Image

Burst VMs boot from a pre-baked Linode custom Image so they start fast and run the
worker automatically.

> ⚡ **Automated path (recommended).** The whole bake → capture → roll-out → cleanup
> flow is automated by **[`Common/Deployment/deploy.sh`](../Deployment/deploy.sh)** —
> run `bash Common/Deployment/deploy.sh` from your dev box (Git Bash). It creates the
> bakebox, builds + trims the image, shrinks the disk and captures
> `CogniumLearnBurstVmImage<version>` (auto-incremented), then rolls it out to the base
> node and deletes the bakebox + older images. Configure it via `deployment.env` at the
> repo root (gitignored). See [Section 2.0](#20-automated-roll-out-recommended) and
> [Common/Deployment/README.md](../Deployment/README.md). The manual steps below
> document exactly what it does.

> **Do not image your live base node.** That would bake Dock + Redis + Mongo + your
> secrets into the worker image, and every burst VM would start its own Dock +
> autoscaler (recursive provisioning). Use a clean throwaway Linode.

1. Create a **temporary Debian 12 Linode** in the target region, attached to the VPC.
   This is also where you **build** the `cogniumlearn-agent` image (§1.2) — building in the
   datacenter is far faster than Windows Docker Desktop and means there's no multi-GB tar
   to upload from your dev box.
2. Install Docker, then **`scp` only the build context** onto the box and build it there:

   ```bash
   # Install Docker (Debian 12 / bookworm):
   curl -fsSL https://get.docker.com | sh
   ```

   The build context is just the `Agent/` directory **minus** the venv, caches, logs
   and env files — the same set `Agent/.dockerignore` keeps out of the image. `scp` does
   **not** honour `.dockerignore`, so mirror the excludes with `tar` and copy the (~1 MB)
   archive rather than `scp -r Agent` (which would drag the multi-GB `.venv` and, worse,
   your secrets):

   **On your Windows dev box** (from the repo root; replace `<bake-box-ip>`):
   ```bash
   tar --exclude='.venv' --exclude='venv' --exclude='__pycache__' --exclude='*.pyc' \
       --exclude='.env' --exclude='*.env' --exclude='Tasks' \
       --exclude='.pytest_cache' --exclude='.mypy_cache' --exclude='*.log' \
       -czf agent-context.tar.gz Agent
   scp agent-context.tar.gz root@<bake-box-ip>:/root/
   rm agent-context.tar.gz       # remove the local build-context archive once uploaded
   ```

   **On the bake box** — unpack and build:
   ```bash
   mkdir -p /root/CogniumLearn
   tar -xzf /root/agent-context.tar.gz -C /root/CogniumLearn && rm /root/agent-context.tar.gz
   cd /root/CogniumLearn/Agent
   docker build -t cogniumlearn-agent -f Dockerfile .
   docker images               # confirm cogniumlearn-agent:latest is present
   ```

   > Excluding `*.env` is **not optional** — those files hold the Gemini / OpenAI /
   > Mongo secrets and must never leave your dev box or enter the build context. (A
   > `git clone` of the repo on the box is a fine alternative when it can reach your
   > remote — the committed tree already omits the venv and env files.)
   >
   > Build the **committed** `Agent/requirements.txt` as-is. If a pinned version was
   > yanked from PyPI the build fails with `No matching distribution found` — fix it per
   > the Troubleshooting note (bump to the nearest patch, re-freeze), commit it, then
   > rebuild here so the box and the repo stay in lock-step.
   >
   > ⚠️ Never run `docker image prune -a` here — with no container running the image,
   > `-a` treats it as "unused" and **deletes the image you just built**. To drop a
   > replaced/old image use `docker image prune -f` (dangling only) or `docker rmi <id>`.
3. Install the worker systemd unit so the container auto-starts on boot and reads the
   env file that cloud-init writes at provision time:

   `/etc/systemd/system/cogniumlearn-worker.service`:
   ```ini
   [Unit]
   Description=CogniumLearn Agent worker
   After=docker.service network-online.target
   Requires=docker.service

   [Service]
   Restart=always
   EnvironmentFile=/etc/cogniumlearn/worker.env
   ExecStartPre=-/usr/bin/docker rm -f cogniumlearn-worker
   ExecStart=/usr/bin/docker run --rm --name cogniumlearn-worker --env-file /etc/cogniumlearn/worker.env cogniumlearn-agent
   ExecStop=/usr/bin/docker stop cogniumlearn-worker

   [Install]
   WantedBy=multi-user.target
   ```
   ```bash
   sudo mkdir -p /etc/cogniumlearn
   sudo systemctl enable cogniumlearn-worker.service
   ```
4. **Get under Linode's Image cap, then capture.** A captured Image requires the disk
   to be **≤ 6 GB** with **< 5.4 GB used** (ext3/ext4 only) — see
   [Capture an Image](https://techdocs.akamai.com/cloud-computing/docs/capture-an-image).
   A stock disk is 25 GB, so the capture **silently fails (image deletes itself
   mid-creation)** until you both free space *and* shrink the disk. The image itself is
   already kept small (~2.5 GB) by **CPU-only torch** and **symbol stripping** in
   `Agent/Dockerfile` — burst VMs have no GPU. Do these in order:

   **a. Clear the containerd image-store cache — the #1 gotcha.** Modern Docker stores
   images via the **containerd snapshotter in `/var/lib/containerd`**, NOT
   `/var/lib/docker` (which stays ~200 KB). Every `docker build`/`docker load` leaves
   **orphaned snapshots** there, and `docker image prune` / `docker builder prune` do
   **not** remove them — they pile up to many GB and quietly blow the cap. Confirm with
   `du`, then save → wipe the store → reload the one image:
   ```bash
   sudo du -sh /var/lib/containerd            # often several GB of orphans for one image
   docker save -o /root/mm.tar cogniumlearn-agent:latest
   sudo systemctl stop docker docker.socket containerd
   sudo rm -rf /var/lib/containerd/*
   sudo systemctl start containerd docker
   docker load -i /root/mm.tar && rm /root/mm.tar
   ```

   **b. Trim the OS** (safe — touches no images):
   ```bash
   sudo apt-get clean && sudo rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /usr/share/locale/*
   sudo journalctl --vacuum-size=10M 2>/dev/null; sudo rm -rf /var/log/*.gz /var/log/*.[0-9] /tmp/*
   docker container prune -f
   df -h /                                    # used must be < 5.4 GB before continuing
   ```

   **c. Power off, shrink the disk to 6 GB, then capture.**
   ```bash
   sudo poweroff
   ```
   Then (Linode is off): resize the ext4 disk down to **6144 MB** — dashboard → the
   Linode → **Storage** → the disk → *Resize*, or API
   `PUT /v4/linode/instances/{linodeId}/disks/{diskId}` body `{"size":6144}`. Finally
   capture: dashboard → the Linode → **Create Image**, or API
   `POST /v4/images` body `{"disk_id":<diskId>,"label":"cogniumlearn-burst-worker"}`. When
   it reaches *available*, use its id (`private/NNNNNNNN`) as `BURST_IMAGE_ID`. (If the
   image 404s / deletes itself mid-creation, it's still over the cap — go back to a/b.)
5. **Delete the temporary Linode** — you only needed it to produce the Image.

**How a burst VM then starts working:** when the autoscaler creates one,
`LinodeComputeProvider.createInstance` boots it from `BURST_IMAGE_ID`, attaches a
public interface (egress) **and** the VPC interface (private Redis/Mongo), binds it
to `BURST_FIREWALL_ID`, tags it `BURST_MANAGEMENT_TAG`, and passes cloud-init user-data that writes
`/etc/cogniumlearn/worker.env` (private Redis/Mongo URLs + AI keys) and restarts
`cogniumlearn-worker.service`. The container then drains the queue.

## 1.11 Base node — configure the fleet

Add the task-queue / burst variables to `Dock/.env`. **Every term explained:**

**Master switches**

- `DOCK_USE_TASK_QUEUE` (default `0`) — `1` enables queue + workers + autoscaler.
- `AGENT_LOCAL_WORKER_COUNT` (default `2`) — worker processes Dock keeps running on
  the base node (the always-warm baseline).
- `DEFAULT_CLOUD_COMPUTE_PROVIDER` (default `LINODE`) — which cloud backend to use.

**Linode / provisioning**

- `LINODE_API_TOKEN` — Linode token with Linodes read/write scope.
- `BURST_REGION` — region for burst VMs (e.g. `ap-south`).
- `BURST_IMAGE_ID` — the baked Image id from step 1.10.
- `BURST_INSTANCE_TYPE` — burst VM type (smaller/cheaper, e.g. `g6-standard-2`).
- `BASE_INSTANCE_TYPE` — documentation only; the base node is provisioned by hand.
- `BURST_VPC_ID` / `BURST_SUBNET_ID` — the VPC/subnet from step 1.3.
- `BURST_FIREWALL_ID` (**required**) — numeric id of the Cloud Firewall every burst VM
  is bound to **at creation** (use a dedicated burst firewall: inbound **DROP**,
  outbound **ACCEPT**). Burst VMs are **dual-homed** — a public interface for outbound
  internet (Gemini/OpenAI) plus the VPC interface for private Redis/Mongo — so this
  firewall's inbound-DROP is their network protection. **Fail-closed:** if unset, the
  provider reports "not configured" and **no burst VM is ever created**. Find the id
  in Linode Cloud Manager → Firewalls, or `GET /v4/networking/firewalls`.
- `BURST_WORKER_REDIS_URL` / `BURST_WORKER_MONGODB_URL` — private-IP URLs burst VMs
  use (fall back to `REDIS_URL` / `MONGODB_URL` if unset).

**Scaling shape**

- `BURST_MANAGEMENT_TAG` (default `cogniumlearn-burst`) — tag identifying managed VMs;
  the autoscaler **only ever touches** instances with this tag.
- `BURST_LABEL_PREFIX` (default `cogniumlearn-burst-`) — label prefix for created VMs.
- `BURST_WARM_POOL_SIZE` (default `2`) — always-on burst VMs. `0` = no idle burst
  VMs (base-node workers handle baseline; burst is pure overflow).
- `BURST_MAX_INSTANCES` (default `8`) — **hard cap** on burst VMs. Never exceeded.
- `BURST_TASKS_PER_INSTANCE` (default `2`) — queued tasks one VM is sized to absorb
  (drives scale-up demand).
- `BURST_IDLE_TIMEOUT_SECONDS` (default `600`) — idle time before a VM is eligible
  for shutdown.
- `BURST_RECONCILE_INTERVAL_SECONDS` (default `30`) — how often the autoscaler polls
  and reconciles.
- `BURST_SCALE_UP_COOLDOWN_SECONDS` (default `60`) — min gap between scale-ups (lets
  a new VM come online before adding more).
- `BURST_SCALE_DOWN_COOLDOWN_SECONDS` (default `300`) — min gap between scale-downs
  (cautious shrink).
- `BURST_SCALE_UP_BATCH` (default `1`) — max VMs created per scale-up tick.
- `BURST_DRY_RUN` (default `0`) — `1` simulates the autoscaler in memory (no API
  calls, zero spend).

**Worker tuning** (read by the Agent workers)

- `AGENT_WORKER_LEASE_SECONDS` (default `1800`) — liveness lease per running task,
  auto-refreshed; a crashed worker's task is requeued after it expires.
- `AGENT_WORKER_CLAIM_BLOCK_SECONDS` (default `5`) — idle poll interval when the
  queue is empty.
- `AGENT_WORKER_REAPER_INTERVAL_SECONDS` (default `60`) — how often a worker requeues
  orphaned tasks.
- `AGENT_WORKERS_PER_VM` (default `1`) — worker containers per burst VM (each competes
  on the same queue).
- `TASK_QUEUE_AWAIT_TIMEOUT_SECONDS` (default `10800`) — max time Dock waits for a
  queued task before treating it as failed (below the 5h task TTL).
- `TASK_QUEUE_AWAIT_POLL_MILLISECONDS` (default `1000`) — how often Dock polls a
  queued task's status.

**Maintenance**

- `MAINTENANCE_NOTICE_LEAD_HOURS` (default `24`) — how far ahead an upcoming window is
  shown to users.

**Minimal production block:**

```ini
DOCK_USE_TASK_QUEUE=1
DEFAULT_CLOUD_COMPUTE_PROVIDER=LINODE
LINODE_API_TOKEN=...your token...
BURST_REGION=ap-south
BURST_IMAGE_ID=private/12345678
BURST_INSTANCE_TYPE=g6-standard-2
BURST_VPC_ID=12345
BURST_SUBNET_ID=67890
BURST_FIREWALL_ID=98765
BURST_WORKER_REDIS_URL=redis://10.0.0.2:6379
BURST_WORKER_MONGODB_URL=mongodb://10.0.0.2:27017
BURST_WARM_POOL_SIZE=2
BURST_MAX_INSTANCES=6
```

## 1.12 Go live (ramp up safely)

Restart Dock after each change (`sudo systemctl restart cogniumlearn-dock.service`):

1. **Dry run.** `BURST_DRY_RUN=1` → confirm the autoscaler logs simulated scaling and
   the local workers drain real tasks. No spend.
2. **One real VM.** Real `LINODE_API_TOKEN`, `BURST_DRY_RUN=0`, `BURST_MAX_INSTANCES=1`
   → confirm exactly one tagged VM appears under load, processes a task, and is
   deleted after the idle timeout.
3. **Full capacity.** Raise `BURST_MAX_INSTANCES` (and `BURST_WARM_POOL_SIZE`) to your
   target.

Healthy logs look like:

```
[LocalWorkerSupervisor] Starting 2 local worker(s).
[BurstAutoscaler] Starting (dryRun=false, warmPool=2, maxInstances=6).
[BurstAutoscaler] Startup teardown: no inherited burst instances.
[BurstAutoscaler] pending=0 processing=0 current=2 desired=2 (cap=6).
```

### Quick test recipe — "does launching a task spawn agents / Linodes?"

Everything is controlled by env constants in `Dock/.env`. The single flag to flip
for a safe check is **`BURST_DRY_RUN=1`** — it runs the *entire* autoscaler (queue
read, scaling math, hard cap) and logs every decision, but makes **no API calls and
spends nothing**. Watch for `[BURST_DRY_RUN] Would create instance …`.

**Gotcha first:** the autoscaler is **disabled whenever Dock runs with `--debug`**
(`BurstAutoscaler.shouldRun()`). Test with the normal start (`node index.js`
from `Dock/`, no `--debug`) and read `Logger.log` output. It also needs `DOCK_USE_TASK_QUEUE=1`, and —
outside dry-run — the provider fully configured (token + region + image + type +
**`BURST_FIREWALL_ID`**), or it stays disabled.

| What you want to verify | Set in `Dock/.env` |
|---|---|
| The scaling path runs at all, zero spend | `DOCK_USE_TASK_QUEUE=1`, `BURST_DRY_RUN=1` |
| A Linode is created immediately, no task needed | `BURST_WARM_POOL_SIZE=1` (the warm pool is built at startup) |
| One launched task triggers a scale-up | `BURST_TASKS_PER_INSTANCE=1` **and** `AGENT_LOCAL_WORKER_COUNT=0` (so the base node doesn't drain the queue before burst reacts) |
| It reacts within seconds | `BURST_RECONCILE_INTERVAL_SECONDS=10`, `BURST_SCALE_UP_COOLDOWN_SECONDS=0` |
| Cap one real VM while smoke-testing | `BURST_DRY_RUN=0`, `BURST_MAX_INSTANCES=1` |

Then launch a generation task and watch the reconcile line move, e.g.
`[BurstAutoscaler] pending=1 processing=0 current=0 desired=1 (cap=1).` followed by
`[BurstAutoscaler] Created burst instance … (cogniumlearn-burst-…).` In a live (non-dry)
run, confirm in Linode Cloud Manager that the new instance is bound to the **same
firewall as the Dock Linode** (`BURST_FIREWALL_ID`). Restore your normal values
(`BURST_DRY_RUN`, `AGENT_LOCAL_WORKER_COUNT`, cooldowns, cap) when done.

### Fake-load test — make burst VMs spawn without doing any real work

You don't need real generations to test scaling. The autoscaler only counts how many
items are waiting in one Redis list — **`TaskQueue/pending`**. Put fake items in that
list and it reacts exactly as if real tasks arrived. Run all of this **on the base node**.

**Watch the decisions** — open one terminal and leave it running:
```bash
journalctl -u cogniumlearn-dock -f | grep -E "BurstAutoscaler|BURST_DRY_RUN"
```
Every line reads `pending=<items waiting> … desired=<VMs it wants> (cap=<max>)`.

**1. Make the test safe + quick.** In `Dock/.production.env` set these, then
`sudo systemctl restart cogniumlearn-dock`:
```ini
BURST_DRY_RUN=1                     # pretend mode: no real VMs, no cost
AGENT_LOCAL_WORKER_COUNT=0          # so the base node doesn't eat the fake items
BURST_TASKS_PER_INSTANCE=1          # 1 waiting item = wants 1 VM (easy to read)
BURST_RECONCILE_INTERVAL_SECONDS=10 # check every 10s instead of 30
BURST_SCALE_UP_COOLDOWN_SECONDS=0   # no wait between scale-ups
```

**2. Add fake work:**
```bash
for i in $(seq 1 12); do redis-cli RPUSH TaskQueue/pending "test-$i" >/dev/null; done
redis-cli LLEN TaskQueue/pending     # shows 12 items waiting
```
Within ~10s the log shows `pending=12 … desired=8 (cap=8)` and eight
`[BURST_DRY_RUN] Would create instance …` lines (8 = `BURST_MAX_INSTANCES`). It works.

**3. Remove the fake work and watch it shrink back:**
```bash
redis-cli DEL TaskQueue/pending TaskQueue/processing
```
The log returns to `pending=0 … desired=0`.

**To see a REAL VM boot** (costs a few cents), change two settings and repeat step 2:
```ini
BURST_DRY_RUN=0                  # real this time
BURST_MAX_INSTANCES=1            # only one VM, so spend is tiny
BURST_IDLE_TIMEOUT_SECONDS=60    # it deletes itself ~1 min after the queue empties
```
Now `Would create instance` becomes `Created burst instance …`, and a `cogniumlearn-burst-*`
Linode appears in the dashboard. Clear the queue (step 3) and it's deleted after the
idle timeout, or `sudo systemctl restart cogniumlearn-dock` removes all burst VMs at once.

**When done, put the normal values back** and clear leftovers:
```ini
BURST_DRY_RUN=0
AGENT_LOCAL_WORKER_COUNT=2
BURST_TASKS_PER_INSTANCE=2
BURST_MAX_INSTANCES=8
BURST_RECONCILE_INTERVAL_SECONDS=30
BURST_SCALE_UP_COOLDOWN_SECONDS=60
BURST_IDLE_TIMEOUT_SECONDS=600
```
```bash
redis-cli DEL TaskQueue/pending TaskQueue/processing
sudo systemctl restart cogniumlearn-dock
```

---

# Section 2 — Update deployment

How to push changes to production. Pick the case that matches what you changed. In
all cases, restarting Dock cleanly cycles the fleet (teardown → rebuild).

## 2.0 Automated roll-out (recommended)

For the common case — **you changed Agent code or dependencies and want it live** —
**[`Common/Deployment/deploy.sh`](../Deployment/deploy.sh)** does the entire roll-out
in one command from your dev box (Git Bash on Windows):

```bash
bash Common/Deployment/deploy.sh
```

It performs every step of §1.10 + §2.2 automatically:

0. **Checks the node is reachable (§1.1.2)** — boots the environment's Linode if
   it is powered off, and grants this machine temporary SSH access if its public
   IP is not on the firewall's allow-list. Both are reverted when the run ends.
0. **Builds the production frontend** on every environment, then — on
   **production only** — **gates on the browser test suites (§1.1.1)**, driving
   that bundle in a real Chromium: the seven interactive tutorials, the 27
   critical user flows and the 19 synchronisation cases. Nothing is created or
   shipped until they pass; a failure aborts before a single Linode is spun up.
   Needs `TUTORIAL_TEST_SESSION_COOKIE` in `deployment.env` plus a local Redis +
   MongoDB. **Development and testing skip the gates entirely** and go straight
   from the build to the bake. Bypass on production with `--skip-tutorial-tests`
   only for infrastructure-only roll-outs.
1. Creates a throwaway Debian 12 **bakebox** Linode (tagged `cogniumlearn-bakebox`).
2. Uploads the `Agent/` build context (the venv, caches and `*.env` secrets are
   excluded — they never leave your dev box).
3. Builds `cogniumlearn-agent`, installs the worker systemd unit, wipes the containerd
   cache and trims the OS (asserts `< 5.4 GB` used before continuing).
4. Powers off, **shrinks the disk to 6144 MB**, and captures
   **`CogniumLearnBurstVmImage<version>`** — version = highest existing + 1.
5. Builds the **production frontend** (codegen + bundle + mangle + obfuscate, the
   `npm run setup` equivalent), then SSHes into the base node, refreshes the
   Agent code + venv **and the Dock code** (a brute-force copy of `Dock/` *including*
   `node_modules` + the freshly-built obfuscated `Static/` —
   no `npm install` on the server; only the env secrets are excluded so the live
   `Dock/.production.env` is never clobbered), writes the new image id into
   `Dock/.production.env` (`BURST_IMAGE_ID`), ensures Dock + cloudflared run as
   services (idempotent), and **restarts Dock** so the live fleet boots the new image.
6. Deletes the bakebox and any **older** `CogniumLearnBurstVmImage<version>` images.
7. Prints a summary and (if `NOTIFY_WEBHOOK_URL` is set in `deployment.env`) POSTs it.

> **After a successful run, mirror the new `BURST_IMAGE_ID` into your local
> `Dock/.production.env`.** `deploy.sh` writes the captured image id
> (`private/NNNNNNNN`, printed in the final summary) into `Dock/.production.env`
> **on the base node only** — it does **not** touch your dev box's copy, so the
> local file drifts to a stale image id across deploys. Copy the new id from the
> summary into your local `Dock/.production.env` (`BURST_IMAGE_ID=private/NNNNNNNN`)
> so the dev reference stays in sync with production (it's the value a manual
> rollback in §2.5 or a `--skip-base-update` bake would otherwise read stale).

On any failure before the cleanup step the bakebox is **left running** for inspection,
with its IP and a `--cleanup-bakeboxes` one-liner printed to the console.

**Configuration** lives in `deployment.env` at the repo root (gitignored) — Linode API
token, SSH key paths, base-node host/user/repo-dir, and the optional webhook. Every
field is documented inline in that file.

| Flag | Effect |
|------|--------|
| *(none)* | Frontend build → browser gates (**production only**) → full bake → roll-out → cleanup. |
| `--skip-base-update` | Bake + capture only; don't touch the base node or delete old images. |
| `--skip-tutorial-tests` | Skip the §1.1.1 browser gates. Production-only in effect (a no-op on development/testing, which never run them). Infrastructure-only roll-outs; never to push past a red suite. |
| `--keep-node-running` | Leave a base node that was booted for this deploy (§1.1.2) running afterwards instead of returning it to `offline`. |
| `--cleanup-bakeboxes` | Delete stray `cogniumlearn-bakebox` Linodes from a failed run, then exit. |

> **The Dock systemd service is created automatically.** On every base-node update
> `deploy.sh` writes/refreshes `/etc/systemd/system/cogniumlearn-dock.service` (correct
> `node` path — it finds the nvm build, not `/usr/bin/node` — `WorkingDirectory` =
> `<repo-dir>/Dock`, `Restart=always`, enabled so it survives reboots), then
> `systemctl restart`s it. You never hand-write the unit, and on subsequent runs it's
> just a plain `systemctl restart cogniumlearn-dock`. See
> [`Remote/BaseNodeUpdate.sh`](../Deployment/Remote/BaseNodeUpdate.sh).

> **Scope.** `deploy.sh` rolls out **Agent** changes (the burst image + base-node
> venv + image pointer) **and Dock code** (brute-force copy incl. `node_modules`). It
> **builds the production frontend itself** before shipping Dock (the
> `npm run setup` equivalent — codegen + bundle + mangle + obfuscate — run as
> the cross-platform Node scripts from §1.7), so `Dock/Static/` is always current and
> obfuscated; pass `--skip-frontend-build` to skip it if you already built. It assumes
> the base node was already initialised
> (§1.3–§1.9); it ensures the Dock + cloudflared *services* but not Mongo/Redis/
> firewalls. The brute-force `node_modules` copy is safe only while Dock has **no
> native (`.node`) modules** — all current deps are pure JS; re-check with
> `find Dock/node_modules -name '*.node'` if you add one, else run `npm install` on the
> node instead. For a **rollback**, set `BURST_IMAGE_ID` back by hand per §2.5 (the
> automation deletes older images once a new one is proven, so keep one if you need a
> fast rollback target).

The remaining subsections document the manual equivalents and the cases `deploy.sh`
does not cover (frontend-only, config-only, schema, rollback).

## 2.1 Dock / frontend / backend code changed (base node only)

Most changes (endpoints, frontend, Dock classes) only need a redeploy of the base
node. The frontend has to be **bundled + obfuscated** into `Dock/Static/` first.

> **Run the tutorial walkthrough suite (§1.1.1) before shipping a frontend
> change this way.** The automated roll-out in §2.0 gates on it for you **only on
> production**; this manual path and every development/testing deploy do not, and
> a frontend change is exactly what breaks the guided tours. After
> `npm run setup`, restart your local Dock (it indexes `Dock/Static/` at boot) and
> run:
> ```bash
> TEST_SESSION_COOKIE=<local-session-id> node Common/Testing/Main/run_tutorial_ui_tests.js
> ```

> ⚡ **Recommended for a Windows-dev workflow — build on Windows, ship the artifacts.**
> The base node only needs `Dock/`'s own deps (what `setup-base-node.sh` installs); it
> does NOT have the frontend build/obfuscation toolchain. So build locally and copy the
> result, rather than building on the base node:
>
> 1. On your dev box, from the repo root: **`npm run setup`** (does codegen — a
>    no-op if you didn't touch `Common/` — then `CopyStaticFiles` + bundle + mangle +
>    obfuscate, leaving a production-ready `Dock/Static/`; the aggressive build is
>    always applied).
> 2. Ship `Dock/` (its changed backend files **and** the rebuilt `Dock/Static/`) to the
>    base node, **excluding** `Dock/node_modules` and the live `Dock/.env` /
>    `Dock/.production.env` so you don't clobber them:
>    ```powershell
>    tar --exclude=Dock/node_modules --exclude=Dock/.env --exclude=Dock/.production.env -czf dock-update.tar.gz Dock
>    scp dock-update.tar.gz root@<base-node-ip>:<repo-dir>/
>    Remove-Item dock-update.tar.gz   # remove the local update archive once uploaded
>    ```
>    ```bash
>    cd <repo-dir> && tar -xzf dock-update.tar.gz && rm dock-update.tar.gz
>    # tar extraction overwrites changed/added files but does NOT remove files you
>    # deleted in the change — delete those by hand, then:
>    sudo systemctl restart cogniumlearn-dock.service
>    ```

If the base node **does** have the build toolchain (you ran `npm install` for the build
scripts there), you can instead build in place:

```bash
cd /opt/cogniumlearn/CogniumLearn
git pull                                   # or your deploy mechanism
# rebuild generated files + frontend (the `npm run setup` equivalent):
node ./Common/Scripts/GenerateServiceManifest.js
node ./Common/Scripts/GenerateEnumerations.js
node ./Common/Scripts/GenerateConstants.js
node ./Common/Scripts/GenerateClasses.js
node ./Common/Scripts/CopyStaticFiles.js
node ./Common/Scripts/BundleStaticFiles.js
node ./Common/Scripts/ManglePrivateMembersInBundle.js
node ./Common/Scripts/MinifyAndObfuscateStaticFiles.js --aggressive
sudo systemctl restart cogniumlearn-dock.service
```

> For a **code-only** change (no `Common/` edits), the four `Generate*` codegen steps
> are no-ops — only `CopyStaticFiles` + the bundle/obfuscate steps + restart matter.

> The base node's local workers run from the venv, so an Agent code change also
> takes effect here on restart — **but burst VMs run the baked image**, so if you
> changed Agent code you must also re-bake (2.2).

## 2.2 Agent code or dependencies changed (re-bake the worker image)

Running burst VMs run the **baked** container, not your repo, so any Agent change
needs a fresh Image:

1. Update the base node's venv if dependencies changed:
   `./.venv/bin/pip install -r requirements.txt`.
2. If dependencies changed, regenerate `requirements.txt`:
   `python -m pip freeze | grep -v -i '^asyncio==' > requirements.txt`.
2a. **Run the dependency licence gate — mandatory before any production bake**
   (see §2.2.1). A new transitive dependency under a network-copyleft licence is
   the single easiest way to create a legal problem that nothing else in this
   pipeline will notice:
   ```bash
   ./.venv/bin/python Verification/VerifyDependencyLicences.py   # exit 0 required
   ```
3. Rebuild the image **on a Debian 12 bake box** (not Windows — see §1.2): spin up a
   throwaway Linode, get the `Agent/` build context onto it (the `tar` + `scp` method in
   §1.10, or `git clone`), and run `docker build -t cogniumlearn-agent -f Dockerfile .`
   from `Agent/`.
4. Re-bake the Linode Image (step 1.10) and set the new `BURST_IMAGE_ID` in
   `Dock/.env`.
5. Restart Dock: `sudo systemctl restart cogniumlearn-dock.service`. The startup teardown
   removes any burst VMs still running the old image; new ones boot the new Image.

## 2.2.1 The dependency licence gate (run on every Agent dependency change)

**Rule: no new Agent dependency ships to production without this gate passing.**

CogniumLearn is a closed-source hosted service. A dependency under a
**network-copyleft** licence — AGPL, SSPL, OSL — obliges us to offer every user
the Corresponding Source of the whole service. That is flatly incompatible with
paid decks, the paid-deck encryption scheme and the obfuscated frontend, and it
applies whether the package was added deliberately or arrived as a *transitive*
pull of something else.

This is not hypothetical. **PyMuPDF** (`fitz`) sat in the worker for months as
the backbone of every PDF workflow while being AGPL-3.0-or-Artifex-commercial,
because nothing in this pipeline ever looked at a licence. It was replaced by
**pypdfium2** (PDFium — BSD-3-Clause / Apache-2.0) behind
`Agent/Globals/Classes/Pdf/PdfDocumentReader.py`.

```bash
# From Agent/, against the venv you are about to freeze:
./.venv/bin/python Verification/VerifyDependencyLicences.py     # Linux / base node
.venv/Scripts/python.exe Verification/VerifyDependencyLicences.py   # Windows dev box
```

Exit **0** = clean, **1** = a blocked licence is installed, **2** = the
environment could not be inspected. A non-zero exit **blocks the bake** — do not
re-freeze `requirements.txt` and do not build the image until it is resolved.

What it reads, and why that matters: it inspects the licence metadata of
everything **actually installed in the venv**, not just what is named in
`requirements.txt`, because transitive pulls are the usual way a copyleft
package arrives. It trusts `License-Expression` (SPDX) first, then the
`License ::` trove classifiers, and only falls back to the free-text `License`
field when that field is short enough to be a licence *name*. That last rule is
load-bearing: scipy ships a 46 KB `License` field which bundles a GPLv3 whose
section 13 mentions the Affero GPL, so a naive substring search reports
BSD-licensed scipy as AGPL.

**LGPL is deliberately allowed.** It carries no source-disclosure obligation for
a hosted service, and `svglib` — the SVG-to-PNG path used by
`PaidDeckVisualGenerator` — depends on that distinction.

When the gate fails you have three options, in order of preference:

1. **Replace the package** with a permissively licensed equivalent.
2. **Buy a commercial licence** (some projects, like PyMuPDF via Artifex, are
   dual-licensed) and record the purchase.
3. **Acknowledge it** by adding an entry to `ACKNOWLEDGED_EXCEPTIONS` in the
   harness *with a written reason*. That list is a decision log, not a snooze
   button — anything in it is a debt someone has to clear.

### Currently acknowledged debt

**None — the PDF-stack licence migration is closed.**

Both halves are done, and the gate is expected to run with an empty ACKNOWLEDGED
section. If a row ever reappears here, it is a regression, not a plan.

| Was | Licence | Replaced by |
|---|---|---|
| `PyMuPDF` (`fitz`) | AGPL-3.0 or Artifex commercial | `pypdfium2` — PDFium, BSD-3-Clause / Apache-2.0, behind `Agent/Globals/Classes/Pdf/PdfDocumentReader.py` |
| `doclayout_yolo` | AGPL-3.0 (code **and** HF weights) | `ds4sd/docling-layout-heron` — Apache-2.0 weights, RT-DETRv2, behind `Agent/Globals/Classes/Layout/DoclingLayoutDetector.py` |

The layout swap deserves a note because it is easy to undo by accident:

* **It added no pip dependency.** Heron loads through plain `transformers`
  (`RTDetrV2ForObjectDetection` + `AutoImageProcessor`), which the worker already
  installs. `docling-ibm-models` is MIT but is **not** needed and must not be added.
* **`transformers` is now load-bearing for figure extraction**, not just for
  embeddings. Treat its pin as a behavioural pin, not a routine one.
* **The weights download on first use**, exactly as the YOLO weights did, so the
  Dockerfile is unchanged and a fresh burst VM pays a one-time fetch.
* Unlike PyMuPDF, `doclayout_yolo` had **no commercial licence to buy** — it is a
  fork of YOLOv10/Ultralytics, and its authors cannot relicense code they do not
  own. Reintroducing it is not a decision anyone can make with a cheque.

### Model weights are invisible to this gate

`VerifyDependencyLicences.py` reads pip metadata. It cannot see the licence of a
model downloaded from Hugging Face at runtime — and model weights are exactly
where this project's licence debt came from twice. When you add or change a
model, record its weights licence here by hand:

| Model | Used by | Weights licence |
|---|---|---|
| `ds4sd/docling-layout-heron` | `DoclingLayoutDetector` (figure detection) | Apache-2.0 |
| `sentence-transformers/all-mpnet-base-v2` | `PrepareImages`, `PrepareForSimilaritySearch` | Apache-2.0 |

## 2.3 Configuration / scaling change only

Edit `Dock/.env` and restart — no code changes, no re-bake. This covers caps, warm
pool, cooldowns, region, instance type, the master switch, and maintenance lead time:

```bash
sudo systemctl restart cogniumlearn-dock.service
```

## 2.4 Shared schema change (`Common/`)

If you changed `Common/Enumerations`, `Common/Constants`, or `Common/Classes`, re-run
codegen (steps in 2.1) so all services get the update. If the change affects the
Agent, also re-bake (2.2).

## 2.5 Rollback

- **Code:** check out the previous commit, re-run the 2.1 build, restart.
- **Worker image:** set `BURST_IMAGE_ID` back to the previous Image id and restart
  (keep old Images until the new one is proven).
- **Config:** revert `Dock/.env` and restart.
- Never change `PAID_DECK_MASTER_KEY_BASE64` as part of a rollback.

---

# Section 3 — Desktop & mobile app distribution

The desktop (Windows/macOS/Linux) and mobile (Android/iOS) apps are a **Tauri shell that
loads the production site directly** (`https://learn.cogniumlabs.io`). Because the
webview origin *is* the production origin, every relative API call, cookie and
`window.__TAURI__` integration works exactly as on the web — there is **no** separate API
layer, and **the web deployment (Sections 1–2) is completely unaffected** by anything here.

Two things are added on top of "load the site":

- **Offline.** A service worker (`Main/service-worker.js`) caches the pages + static assets
  the app loads, so a later launch/reload works with no network. It is registered **only**
  inside the native shell (`Main/Globals/Classes/OfflineCacheManager.js`, gated on
  `Platform.get() === APP`), so browsers never install it. It ships as an ordinary static
  file (survives the bundler's source sweep via `BundleStaticFiles.PRESERVED_ROOT_FILE_NAMES`).
- **Binary auto-update.** The desktop binary self-updates with `tauri-plugin-updater`, which
  polls Dock's `/DesktopUpdates/latest.json` for a newer **signed** installer. Mobile updates
  ship as a new APK / store build (the updater plugin is desktop-only).

## 3.0 Build / run commands (dev box)

| Command | Effect |
|---|---|
| `npm run desktop` | Aggressive build → configure the Tauri app from env → `tauri build` → install the produced OS installer → launch. |
| `npm run android` | Aggressive build → configure → `tauri android dev` onto a USB-connected device (auto-runs `tauri android init` on first use). |
| `npm run ios` | macOS + Xcode only; on other platforms it prints a message and exits. |

`Common/Scripts/ConfigureTauriApp.js` runs before every Tauri build and injects, **from env**
(with production defaults):

- `COGNIUMLEARN_APP_URL` (default `https://learn.cogniumlabs.io`) — the site the window loads;
  also written into the remote-IPC capability (`Build/Template/src-tauri/capabilities/remote.json`)
  so `window.__TAURI__` (Persistence fs, notifications, updater) is permitted on the remote page.
- `COGNIUMLEARN_UPDATE_ENDPOINT` (default `<app-url>/DesktopUpdates/latest.json`) — the updater feed.
- `COGNIUMLEARN_UPDATER_PUBKEY` — the updater public key. **If unset, the updater is disabled** and
  `tauri build` still produces a plain installer (no auto-update). Set it to enable signed OTA
  binary updates.

## 3.1 One-time native-shell setup

The Tauri project lives under `Build/` (git-ignored — it is local scaffolding). If you scaffold
it fresh, ensure these (already applied on the current dev box):

- `Build/Template/src-tauri/Cargo.toml` includes `tauri-plugin-updater` under a
  `[target.'cfg(desktop)'.dependencies]` section.
- `Build/Template/src-tauri/src/lib.rs` registers the updater plugin under `#[cfg(desktop)]`.
- `Build/Template/src-tauri/capabilities/remote.json` exists (remote-IPC allowlist).
- `Build/Template/src-tauri/tauri.conf.json` window has a remote `url` and `bundle`/`plugins`
  fields that `ConfigureTauriApp.js` fills in.

## 3.2 Generate the updater signing keypair (once)

```bash
npx tauri signer generate -w cogniumlearn-updater.key
```

This prints/creates a **private** key (`cogniumlearn-updater.key` + a password) and a **public**
key. Then:

- Keep the **private** key out of the repo. Provide it to the build via the standard Tauri env
  vars at build time: `TAURI_SIGNING_PRIVATE_KEY` (the key content or a path) and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- Provide the **public** key as `COGNIUMLEARN_UPDATER_PUBKEY` when building, so
  `ConfigureTauriApp.js` writes it into `plugins.updater.pubkey` and enables
  `createUpdaterArtifacts`.

> Like `PAID_DECK_MASTER_KEY_BASE64`, **keep the updater keypair stable** — every installed app
> only trusts installers signed by the matching key, so rotating it strands existing installs on
> their current version until they reinstall.

## 3.3 Build, then publish a release

```bash
# From the repo root, with the signing env vars + public key set:
export TAURI_SIGNING_PRIVATE_KEY=...            # or a path to the key file
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=...
export COGNIUMLEARN_UPDATER_PUBKEY=...              # the public key from 3.2
npm run desktop                                 # builds + signs the installer(s)
```

`tauri build` writes the installers and their `.sig` signatures under
`Build/Template/src-tauri/target/release/bundle/` (e.g. `nsis/*-setup.exe`, `msi/*.msi`).

To publish, upload to the base node's `Dock/DesktopUpdates/` directory (served at
`/DesktopUpdates/…`, git-ignored, outside `Dock/Static/` so a frontend rebuild never wipes it):

1. The installer artifact(s) for each platform you ship.
2. A `latest.json` update manifest describing the newest version, e.g.:

   ```json
   {
     "version": "1.0.1",
     "notes": "What changed",
     "pub_date": "2026-07-02T00:00:00Z",
     "platforms": {
       "windows-x86_64": {
         "signature": "<contents of the .sig file>",
         "url": "https://learn.cogniumlabs.io/DesktopUpdates/mind-meld_1.0.1_x64-setup.exe"
       }
     }
   }
   ```

On next launch an installed app fetches `latest.json`, and if `version` is newer and the
signature verifies against its baked-in public key, it downloads and installs the update.

## 3.4 What is NOT affected

- The **web app** (Sections 1–2): the service worker is never registered in a browser, and the
  `/DesktopUpdates` route is independent of the SPA. No frontend fetch/auth code changed.
- `Common/Deployment/deploy.sh`, the base-node build, and the systemd unit — all unchanged.

---

## Troubleshooting

- **`docker build` fails with `npipe:////./pipe/docker_engine ... cannot find the file`.**
  The Docker daemon is not running — the CLI can't reach the engine. On Windows, start
  **Docker Desktop** and wait until the engine is up (`docker version` shows a *Server*
  block), then re-run the build. This is an environment issue, not a Dockerfile problem.
- **`docker build` fails with `No matching distribution found for <package>==<version>`.**
  A pinned version in `Agent/requirements.txt` was **yanked from PyPI** after it was
  frozen (the error lists the still-available versions, with the pinned one missing).
  The `ddgs` / `primp` pair is the usual culprit (they are released and yanked
  together). Fix it at the source so the venv and the freeze stay in lock-step: install
  the nearest available patch into the venv, then re-freeze. From `Agent/`:
  ```bash
  ./.venv/Scripts/python.exe -m pip install <package>==<nearest-available-patch>   # Windows
  # ./.venv/bin/pip install <package>==<nearest-available-patch>                   # Linux base node
  python -m pip freeze | grep -v -i '^asyncio==' > requirements.txt
  ```
  Then rebuild. Editing only `requirements.txt` unblocks the build but drifts it from
  the venv — always sync both.
- **Nothing distributes after enabling.** Confirm Dock runs **without** `--debug` and
  `DOCK_USE_TASK_QUEUE=1`; check `LLEN TaskQueue/pending` in Redis.
- **Burst VMs boot but do no work.** On the burst VM, check
  `journalctl -u cogniumlearn-worker` — verify cloud-init wrote `/etc/cogniumlearn/worker.env`
  with reachable VPC-private Redis/Mongo URLs and the worker service is enabled.
- **No burst VMs ever appear.** Check Admin Panel → Alerts for Linode API errors, and
  confirm `LINODE_API_TOKEN`, `BURST_IMAGE_ID`, `BURST_REGION`, `BURST_INSTANCE_TYPE`
  and `BURST_FIREWALL_ID` are all set — the autoscaler is disabled (fail-closed) if
  the provider isn't fully configured, and a **missing `BURST_FIREWALL_ID` alone** is
  enough to keep it from ever creating a VM.
- **OAuth fails / "redirect_uri_mismatch".** `DOMAIN_NAME` and the Google client's
  redirect URI must both be `https://<domain>/Login/Callback`.
- **Cloudflare 502/1033 (tunnel error).** Check `systemctl status cloudflared` and
  `journalctl -u cloudflared` — the tunnel must be running and Dock must be up on
  `127.0.0.1:3000`. Confirm the DNS route exists
  (`cloudflared tunnel route dns cogniumlearn learn.cogniumlabs.io`) and that
  `/etc/cloudflared/config.yml` points at the correct credentials JSON.
- **Paid-deck endpoints return 503 `KEY_MANAGEMENT_NOT_READY`.**
  `PAID_DECK_MASTER_KEY_BASE64` is missing or not exactly 32 bytes.
- **App loads blank / 404 on assets.** You skipped `CopyStaticFiles.js` — `Dock/Static/`
  is empty. Re-run the build.
- **Worker image too large to bake.** `torch`'s default PyPI wheel is the large CUDA
  build (runs fine on CPU but bloats the image). Install the CPU build instead:
  `pip install torch==<ver>+cpu --index-url https://download.pytorch.org/whl/cpu`,
  then rebuild and re-bake.
- **Desktop app: window is blank / `window.__TAURI__` is undefined.** The remote-IPC
  capability (`Build/Template/src-tauri/capabilities/remote.json` → `remote.urls`) must
  list the exact `COGNIUMLEARN_APP_URL` the window loads. `ConfigureTauriApp.js` keeps them in
  sync, so rebuild via `npm run desktop` (not a bare `tauri build`) after changing the URL.
- **Desktop app: `tauri build` fails complaining about the updater public key.** Either set
  `COGNIUMLEARN_UPDATER_PUBKEY` (+ `TAURI_SIGNING_PRIVATE_KEY`/`…_PASSWORD`) to enable signed
  updates, or leave `COGNIUMLEARN_UPDATER_PUBKEY` unset — `ConfigureTauriApp.js` then disables
  `createUpdaterArtifacts` so the build produces a plain, unsigned installer.
- **Desktop app doesn't update.** Confirm `Dock/DesktopUpdates/latest.json` is reachable at
  `https://<domain>/DesktopUpdates/latest.json`, its `version` is newer than the installed
  app, and each platform `signature` matches the uploaded `.sig`. The app only trusts
  installers signed by the key whose public half is baked in (`COGNIUMLEARN_UPDATER_PUBKEY`).
- **Desktop/mobile app has no offline cache.** The service worker registers only inside the
  native shell and only over HTTPS. On iOS/macOS (WKWebView) it additionally requires the
  production domain to be declared as a `WKAppBoundDomains` entry in the iOS project's
  Info.plist; Windows (WebView2) and Android need nothing extra.

---

## Key files

| Area | File |
|------|------|
| Server entry / wiring | `Dock/index.js` |
| Dock env reference | `Dock/.env.example` |
| Queue mode policy | `Dock/Globals/Classes/Task/TaskQueueMode.js` |
| Producer + queue ops | `Dock/Globals/Classes/Task/TaskManager.js` |
| Base-node workers | `Dock/Globals/Classes/Task/LocalWorkerSupervisor.js` |
| Worker entrypoint | `Agent/Worker.py` |
| Shared task dispatch | `Agent/Globals/Classes/Task/TaskRunner.py` |
| Worker queue ops | `Agent/Globals/Classes/Task/TaskManager.py` |
| Cloud abstraction | `Dock/Globals/Classes/CloudCompute/` |
| Autoscaler | `Dock/Globals/Classes/Burst/BurstAutoscaler.js` |
| Fleet settings (env) | `Dock/Globals/Classes/Burst/BurstFleetSettings.js` |
| Maintenance | `Dock/Globals/Classes/Maintenance/`, `Dock/Globals/Model/MaintenanceWindow.js` |
| Worker Docker image | `Agent/Dockerfile`, `Agent/requirements.txt` |
| Frontend build scripts | `Common/Scripts/` (`npm run setup` runs these in order) |
| Root launcher scripts | `Common/Scripts/{Setup,RunWeb,RunProduction,RunDesktop,RunAndroid,RunIos}.js`, `BuildPipeline.js`, `CommandRunner.js` |
| Desktop/mobile app config | `Common/Scripts/ConfigureTauriApp.js`, `Build/Template/src-tauri/` |
| Desktop update route | `Dock/Endpoints/DesktopUpdates/HandleDesktopUpdateEndpoints.js` |
