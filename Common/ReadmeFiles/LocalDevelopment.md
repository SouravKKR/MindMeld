# CogniumLearn Local Development Setup

This document is the single source of truth for preparing a developer machine to run
CogniumLearn locally. It is the local counterpart to
[Deployment.md](Deployment.md), which covers the cloud environments
(`development` / `testing` / `production`) and assumes in §1.1 that local development
already works — this file is what makes that assumption true.

> **Scope: setup only.** Everything up to and including §7 brings the machine to the point
> where a single command starts the server. **Starting the server is the developer's step**
> (§8) — an assistant or script performing "setup" must stop at the end of §7 and hand the
> command over, never launch the server unless explicitly asked to.

---

## 0. What "local" means (read this first — there is a trap here)

Both services resolve which env file to load from an **environment name**, using the same
priority order so Dock and the Agent subprocesses it spawns can never disagree:

1. an explicit `--environment=<name>` flag
2. the `COGNIUMLEARN_ENVIRONMENT` variable
3. legacy `--debug` → `local`
4. **otherwise → `production`**

The resolvers are [Dock/index.js](../../Dock/index.js) (`resolveEnvironmentName`) and
[Agent/Globals/Utility/EnvironmentLoader.py](../../Agent/Globals/Utility/EnvironmentLoader.py)
(`resolve_environment_name`). The name `local` maps to `.local.env` with a fallback to the
historical `.env`; every other name maps to `.<name>.env` only.

> **Trap.** Rule 4 means a bare `node Dock/index.js` with no flags runs against
> **production** — real Mongo, real user data, real credits. Always launch local work
> through `npm run web`, which passes `--debug`. See §8.

| | Local | Cloud environments |
|---|---|---|
| Launch | `npm run web` | systemd unit on the base node |
| Environment name | `local` (via `--debug`) | `COGNIUMLEARN_ENVIRONMENT` |
| Dock env file | `Dock/.local.env`, else `Dock/.env` | `Dock/.<env>.env` |
| Agent env file | `Agent/.local.env`, else `Agent/.env` | `Agent/.<env>.env` |
| Mongo / Redis | Docker containers on `127.0.0.1` | VPC-private Mongo VM / node-local Redis |
| Secrets directory | beside the service file | `COGNIUMLEARN_SECRETS_DIRECTORY` (tmpfs) |

---

## 1. Prerequisites

| Tool | Purpose | Known-good version |
|---|---|---|
| Node.js + npm | Dock server, build pipeline, codegen | Node 24.x, npm 11.x |
| Python | Agent worker (`Agent/.venv`) | 3.12.x |
| Docker | MongoDB + Redis containers | 29.x (Docker Desktop on Windows) |

Verify all four before going further:

```powershell
node --version
npm --version
python --version
docker --version
```

---

## 2. Backing services — MongoDB and Redis

Dock **will not boot without Redis** — `TaskManager.initialize` runs in the boot path and
throws if `127.0.0.1:6379` is unreachable. Mongo is needed by every database-backed route.

Both run as hand-created Docker containers:

| Container | Image | Host port |
|---|---|---|
| `cogniumlearn-local-mongo` | `mongo:7` | `27017` |
| `cogniumlearn-local-redis` | `redis:7-alpine` | `6379` |

### 2.1 If the containers already exist — start them, never recreate them

```powershell
docker ps -a --filter "name=cogniumlearn-local-"
docker start cogniumlearn-local-mongo cogniumlearn-local-redis
```

> **Never `docker rm` these containers.** Mongo's `/data/db` sits on an **anonymous**
> Docker volume — removing the container orphans the volume and the local database becomes
> unreachable. Both containers use restart policy `no`, so a Docker Desktop restart or a
> host reboot leaves them in `Exited (255)`. That status is expected and harmless; it means
> "start me again", not "recreate me".

### 2.2 Only if a container is genuinely missing — create it

```powershell
docker run -d --name cogniumlearn-local-redis -p 6379:6379 redis:7-alpine

docker run -d --name cogniumlearn-local-mongo -p 27017:27017 `
  -e MONGO_INITDB_ROOT_USERNAME=<user> `
  -e MONGO_INITDB_ROOT_PASSWORD=<password> `
  mongo:7
```

Take `<user>` / `<password>` from the `MONGODB_URL` already in [Dock/.env](../../Dock/.env)
— they are not repeated here because this file is checked into the repository. The root
credentials are only honoured on the **first** initialisation of an empty data volume; a
recreated container against a fresh volume also means an empty database.

### 2.3 Verify both are actually serving

A container reporting `Up` is not proof the service inside answers:

```powershell
docker exec cogniumlearn-local-redis redis-cli ping
docker exec cogniumlearn-local-mongo mongosh --quiet --eval "db.adminCommand({ping:1}).ok"
```

Expect `PONG` and `1`.

---

## 3. Environment files

Neither `Dock/.local.env` nor `Agent/.local.env` is required — local resolution falls back
to the historical `.env` in each service directory. What must exist is one of each pair:

| File | Must contain |
|---|---|
| `Dock/.env` (or `.local.env`) | `MONGODB_URL`, `MONGODB_DATABASE_NAME`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PAID_DECK_MASTER_KEY_BASE64` |
| `Agent/.env` (or `.local.env`) | `MONGODB_URL`, `MONGODB_DATABASE_NAME`, `REDIS_URL`, the LLM provider settings |

