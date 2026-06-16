# MindMeld Deployment Guide

This is the complete, start-to-finish guide for deploying MindMeld to production on
Linode — the Dock web server, the Agent task processor, the burst worker fleet, and
scheduled maintenance. It is organized **by machine, in the exact order you should
do things**.

There are two sections:

- **[Section 1 — Initial deployment](#section-1--initial-deployment)** — everything
  needed to go from nothing to a running server (Dock + Agent + fleet).
- **[Section 2 — Update deployment](#section-2--update-deployment)** — how to push
  changes to production afterwards.

Read [Concepts](#concepts) first — it defines the machines and terms used throughout.

---

## Concepts

### The machines

| Machine | Role |
|---------|------|
| **Dev workstation** (your Windows PC) | Where you write code, run `setup.bat`, and build the worker Docker image. |
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
                 Burst VM → docker: mindmeld-agent                            Burst VM → docker: mindmeld-agent
                  └─ Worker.py polls the queue                                 └─ Worker.py polls the queue
```

---

# Section 1 — Initial deployment

Do these in order. Steps 1.1–1.2 are on your dev workstation; 1.3 onward are on
Linode.

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

## 1.2 Dev workstation — build the worker Docker image

Burst VMs run the Agent as a Docker container. Build it from the `Agent/` directory
(Docker Desktop on Windows produces the Linux image fine):

```bash
docker build -t mindmeld-agent -f Dockerfile .
```

- The image is **Debian/glibc, multi-stage** — deliberately not Alpine, because the
  worker pulls `torch`, `opencv`, `scipy`, `PyMuPDF`, etc., which ship prebuilt
  glibc wheels; musl (Alpine) would force slow, fragile source builds.
- `Agent/requirements.txt` is an exact `pip freeze` of the Agent venv. If you changed
  Agent dependencies, refresh it first:
  ```bash
  python -m pip freeze | grep -v -i '^asyncio==' > requirements.txt
  ```
  > The `asyncio` PyPI package is excluded on purpose — it shadows the Python 3.12
  > stdlib `asyncio` and breaks the container.

You'll move this image onto the bake box in step 1.8.

## 1.3 Linode — create the VPC and base node

1. Create a **Linode VPC** in your target region with one **subnet**. Note the VPC
   id and subnet id (used later as `BURST_VPC_ID`, `BURST_SUBNET_ID`).
2. Create the **base node** (a strong Linode) and attach it to the VPC.
3. Install on the base node:
   - **Node.js** (to run Dock).
   - **Python 3.12** + the ability to create a venv (to run the local workers).
   - **MongoDB** and **Redis**.
   - Docker is **not** required on the base node (its workers run from the venv, not
     a container).
4. **Bind Redis and MongoDB to the base node's private VPC IP** (not the public IP).
   Burst VMs will reach them over the VPC; nothing is exposed publicly. Note those
   URLs (e.g. `redis://10.0.0.2:6379`, `mongodb://10.0.0.2:27017`) — they become
   `BURST_WORKER_REDIS_URL` / `BURST_WORKER_MONGODB_URL`.

## 1.4 Base node — deploy the code and Python venv

1. Clone/copy the repo, e.g. to `/opt/mindmeld/MindMeld`.
2. Create the Agent venv and install dependencies:
   ```bash
   cd /opt/mindmeld/MindMeld/Agent
   python3.12 -m venv .venv
   ./.venv/bin/pip install --upgrade pip
   ./.venv/bin/pip install -r requirements.txt
   ```
   (`getPythonExecutablePathFromVenv` looks for `.venv/bin/python` on Linux, so the
   venv must live at `Agent/.venv`.)

## 1.5 Base node — configure `Dock/.env`

Dock reads `Dock/.env` at boot (via dotenv, relative to its working directory). Copy
`Dock/.env.example` to `Dock/.env` and fill it in. **Every term explained:**

**Required**

- `MONGODB_URL` — MongoDB connection string (e.g. `mongodb://127.0.0.1:27017`, or the
  private VPC IP).
- `MONGODB_DATABASE_NAME` — the database name (e.g. `mindmeld`).
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

- `GEMINI_API_KEY` — Gemini key for the generation pipeline. **Also forwarded to
  burst workers**, so it must be set here.
- `AGENT_SERVICE_PATH` — absolute path to the Agent service so Dock can launch local
  workers reliably. Set it to `/opt/mindmeld/MindMeld/Agent`.

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
- `GEMINI_API_KEY` — Gemini key for the workflows.
- `OPENAI_API_KEY` — only if you use OpenAI-backed workflows.
- `WEB_SCRAPE_CONTACT_EMAIL` — optional contact email used in the web-scraping
  workflow's User-Agent.

## 1.7 Base node — build the frontend & generated files

The Node server serves the SPA from `Dock/Static/`, which is produced by the build.
On Windows you'd run `setup.bat --aggressive`; on the Debian base node run the same
steps directly (they are plain Node scripts). What each does:

```bash
cd /opt/mindmeld/MindMeld
node ./Common/Scripts/GenerateServiceManifest.js   # service registry for codegen
node ./Common/Scripts/GenerateEnumerations.js      # Common/Enumerations → each service
node ./Common/Scripts/GenerateConstants.js         # Common/Constants    → each service
node ./Common/Scripts/GenerateClasses.js           # Common/Classes      → each service
node ./Common/Scripts/CopyStaticFiles.js           # Main/ → Dock/Static/ (what the server serves)
# --aggressive bundling + obfuscation for production (the part `setup.bat --aggressive` adds):
node ./Common/Scripts/BundleStaticFiles.js
node ./Common/Scripts/ManglePrivateMembersInBundle.js
node ./Common/Scripts/MinifyAndObfuscateStaticFiles.js --aggressive
```

- The first five steps are the **mandatory** codegen + static sync (equivalent to a
  plain `setup.bat`). Without `CopyStaticFiles.js`, `Dock/Static/` is empty and the
  app won't load.
- The last three are the production hardening (`--aggressive`): they bundle, mangle
  private members, and minify/obfuscate the served frontend. Run them for any
  internet-facing deploy.

> If you prefer, build on Windows with `setup.bat --aggressive` and deploy the whole
> repo (including the built `Dock/Static/`). Either way the artifacts are identical —
> these are cross-platform Node scripts; only the `.bat` wrapper is Windows-specific.

## 1.8 Base node — expose it on your domain via Cloudflare Tunnel

OAuth requires your real `https://<domain>`. This deployment uses a **Cloudflare
Tunnel**, which terminates TLS at Cloudflare's edge and forwards to Dock on
`127.0.0.1:3000` over an encrypted outbound tunnel — so the base node exposes **no
inbound ports** (no public `3000`, no nginx/certs to manage). The tunnel is named
`mindmeld` and serves `mindmeld.cogniumlabs.io`
(see `Common/Config/CloudflareTunnelConfig.yml`, used by `run.ps1 --online` on dev).

Set up the same tunnel as a service on the base node:

1. **Install `cloudflared`** (Debian):
   ```bash
   curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
   sudo dpkg -i cloudflared.deb
   ```
2. **Provide the tunnel credentials.** The tunnel already exists (UUID
   `6156d866-…`). Either copy its credentials JSON from the machine that created it
   to `/etc/cloudflared/6156d866-df7e-47eb-a5e5-43810724ea26.json`, or re-auth and
   recreate on the server:
   ```bash
   sudo mkdir -p /etc/cloudflared
   # copy the existing creds JSON here, OR:
   #   cloudflared tunnel login
   #   cloudflared tunnel create mindmeld
   ```
3. **Install the production config.** Copy the committed Linux template to where the
   service reads it:
   ```bash
   sudo cp /opt/mindmeld/MindMeld/Common/Config/CloudflareTunnelConfig.production.yml /etc/cloudflared/config.yml
   ```
   It points `mindmeld.cogniumlabs.io` → `http://127.0.0.1:3000` and references the
   Linux credentials path. Adjust the `credentials-file` path if your JSON differs.
4. **Route DNS to the tunnel** (once — creates the proxied CNAME in Cloudflare):
   ```bash
   cloudflared tunnel route dns mindmeld mindmeld.cogniumlabs.io
   ```
5. **Run it as a boot service:**
   ```bash
   sudo cloudflared service install     # generates a cloudflared systemd unit from /etc/cloudflared/config.yml
   sudo systemctl enable --now cloudflared
   sudo systemctl status cloudflared
   ```

Then in `Dock/.env` set `DOMAIN_NAME=mindmeld.cogniumlabs.io`, and in the Google
OAuth client set the authorized redirect URI to
`https://mindmeld.cogniumlabs.io/Login/Callback`. (In Cloudflare, keep SSL/TLS mode
at **Full** so the edge trusts the tunnel.)

## 1.9 Base node — run Dock on boot (systemd)

This is what makes everything start when the server boots: a systemd service runs
`node index.js` (no `--debug`), which on launch starts the local workers and the
autoscaler. **Working directory must be `Dock/`** so dotenv loads `Dock/.env`.

`/etc/systemd/system/mindmeld-dock.service`:

```ini
[Unit]
Description=MindMeld Dock server
After=network-online.target redis-server.service mongod.service
Wants=network-online.target

[Service]
Type=simple
User=mindmeld
WorkingDirectory=/opt/mindmeld/MindMeld/Dock
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mindmeld-dock.service
sudo journalctl -u mindmeld-dock -f      # watch the logs
```

> No `--debug` here — that's exactly what enables distributed mode in production.
> Restarting this service cleanly cycles the fleet (teardown → rebuild warm pool).

At this point the **server is up** and works with the base node's local workers even
before any burst VMs exist. The remaining steps add cloud bursting.

## 1.10 Image-bake box — bake the burst worker Image

Burst VMs boot from a pre-baked Linode custom Image so they start fast and run the
worker automatically.

> **Do not image your live base node.** That would bake Dock + Redis + Mongo + your
> secrets into the worker image, and every burst VM would start its own Dock +
> autoscaler (recursive provisioning). Use a clean throwaway Linode.

1. Create a **temporary** Debian Linode in the target region, attached to the VPC.
2. Install Docker, then get the `mindmeld-agent` image onto it (push to a registry
   and `docker pull`, or `docker save mindmeld-agent | ssh … docker load`).
3. Install the worker systemd unit so the container auto-starts on boot and reads the
   env file that cloud-init writes at provision time:

   `/etc/systemd/system/mindmeld-worker.service`:
   ```ini
   [Unit]
   Description=MindMeld Agent worker
   After=docker.service network-online.target
   Requires=docker.service

   [Service]
   Restart=always
   EnvironmentFile=/etc/mindmeld/worker.env
   ExecStartPre=-/usr/bin/docker rm -f mindmeld-worker
   ExecStart=/usr/bin/docker run --rm --name mindmeld-worker --env-file /etc/mindmeld/worker.env mindmeld-agent
   ExecStop=/usr/bin/docker stop mindmeld-worker

   [Install]
   WantedBy=multi-user.target
   ```
   ```bash
   sudo mkdir -p /etc/mindmeld
   sudo systemctl enable mindmeld-worker.service
   ```
4. Power the Linode **off** and capture an **Image** (Linode dashboard → the Linode →
   *Create Image*). Use the resulting id (e.g. `private/12345678`) as `BURST_IMAGE_ID`.
5. **Delete the temporary Linode** — you only needed it to produce the Image.

**How a burst VM then starts working:** when the autoscaler creates one,
`LinodeComputeProvider.createInstance` boots it from `BURST_IMAGE_ID`, joins it to
the VPC, tags it `BURST_MANAGEMENT_TAG`, and passes cloud-init user-data that writes
`/etc/mindmeld/worker.env` (private Redis/Mongo URLs + AI keys) and restarts
`mindmeld-worker.service`. The container then drains the queue.

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
- `BURST_WORKER_REDIS_URL` / `BURST_WORKER_MONGODB_URL` — private-IP URLs burst VMs
  use (fall back to `REDIS_URL` / `MONGODB_URL` if unset).

**Scaling shape**

- `BURST_MANAGEMENT_TAG` (default `mindmeld-burst`) — tag identifying managed VMs;
  the autoscaler **only ever touches** instances with this tag.
- `BURST_LABEL_PREFIX` (default `mindmeld-burst-`) — label prefix for created VMs.
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
BURST_WORKER_REDIS_URL=redis://10.0.0.2:6379
BURST_WORKER_MONGODB_URL=mongodb://10.0.0.2:27017
BURST_WARM_POOL_SIZE=2
BURST_MAX_INSTANCES=6
```

## 1.12 Go live (ramp up safely)

Restart Dock after each change (`sudo systemctl restart mindmeld-dock.service`):

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

---

# Section 2 — Update deployment

How to push changes to production. Pick the case that matches what you changed. In
all cases, restarting Dock cleanly cycles the fleet (teardown → rebuild).

## 2.1 Dock / frontend / backend code changed (base node only)

Most changes (endpoints, frontend, Dock classes) only need a redeploy of the base
node:

```bash
cd /opt/mindmeld/MindMeld
git pull                                   # or your deploy mechanism
# rebuild generated files + frontend (the setup.bat --aggressive equivalent):
node ./Common/Scripts/GenerateServiceManifest.js
node ./Common/Scripts/GenerateEnumerations.js
node ./Common/Scripts/GenerateConstants.js
node ./Common/Scripts/GenerateClasses.js
node ./Common/Scripts/CopyStaticFiles.js
node ./Common/Scripts/BundleStaticFiles.js
node ./Common/Scripts/ManglePrivateMembersInBundle.js
node ./Common/Scripts/MinifyAndObfuscateStaticFiles.js --aggressive
sudo systemctl restart mindmeld-dock.service
```

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
3. Rebuild the image: `docker build -t mindmeld-agent -f Dockerfile .` (from `Agent/`).
4. Re-bake the Linode Image (step 1.10) and set the new `BURST_IMAGE_ID` in
   `Dock/.env`.
5. Restart Dock: `sudo systemctl restart mindmeld-dock.service`. The startup teardown
   removes any burst VMs still running the old image; new ones boot the new Image.

## 2.3 Configuration / scaling change only

Edit `Dock/.env` and restart — no code changes, no re-bake. This covers caps, warm
pool, cooldowns, region, instance type, the master switch, and maintenance lead time:

```bash
sudo systemctl restart mindmeld-dock.service
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

## Troubleshooting

- **Nothing distributes after enabling.** Confirm Dock runs **without** `--debug` and
  `DOCK_USE_TASK_QUEUE=1`; check `LLEN TaskQueue/pending` in Redis.
- **Burst VMs boot but do no work.** On the burst VM, check
  `journalctl -u mindmeld-worker` — verify cloud-init wrote `/etc/mindmeld/worker.env`
  with reachable VPC-private Redis/Mongo URLs and the worker service is enabled.
- **No burst VMs ever appear.** Check Admin Panel → Alerts for Linode API errors, and
  confirm `LINODE_API_TOKEN`, `BURST_IMAGE_ID`, `BURST_REGION`, `BURST_INSTANCE_TYPE`
  are set (the autoscaler is disabled if the provider isn't configured).
- **OAuth fails / "redirect_uri_mismatch".** `DOMAIN_NAME` and the Google client's
  redirect URI must both be `https://<domain>/Login/Callback`.
- **Cloudflare 502/1033 (tunnel error).** Check `systemctl status cloudflared` and
  `journalctl -u cloudflared` — the tunnel must be running and Dock must be up on
  `127.0.0.1:3000`. Confirm the DNS route exists
  (`cloudflared tunnel route dns mindmeld mindmeld.cogniumlabs.io`) and that
  `/etc/cloudflared/config.yml` points at the correct credentials JSON.
- **Paid-deck endpoints return 503 `KEY_MANAGEMENT_NOT_READY`.**
  `PAID_DECK_MASTER_KEY_BASE64` is missing or not exactly 32 bytes.
- **App loads blank / 404 on assets.** You skipped `CopyStaticFiles.js` — `Dock/Static/`
  is empty. Re-run the build.
- **Worker image too large to bake.** `torch`'s default PyPI wheel is the large CUDA
  build (runs fine on CPU but bloats the image). Install the CPU build instead:
  `pip install torch==<ver>+cpu --index-url https://download.pytorch.org/whl/cpu`,
  then rebuild and re-bake.

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
| Frontend build scripts | `Common/Scripts/` (`setup.bat` runs these in order) |
