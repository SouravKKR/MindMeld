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

## 1.2 The worker Docker image — built on the bake box, not on Windows

Burst VMs run the Agent as a Docker container, built from the `Agent/` directory with:

```bash
docker build -t mindmeld-agent -f Dockerfile .
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
  worker pulls `torch`, `opencv`, `scipy`, `PyMuPDF`, etc., which ship prebuilt
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
> `Agent/.production.env` are in place, **[`Common/Scripts/setup-base-node.sh`](../Scripts/setup-base-node.sh)**
> does all of §1.4–§1.7 in one shot: installs the OCR stack + Redis (bound to the VPC
> IP) + Node, sets up Python 3.12 via `uv` and the Agent venv, runs `npm install`, and
> registers + starts the Dock systemd service. Run it with
> `sudo bash Common/Scripts/setup-base-node.sh`. The manual steps below document what
> it does (and the Cloudflare Tunnel in §1.8 + the burst firewall stay manual).

1. Clone/copy the repo to a directory of your choice — call it `<repo-dir>`. The paths
   in this guide use `/opt/mindmeld/MindMeld` as the example, but anywhere works (e.g.
   `/root/mindmeld` if you deploy as root). **Whatever you pick, the same absolute path
   must be used consistently in three places** or the local workers won't start:
   - the **Agent venv** lives at `<repo-dir>/Agent/.venv` (created in step 3 below),
   - **`AGENT_SERVICE_PATH`** in `Dock/.production.env` is set to `<repo-dir>/Agent` (§1.5),
   - the **systemd unit**'s `WorkingDirectory` is `<repo-dir>/Dock` (§1.9).

   > Pick the layout up front. If you deploy under `/root/...`, run everything as `root`
   > and **drop the `User=mindmeld` line** from the systemd unit (§1.9) — a non-root
   > `mindmeld` user can't traverse `/root`. If you want a dedicated `mindmeld` user,
   > deploy under `/opt/mindmeld` (or another world-traversable path) instead. Don't mix
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

- **LLM keys are NOT set in `Dock/.env`.** Dock makes **no** LLM calls — every AI
  request is delegated to the Agent (run locally as a spawned/queued worker, or on a
  burst VM). `GEMINI_API_KEY` and `OPENAI_API_KEY` therefore live **only** in the
  **Agent** env file (`Agent/.env` with `--debug`, else `Agent/.production.env`) and
  are used only by the Agent. Dock reads that **sibling** file (same relative layout:
  `Agent/` next to `Dock/`) for the **single** purpose of forwarding the keys to burst
  workers via cloud-init — see `BurstFleetSettings.getWorkerRuntimeEnvironment` →
  `#readAgentLlmKeys`. Dock never injects them into its own process. Consequence: the
  Agent env file must exist next to `Dock/` on the base node, and you edit the LLM
  keys in **one place** (the Agent env file), never in Dock's.
- `AGENT_SERVICE_PATH` — absolute path to the Agent service so Dock can launch local
  workers reliably. Set it to `<repo-dir>/Agent` (e.g. `/opt/mindmeld/MindMeld/Agent`,
  or `/root/mindmeld/Agent` for a root deploy). It **must** match where the venv was
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
(see `Common/Config/CloudflareTunnelConfig.yml`, the dev template you can run by hand
with `cloudflared tunnel --config Common/Config/CloudflareTunnelConfig.yml run mindmeld`).

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

> Set `WorkingDirectory` to **`<repo-dir>/Dock`** — it must match the layout you chose
> in §1.4 (e.g. `/root/mindmeld/Dock` for a root deploy). If you deployed under `/root`,
> **delete the `User=mindmeld` line** (it runs as `root` by default); a non-root user
> can't traverse `/root`, so leaving it there gives a `status=200/CHDIR` start failure.
> Keep `User=mindmeld` only when the repo lives somewhere that user can read/execute
> (e.g. under `/opt/mindmeld`) and you've created that user.

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

