const { spawn } = require("child_process");
const path = require("path");
const Logger = require("../../../Globals/Classes/Logger");
const { getPythonExecutablePathFromVenv } = require("../../../Globals/UtilityFunctions.js/GetPythonExecutablePathFromVenv");

/**
 * ChatStrategyRunner
 *
 * Spawns the one-shot DetermineChatStrategy.py worker for a deck-chat turn and
 * captures its single JSON line. Unlike AskAiStreamRunner this is NOT streaming —
 * it reads the whole stdout, parses it, and resolves. Every failure path (spawn
 * error, timeout, malformed output) resolves to a safe default so a chat turn is
 * never blocked by the strategy step; the answer call proceeds either way.
 *
 * Mirrors the spawn setup in AskAiStreamRunner (python-from-venv, Agent cwd,
 * --debug pass-through, env). Dock holds no AI code.
 */
class ChatStrategyRunner
{
    static #SCRIPT_TIMEOUT_MILLISECONDS = 12000;
    static #DEFAULT_STRATEGY = { nearestCards: 4, nearestMaterials: 3, expandedQueries: [] };

    static async run({ userQuery, conversation = null, modelId })
    {
        return new Promise((resolve) =>
        {
            let bSettled = false;
            const finish = (result) =>
            {
                if (!bSettled)
                {
                    bSettled = true;
                    resolve(result);
                }
            };

            try
            {
                const agentServicePath = process.env.AGENT_SERVICE_PATH || path.join(__dirname, "../../../..", "Agent");
                const pythonInterpreterPath = getPythonExecutablePathFromVenv(path.join(agentServicePath, ".venv"));
                const workerScriptPath = path.join(agentServicePath, "Workflows", "AskAi", "DetermineChatStrategy.py");
                const runModeArguments = process.argv.includes("--debug") ? ["--debug"] : [];

                const childProcess = spawn(
                    pythonInterpreterPath,
                    [workerScriptPath, ...runModeArguments],
                    {
                        cwd: agentServicePath,
                        stdio: ["pipe", "pipe", "pipe"],
                        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" },
                    }
                );

                let stdoutData = "";
                childProcess.stdout.on("data", (chunk) => { stdoutData += chunk.toString(); });
                childProcess.stderr.on("data", (chunk) =>
                {
                    const line = chunk.toString().trim();
                    if (line.length > 0)
                    {
                        Logger.log(`[ChatStrategy worker] ${line}`, "AGENT:ASK_AI");
                    }
                });

                const timeoutId = setTimeout(() =>
                {
                    try { if (childProcess.exitCode === null) childProcess.kill("SIGTERM"); }
                    catch (killError) { /* already gone */ }
                    finish(ChatStrategyRunner.#DEFAULT_STRATEGY);
                }, ChatStrategyRunner.#SCRIPT_TIMEOUT_MILLISECONDS);

                childProcess.on("error", (spawnError) =>
                {
                    clearTimeout(timeoutId);
                    Logger.log(`[ChatStrategy] worker spawn error: ${spawnError.message}`, "DOCK");
                    finish(ChatStrategyRunner.#DEFAULT_STRATEGY);
                });

                childProcess.on("close", () =>
                {
                    clearTimeout(timeoutId);
                    finish(ChatStrategyRunner.#parseStrategy(stdoutData));
                });

                childProcess.stdin.write(JSON.stringify({ userQuery, conversation, modelId }));
                childProcess.stdin.end();
            }
            catch (runError)
            {
                Logger.log(`[ChatStrategy] run failed: ${runError.message}`, "DOCK");
                finish(ChatStrategyRunner.#DEFAULT_STRATEGY);
            }
        });
    }

    static #parseStrategy(stdoutData)
    {
        try
        {
            const lines = String(stdoutData || "").trim().split("\n").filter((line) => line.trim().length > 0);
            const lastLine = lines.length > 0 ? lines[lines.length - 1] : "";
            if (lastLine.length === 0)
            {
                return ChatStrategyRunner.#DEFAULT_STRATEGY;
            }

            const parsed = JSON.parse(lastLine);
            return {
                nearestCards:     Number.isFinite(parsed.nearestCards) ? parsed.nearestCards : ChatStrategyRunner.#DEFAULT_STRATEGY.nearestCards,
                nearestMaterials: Number.isFinite(parsed.nearestMaterials) ? parsed.nearestMaterials : ChatStrategyRunner.#DEFAULT_STRATEGY.nearestMaterials,
                expandedQueries:  Array.isArray(parsed.expandedQueries) ? parsed.expandedQueries.filter((entry) => typeof entry === "string") : [],
            };
        }
        catch (parseError)
        {
            return ChatStrategyRunner.#DEFAULT_STRATEGY;
        }
    }
}

module.exports = ChatStrategyRunner;
