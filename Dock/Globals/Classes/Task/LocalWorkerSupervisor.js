const { spawn } = require("child_process");
const path = require("path");
const { getPythonExecutablePathFromVenv } = require("../../UtilityFunctions.js/GetPythonExecutablePathFromVenv");
const Logger = require("../Logger");

// Keeps a fixed number of long-lived Agent worker processes alive on the node
// running Dock (the strong always-on base VM). This is the warm baseline that
// guarantees queued tasks are processed even when zero burst VMs exist, so users
// never wait on a cold cloud start for ordinary load. Each supervised worker runs
// Agent/Worker.py, which polls the shared Redis queue. Crashed workers are
// restarted with a capped backoff so a crash-looping worker can't spin the CPU.
//
// Only started when the task queue is enabled (production, no --debug). In
// --debug / dev nothing is spawned and tasks run as one-shot local subprocesses
// exactly as before.

class LocalWorkerSupervisor
{
    static #DEFAULT_WORKER_COUNT = 2;
    static #MIN_RESTART_DELAY_MILLISECONDS = 1000;
    static #MAX_RESTART_DELAY_MILLISECONDS = 30 * 1000;

    static #workers = new Map();
    static #bStopping = false;
    static #bStarted = false;

    /**
     * Reads a strictly-positive integer from the environment, falling back when
     * the value is missing or invalid.
     * @param {string} environmentVariableName
     * @param {number} fallbackValue
     * @returns {number}
     */
    static #resolvePositiveIntegerSetting(environmentVariableName, fallbackValue)
    {
        const rawValue = process.env[environmentVariableName];

        if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "")
        {
            return fallbackValue;
        }

        const parsedValue = Number(rawValue);

        if (!Number.isFinite(parsedValue) || parsedValue <= 0)
        {
            console.warn(`[LocalWorkerSupervisor] Ignoring invalid ${environmentVariableName}="${rawValue}"; using default ${fallbackValue}.`);
            return fallbackValue;
        }

        return Math.floor(parsedValue);
    }

    /**
     * Spawns and supervises the configured number of local workers. Idempotent —
     * a second call is a no-op.
     */
    static start()
    {
        if (LocalWorkerSupervisor.#bStarted)
        {
            return;
        }
        LocalWorkerSupervisor.#bStarted = true;
        LocalWorkerSupervisor.#bStopping = false;

        const workerCount = LocalWorkerSupervisor.#resolvePositiveIntegerSetting("AGENT_LOCAL_WORKER_COUNT", LocalWorkerSupervisor.#DEFAULT_WORKER_COUNT);

        Logger.log(`[LocalWorkerSupervisor] Starting ${workerCount} local worker(s).`);

        for (let workerIndex = 0; workerIndex < workerCount; workerIndex++)
        {
            LocalWorkerSupervisor.#spawnWorker(workerIndex, LocalWorkerSupervisor.#MIN_RESTART_DELAY_MILLISECONDS);
        }
    }

    /**
     * @param {number} workerIndex
     * @param {number} restartDelayMilliseconds - Backoff applied if THIS spawn exits quickly.
     */
    static #spawnWorker(workerIndex, restartDelayMilliseconds)
    {
        if (LocalWorkerSupervisor.#bStopping)
        {
            return;
        }

        const agentServicePath = process.env.AGENT_SERVICE_PATH || path.join(__dirname, "../../../..", "Agent");
        const pythonPath = getPythonExecutablePathFromVenv(path.join(agentServicePath, ".venv"));
        const scriptPath = path.join(agentServicePath, "Worker.py");

        const scriptArgs = [scriptPath];
        if (Logger.isEnabled())
        {
            scriptArgs.push("--debug");
        }

        const startedAtMilliseconds = Date.now();

        // In production (no --debug) inherit Dock's stdout/stderr so the worker
        // writes straight to the journal (journalctl -u mindmeld-dock). This both
        // captures the full Python traceback of any task failure — which the old
        // pipe-into-a-no-op path silently discarded, leaving failures like
        // MapTopics' "[Errno 32] Broken pipe" un-diagnosable — and removes the
        // Node-managed pipe entirely (systemd/journald always drains). In --debug
        // keep the piped, per-line-tagged path so dev output stays attributed.
        const stdioConfiguration = Logger.isEnabled() ? "pipe" : ["ignore", "inherit", "inherit"];
        const childProcess = spawn(pythonPath, scriptArgs, { cwd: agentServicePath, stdio: stdioConfiguration });

        LocalWorkerSupervisor.#workers.set(workerIndex, childProcess);

        if (Logger.isEnabled())
        {
            const onOutput = (chunk, streamName) =>
            {
                const text = chunk.toString("utf-8");
                for (const line of text.split(/\r?\n/))
                {
                    if (line.length > 0)
                    {
                        Logger.log(`[LocalWorker ${workerIndex}:${streamName}] ${line}`);
                    }
                }
            };

            childProcess.stdout.on("data", (chunk) => onOutput(chunk, "stdout"));
            childProcess.stderr.on("data", (chunk) => onOutput(chunk, "stderr"));
        }

        childProcess.on("error", (spawnError) =>
        {
            console.error(`[LocalWorkerSupervisor] Worker ${workerIndex} failed to spawn:`, spawnError);
        });

        childProcess.on("exit", (exitCode, exitSignal) =>
        {
            LocalWorkerSupervisor.#workers.delete(workerIndex);

            if (LocalWorkerSupervisor.#bStopping)
            {
                return;
            }

            // Grow the backoff only when the process died quickly (likely a crash
            // loop); reset it when the worker had been running healthily.
            const ranForMilliseconds = Date.now() - startedAtMilliseconds;
            const nextDelayMilliseconds = ranForMilliseconds > LocalWorkerSupervisor.#MAX_RESTART_DELAY_MILLISECONDS
                ? LocalWorkerSupervisor.#MIN_RESTART_DELAY_MILLISECONDS
                : Math.min(restartDelayMilliseconds * 2, LocalWorkerSupervisor.#MAX_RESTART_DELAY_MILLISECONDS);

            console.warn(`[LocalWorkerSupervisor] Worker ${workerIndex} exited (code=${exitCode}, signal=${exitSignal}); restarting in ${restartDelayMilliseconds}ms.`);

            setTimeout(() => { LocalWorkerSupervisor.#spawnWorker(workerIndex, nextDelayMilliseconds); }, restartDelayMilliseconds);
        });
    }

    /**
     * Signals every supervised worker to stop. Workers finish their current task
     * and exit on SIGTERM. Idempotent.
     */
    static stop()
    {
        LocalWorkerSupervisor.#bStopping = true;

        for (const childProcess of LocalWorkerSupervisor.#workers.values())
        {
            try
            {
                childProcess.kill("SIGTERM");
            }
            catch (killError)
            {
                console.warn("[LocalWorkerSupervisor] Failed to signal a worker:", killError);
            }
        }
    }
}

module.exports = LocalWorkerSupervisor;