> ⚡ **Automated path (recommended).** The whole bake → capture → roll-out → cleanup
> flow is automated by **[`Common/Deployment/deploy.sh`](../Deployment/deploy.sh)** —
> run `bash Common/Deployment/deploy.sh` from your dev box (Git Bash). It creates the
> bakebox, builds + trims the image, shrinks the disk and captures
> `MindMeldBurstVmImage<version>` (auto-incremented), then rolls it out to the base
> node and deletes the bakebox + older images. Configure it via `deployment.env` at the
> repo root (gitignored). See [Section 2.0](#20-automated-roll-out-recommended) and
> [Common/Deployment/README.md](../Deployment/README.md). The manual steps below
> document exactly what it does.

> **Do not image your live base node.** That would bake Dock + Redis + Mongo + your
> secrets into the worker image, and every burst VM would start its own Dock +
> autoscaler (recursive provisioning). Use a clean throwaway Linode.

1. Create a **temporary Debian 12 Linode** in the target region, attached to the VPC.
   This is also where you **build** the `mindmeld-agent` image (§1.2) — building in the
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
   mkdir -p /root/MindMeld
   tar -xzf /root/agent-context.tar.gz -C /root/MindMeld && rm /root/agent-context.tar.gz
   cd /root/MindMeld/Agent
   docker build -t mindmeld-agent -f Dockerfile .
   docker images               # confirm mindmeld-agent:latest is present
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
   docker save -o /root/mm.tar mindmeld-agent:latest
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
   `POST /v4/images` body `{"disk_id":<diskId>,"label":"mindmeld-burst-worker"}`. When
   it reaches *available*, use its id (`private/NNNNNNNN`) as `BURST_IMAGE_ID`. (If the
   image 404s / deletes itself mid-creation, it's still over the cap — go back to a/b.)
5. **Delete the temporary Linode** — you only needed it to produce the Image.

**How a burst VM then starts working:** when the autoscaler creates one,
`LinodeComputeProvider.createInstance` boots it from `BURST_IMAGE_ID`, attaches a
public interface (egress) **and** the VPC interface (private Redis/Mongo), binds it
to `BURST_FIREWALL_ID`, tags it `BURST_MANAGEMENT_TAG`, and passes cloud-init user-data that writes
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
BURST_FIREWALL_ID=98765
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
`[BurstAutoscaler] Created burst instance … (mindmeld-burst-…).` In a live (non-dry)
run, confirm in Linode Cloud Manager that the new instance is bound to the **same
firewall as the Dock Linode** (`BURST_FIREWALL_ID`). Restore your normal values
(`BURST_DRY_RUN`, `AGENT_LOCAL_WORKER_COUNT`, cooldowns, cap) when done.

### Fake-load test — make burst VMs spawn without doing any real work

You don't need real generations to test scaling. The autoscaler only counts how many
items are waiting in one Redis list — **`TaskQueue/pending`**. Put fake items in that
list and it reacts exactly as if real tasks arrived. Run all of this **on the base node**.

**Watch the decisions** — open one terminal and leave it running:
```bash
journalctl -u mindmeld-dock -f | grep -E "BurstAutoscaler|BURST_DRY_RUN"
```
Every line reads `pending=<items waiting> … desired=<VMs it wants> (cap=<max>)`.

**1. Make the test safe + quick.** In `Dock/.production.env` set these, then
`sudo systemctl restart mindmeld-dock`:
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
Now `Would create instance` becomes `Created burst instance …`, and a `mindmeld-burst-*`
Linode appears in the dashboard. Clear the queue (step 3) and it's deleted after the
idle timeout, or `sudo systemctl restart mindmeld-dock` removes all burst VMs at once.

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
sudo systemctl restart mindmeld-dock
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

1. Creates a throwaway Debian 12 **bakebox** Linode (tagged `mindmeld-bakebox`).
2. Uploads the `Agent/` build context (the venv, caches and `*.env` secrets are
   excluded — they never leave your dev box).
3. Builds `mindmeld-agent`, installs the worker systemd unit, wipes the containerd
   cache and trims the OS (asserts `< 5.4 GB` used before continuing).
4. Powers off, **shrinks the disk to 6144 MB**, and captures
   **`MindMeldBurstVmImage<version>`** — version = highest existing + 1.
5. Builds the **production frontend** (codegen + bundle + mangle + obfuscate, the
   `setup.bat --aggressive` equivalent), then SSHes into the base node, refreshes the
   Agent code + venv **and the Dock code** (a brute-force copy of `Dock/` *including*
   `node_modules` + the freshly-built obfuscated `Static/` —
   no `npm install` on the server; only the env secrets are excluded so the live
   `Dock/.production.env` is never clobbered), writes the new image id into
   `Dock/.production.env` (`BURST_IMAGE_ID`), ensures Dock + cloudflared run as
   services (idempotent), and **restarts Dock** so the live fleet boots the new image.
6. Deletes the bakebox and any **older** `MindMeldBurstVmImage<version>` images.
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
| *(none)* | Full bake → roll-out → cleanup. |
| `--skip-base-update` | Bake + capture only; don't touch the base node or delete old images. |
| `--cleanup-bakeboxes` | Delete stray `mindmeld-bakebox` Linodes from a failed run, then exit. |

> **The Dock systemd service is created automatically.** On every base-node update
> `deploy.sh` writes/refreshes `/etc/systemd/system/mindmeld-dock.service` (correct
> `node` path — it finds the nvm build, not `/usr/bin/node` — `WorkingDirectory` =
> `<repo-dir>/Dock`, `Restart=always`, enabled so it survives reboots), then
> `systemctl restart`s it. You never hand-write the unit, and on subsequent runs it's
> just a plain `systemctl restart mindmeld-dock`. See
> [`Remote/BaseNodeUpdate.sh`](../Deployment/Remote/BaseNodeUpdate.sh).

> **Scope.** `deploy.sh` rolls out **Agent** changes (the burst image + base-node
> venv + image pointer) **and Dock code** (brute-force copy incl. `node_modules`). It
> **builds the production frontend itself** before shipping Dock (the
> `setup.bat --aggressive` equivalent — codegen + bundle + mangle + obfuscate — run as
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

> ⚡ **Recommended for a Windows-dev workflow — build on Windows, ship the artifacts.**
> The base node only needs `Dock/`'s own deps (what `setup-base-node.sh` installs); it
> does NOT have the frontend build/obfuscation toolchain. So build locally and copy the
> result, rather than building on the base node:
>
> 1. On Windows, from the repo root: **`setup.bat --aggressive`** (does codegen — a
>    no-op if you didn't touch `Common/` — then `CopyStaticFiles` + bundle + mangle +
>    obfuscate, leaving a production-ready `Dock/Static/`).
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
>    sudo systemctl restart mindmeld-dock.service
>    ```

If the base node **does** have the build toolchain (you ran `npm install` for the build
scripts there), you can instead build in place:

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
3. Rebuild the image **on a Debian 12 bake box** (not Windows — see §1.2): spin up a
   throwaway Linode, get the `Agent/` build context onto it (the `tar` + `scp` method in
   §1.10, or `git clone`), and run `docker build -t mindmeld-agent -f Dockerfile .`
   from `Agent/`.
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
  `journalctl -u mindmeld-worker` — verify cloud-init wrote `/etc/mindmeld/worker.env`
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