[Dock/.env.example](../../Dock/.env.example) documents every variable Dock reads, grouped
Required / Recommended / Optional. There is no `Agent/.env.example`; mirror the Mongo and
Redis values from `Dock/.env` and add the provider keys the workflows you exercise need.

Two invariants worth checking by eye before every local run:

- **`MONGODB_URL` in both files points at `127.0.0.1:27017`**, not a cloud host. A local
  build pointed at a deployed database will read and write real user data.
- `PAID_DECK_MASTER_KEY_BASE64` is set and decodes to exactly 32 bytes. Without it
  `KeyManagementService` never becomes ready and every paid-deck write endpoint returns
  `KEY_MANAGEMENT_NOT_READY` (HTTP 503). Locally any 32-byte key works, but once a paid
  deck has been created with it, changing it makes that content permanently undecryptable.

---

## 4. Node dependencies

The repository root `package.json` is a launcher only — it declares **no dependencies**, so
a missing `node_modules` at the root is normal and needs no `npm install`.

The two directories that do need modules are installed automatically, on demand, by
`CommandRunner.ensureDependencies` — it runs `npm install` only when `node_modules` is
absent:

| Directory | Installed by | For |
|---|---|---|
| `Common/` | `BuildPipeline.run()` | codegen, bundling, obfuscation |
| `Dock/` | `RunWeb.js` / `RunProduction.js` | the server itself |

Nothing to do by hand. If you want the first run to be fast rather than self-installing,
run `npm install` in `Common/` and `Dock/` ahead of time.

---

## 5. Agent Python virtual environment

Dock spawns the Agent as a subprocess and locates the interpreter through
[GetPythonExecutablePathFromVenv.js](../../Dock/Globals/UtilityFunctions.js/GetPythonExecutablePathFromVenv.js),
which resolves `Agent/.venv/Scripts/python.exe` on Windows and `Agent/.venv/bin/python` (or
`bin/python3`) elsewhere. The path is hard-coded to `Agent/.venv` — a differently named or
globally installed environment will not be found.

Create it once if it is missing:

```powershell
python -m venv f:\CogniumLearn\Agent\.venv
f:\CogniumLearn\Agent\.venv\Scripts\python.exe -m pip install --upgrade pip
f:\CogniumLearn\Agent\.venv\Scripts\python.exe -m pip install -r f:\CogniumLearn\Agent\requirements.txt
```

Verify:

```powershell
f:\CogniumLearn\Agent\.venv\Scripts\python.exe --version
```

Without this venv, Dock still boots and serves the UI, but every generation task, Ask-AI
stream and auto-fill request fails when the subprocess spawn cannot find the interpreter.

---

## 6. Frontend build

**Always edit `Main/` — never `Dock/Static/`.** `CopyStaticFiles.js` wipes and re-copies
`Main/` → `Dock/Static/` mid-build; the server serves the bundled, obfuscated result out of
`Dock/Static/`.

There is only one build — the aggressive one. [BuildPipeline.js](../Scripts/BuildPipeline.js)
runs these steps in this fixed order:

1. `GenerateServiceManifest.js`
2. `GenerateEnumerations.js`
3. `GenerateConstants.js`
4. `GenerateClasses.js`
5. `CopyStaticFiles.js`
6. `BundleStaticFiles.js`
7. `ManglePrivateMembersInBundle.js`
8. `MinifyAndObfuscateStaticFiles.js --aggressive`

Two entry points, differing only in whether the build is conditional:

```powershell
# Always rebuilds, unconditionally. Run after any Common/ or Main/ change.
npm run setup
```

The run modes (`web`, `production`, `desktop`, `android`, `ios`) instead call
`runIfStale()`, which compares a stored signature of the build inputs (`BuildFreshness.js`,
skipping `node_modules` and `.git`) and prints *"Frontend is already built and no build
inputs changed since the last build — skipping the build."* when there is nothing to do.
Set `COGNIUMLEARN_FORCE_BUILD=1` to force a rebuild from any entry point.

Generated enum / constant / model files are **never** edited directly — edit the JSON
source under `Common/` and re-run the build.

---

## 7. Setup verification (without starting the server)

This is the last step of setup. All five checks must pass; none of them starts Dock.

