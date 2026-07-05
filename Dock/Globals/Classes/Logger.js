const crypto = require("crypto");

const { logLevel } = require("../Enumerations/LogLevel");
const { logCategory } = require("../Enumerations/LogCategory");
const { logServiceOrigin } = require("../Enumerations/LogServiceOrigin");
const LogFormatter = require("./Logging/LogFormatter");
const LogIngester = require("./Logging/LogIngester");

/**
 * Logger — the single structured logging entry point for Dock. Every call builds
 * a canonical log entry (id, level, category, title, message, service, optional
 * accountId / errorCode / errorReason / additionalData) with the timestamp stamped
 * INTERNALLY (never a caller parameter), hands it to LogIngester for durable
 * persistence into the logEvents collection, and mirrors it to standard output so
 * an operator tailing the service (journald) always has a live trace.
 *
 * The date/time is never a parameter. Level is chosen by the method
 * (debug/info/warning/error); category is a LogCategory enum; title is a string
 * (use LogTitles.* constants for the fixed events); options carry the structured
 * extras. This runs in ALL environments — production included — unlike the old
 * --debug-only file logger it replaces.
 *
 * The legacy log(message, source) and logWorker(...) signatures are preserved so
 * existing call sites keep working, and initialize()/isEnabled()/getSessionId()
 * retain their meaning for the worker-supervision code that reads them.
 */
class Logger
{
    static #debugEnabled = false;
    static #sessionId = null;
    static #environment = "production";
    static #sequenceCounter = 0;

    static initialize()
    {
        Logger.#debugEnabled = process.argv.includes("--debug") || process.env.DOCK_DEBUG === "1";
        Logger.#sessionId = Date.now().toString();
        Logger.#environment = Logger.#resolveEnvironment();
    }

    static #resolveEnvironment()
    {
        const explicitEnvironmentFlag = process.argv.find(argument => argument.startsWith("--environment="));
        if (explicitEnvironmentFlag)
        {
            return explicitEnvironmentFlag.slice("--environment=".length);
        }
        if (process.env.MINDMELD_ENVIRONMENT)
        {
            return process.env.MINDMELD_ENVIRONMENT;
        }
        if (process.argv.includes("--debug"))
        {
            return "local";
        }
        return "production";
    }

    static isEnabled()
    {
        return Logger.#debugEnabled;
    }

    static getSessionId()
    {
        return Logger.#sessionId;
    }

    static #nextSequence()
    {
        Logger.#sequenceCounter = (Logger.#sequenceCounter + 1) % Number.MAX_SAFE_INTEGER;
        return Logger.#sequenceCounter;
    }

    static #record(level, category, title, message, options = {})
    {
        const now = new Date();
        const logEntryDocument =
        {
            id: crypto.randomUUID(),
            level: level,
            category: category,
            title: typeof title === "string" ? title : String(title),
            message: message === undefined || message === null ? "" : String(message),
            service: (options.service !== undefined && options.service !== null) ? options.service : logServiceOrigin.DOCK,
            accountId: options.accountId ? String(options.accountId) : "",
            errorCode: options.errorCode ? String(options.errorCode) : "",
            errorReason: options.errorReason ? String(options.errorReason) : "",
            additionalData: (options.additionalData && typeof options.additionalData === "object") ? options.additionalData : {},
            timestamp: now,
            timestampIsoString: now.toISOString(),
            sequence: Logger.#nextSequence(),
            environment: Logger.#environment
        };

        // Mirror to standard output (journald). To keep production journald lean,
        // only WARNING/ERROR are mirrored unless --debug is on; every entry is
        // still persisted to MongoDB regardless.
        if (Logger.#debugEnabled || level >= logLevel.WARNING)
        {
            try
            {
                process.stdout.write(`${LogFormatter.formatLine(logEntryDocument)}\n`);
            }
            catch (standardOutputError)
            {
                // A closed stdout must never break the app.
            }
        }

        LogIngester.write(logEntryDocument);
    }

    static debug(category, title, message, options = {})
    {
        Logger.#record(logLevel.DEBUG, category, title, message, options);
    }

    static info(category, title, message, options = {})
    {
        Logger.#record(logLevel.INFO, category, title, message, options);
    }

    static warning(category, title, message, options = {})
    {
        Logger.#record(logLevel.WARNING, category, title, message, options);
    }

    static error(category, title, message, options = {})
    {
        Logger.#record(logLevel.ERROR, category, title, message, options);
    }

    /**
     * Records at an explicit numeric level. Used by the /Logs/Ingest endpoint to
     * persist browser-emitted entries (which carry their own level and a WEB
     * service origin via options.service).
     */
    static record(level, category, title, message, options = {})
    {
        Logger.#record(level, category, title, message, options);
    }

    /**
     * Legacy signature. Existing call sites pass (message, sourceTag); map them to
     * a structured SYSTEM/INFO entry with the tag as the title so those logs are
     * captured rather than dropped.
     */
    static log(message, source = "DOCK")
    {
        Logger.#record(logLevel.INFO, logCategory.SYSTEM, String(source), message, {});
    }

    /**
     * Legacy worker-output echo used only in --debug. The Agent now logs itself
     * directly to MongoDB, so this stays a standard-output convenience (no double
     * persistence) for a developer watching a local worker.
     */
    static logWorker(taskTypeName, taskId, stream, line)
    {
        if (!Logger.#debugEnabled)
        {
            return;
        }
        if (line === "" || line == null)
        {
            return;
        }

        const shortId = taskId ? String(taskId).slice(0, 8) : "????????";
        const tag = `AGENT:${taskTypeName}:${shortId}${stream === "stderr" ? ":err" : ""}`;
        try
        {
            process.stdout.write(`[${new Date().toISOString()}] [${tag}] ${line}\n`);
        }
        catch (standardOutputError)
        {
            // ignore
        }
    }
}

module.exports = Logger;