```powershell
# 1. Containers are up and answering.
docker exec cogniumlearn-local-redis redis-cli ping
docker exec cogniumlearn-local-mongo mongosh --quiet --eval "db.adminCommand({ping:1}).ok"

# 2. An env file resolves for each service.
Test-Path f:\CogniumLearn\Dock\.local.env, f:\CogniumLearn\Dock\.env
Test-Path f:\CogniumLearn\Agent\.local.env, f:\CogniumLearn\Agent\.env

# 3. The Agent interpreter exists.
Test-Path f:\CogniumLearn\Agent\.venv\Scripts\python.exe

# 4. Dock's modules are present (or will self-install on first run).
Test-Path f:\CogniumLearn\Dock\node_modules

# 5. Nothing is already occupying the port.
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
```

Check 5 returning nothing is the pass condition — a listener on 3000 means an earlier Dock
is still running and the new one will fail to bind.

Setup is complete here. Hand over the command in §8.

---

## 8. Starting the server (the developer's step)

```powershell
npm run web
```

That is [RunWeb.js](../Scripts/RunWeb.js): `runIfStale()` build → `ensureDependencies(Dock/)`
→ `node Dock/index.js --debug` with the working directory set to `Dock/`. It serves
**http://localhost:3000** and stays in the foreground; `Ctrl+C` stops it.

Related modes: `npm run production` is the same build with `--debug` omitted — the local
equivalent of the deployed server, and the mode to use for the queue/autoscaler dry-run
described in [Deployment.md](Deployment.md) §1.1.

### A healthy boot looks like this

```
Frontend is already built and no build inputs changed since the last build — skipping the build.
Starting Dock in WEB (debug) mode on http://localhost:3000 ...
[dotenv] injecting env (N) from .env
TaskManager initialized.
ForeignExchangeRatesCache initialized.
Server with <n> Listening on http://0.0.0.0:3000
[GenerationTemplateSeeder] Inserted 0 new template(s); updated 20 existing; ...
[LegalDocumentSeeder] Inserted 0, upgraded 0, unchanged 2, pruned 0.
Connected to database
```

Confirm it serves:

```powershell
Invoke-WebRequest -Uri "http://localhost:3000/index.html" -UseBasicParsing -TimeoutSec 15
```

### Log lines that look alarming but are normal locally

| Line | Why it is fine |
|---|---|
| `$listSearchIndexes stage is only allowed on MongoDB Atlas` | The text-embeddings and support-tickets **vector search indexes cannot be created on a plain Mongo container**. Everything except embedding-similarity search works; this is a genuine local-only capability gap, not a misconfiguration. |
| Every seeder line printed twice | Dock and the Agent subprocess it spawns each run the seeders. They are idempotent (`Inserted 0`). |
| `[OrphanedGenerationReconciler] Settled orphaned run … as resumable (INTERRUPTED)` | The boot reconciler cleaning up a generation that was in flight when Dock last stopped. Expected after any hard stop. |

### Stopping it cleanly

`Ctrl+C` in the foreground terminal. If it was backgrounded, confirm the port is released
and no orphaned worker survived:

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='python.exe'" |
    Where-Object { $_.CommandLine -match "Dock|Agent" } | Select-Object ProcessId, CommandLine
```

Leaving Mongo and Redis running between sessions is fine and saves the start-up step.

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `docker` commands fail with `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine` | Docker Desktop is not running — the daemon, not the containers | Start `C:\Program Files\Docker\Docker\Docker Desktop.exe` and wait until `docker version` succeeds, then continue at §2.1 |
| Container shows `Exited (255)` | Docker Desktop restarted; restart policy is `no` | `docker start <name>` — do **not** recreate (§2.1) |
| Build dies in `BundleStaticFiles.js` with `EBUSY: resource busy or locked, unlink '...\Dock\Static\...'` | A transient lock on a file `CopyStaticFiles.js` had just written — antivirus scanning the fresh copies, or an editor/Explorer window holding `Dock/Static/` | Confirm no Dock is running (`Get-CimInstance Win32_Process -Filter "Name='node.exe'"`), then simply re-run `npm run setup`; it succeeds once the scan releases the handle |
| Dock exits during boot in `TaskManager.initialize` | Redis not reachable on `127.0.0.1:6379` | Start the Redis container; confirm with `redis-cli ping` |
| Every DB route returns 500, `MONGODB_URL` undefined | No env file resolved for the environment name | Confirm `Dock/.env` exists and you launched via `npm run web` (§0) |
| Server started against real data | Bare `node Dock/index.js` → `production` (§0 trap) | Stop it immediately; relaunch with `npm run web` |
| Paid-deck writes return `KEY_MANAGEMENT_NOT_READY` (503) | `PAID_DECK_MASTER_KEY_BASE64` missing or not 32 bytes | Set a valid 32-byte base64 key (§3) |
| Frontend change not visible | `Dock/Static/` still holds the previous bundle | `npm run setup`, or `COGNIUMLEARN_FORCE_BUILD=1 npm run web` |
| Generation / Ask-AI fails, UI otherwise fine | `Agent/.venv` missing or incomplete | Rebuild the venv from `requirements.txt` (§5) |
| `EADDRINUSE` on 3000 | A previous Dock is still running | Find and stop it (§8, "Stopping it cleanly") |
