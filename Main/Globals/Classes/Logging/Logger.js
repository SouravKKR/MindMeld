import { logLevel } from "../../Enumerations/LogLevel.js";
import { logCategory } from "../../Enumerations/LogCategory.js";
import LogTitles from "./LogTitles.js";

/**
 * Logger (browser) — buffers client log entries and flushes them to POST
 * /Logs/Ingest, where Dock persists them through the same durable pipeline as
 * server logs (tagged with the WEB service origin). Best-effort: entries are sent
 * every few seconds, when the buffer fills, and via navigator.sendBeacon on page
 * unload so a closing tab does not drop them. initialize() installs the global
 * error / unhandledrejection capture — the gap where browser errors never left the
 * user's device.
 */
class Logger
{
    static #buffer = [];
    static #flushTimer = null;
    static #bInitialized = false;

    static #FLUSH_INTERVAL_MILLISECONDS = 4000;
    static #MAXIMUM_BUFFER_LENGTH = 50;

    static initialize()
    {
        if (Logger.#bInitialized)
        {
            return;
        }
        Logger.#bInitialized = true;

        window.addEventListener("error", (errorEvent) =>
        {
            const message = (errorEvent && errorEvent.message) ? errorEvent.message : "Uncaught error";
            const additionalData =
            {
                source: (errorEvent && errorEvent.filename) ? errorEvent.filename : "",
                line: (errorEvent && errorEvent.lineno) ? errorEvent.lineno : 0,
                column: (errorEvent && errorEvent.colno) ? errorEvent.colno : 0,
                stack: (errorEvent && errorEvent.error && errorEvent.error.stack) ? String(errorEvent.error.stack).slice(0, 2000) : ""
            };
            Logger.error(logCategory.ERROR, LogTitles.CLIENT_ERROR, message, { additionalData: additionalData });
        });

        window.addEventListener("unhandledrejection", (rejectionEvent) =>
        {
            const reason = rejectionEvent ? rejectionEvent.reason : null;
            const message = (reason && reason.message) ? reason.message : String(reason || "Unhandled promise rejection");
            const additionalData = { stack: (reason && reason.stack) ? String(reason.stack).slice(0, 2000) : "" };
            Logger.error(logCategory.ERROR, LogTitles.CLIENT_UNHANDLED_REJECTION, message, { additionalData: additionalData });
        });

        window.addEventListener("beforeunload", () => { Logger.#flush(true); });
    }

    static #enqueue(level, category, title, message, options)
    {
        Logger.#buffer.push(
        {
            level: level,
            category: category,
            title: typeof title === "string" ? title : String(title),
            message: message === undefined || message === null ? "" : String(message),
            errorCode: (options && options.errorCode) ? String(options.errorCode) : "",
            errorReason: (options && options.errorReason) ? String(options.errorReason) : "",
            additionalData: (options && options.additionalData && typeof options.additionalData === "object") ? options.additionalData : {}
        });

        if (Logger.#buffer.length >= Logger.#MAXIMUM_BUFFER_LENGTH)
        {
            Logger.#flush(false);
        }
        else if (Logger.#flushTimer === null)
        {
            Logger.#flushTimer = window.setTimeout(() => Logger.#flush(false), Logger.#FLUSH_INTERVAL_MILLISECONDS);
        }
    }

    static #flush(bUseBeacon)
    {
        if (Logger.#flushTimer !== null)
        {
            window.clearTimeout(Logger.#flushTimer);
            Logger.#flushTimer = null;
        }
        if (Logger.#buffer.length === 0)
        {
            return;
        }

        const entries = Logger.#buffer.splice(0, Logger.#buffer.length);
        const payload = JSON.stringify({ entries: entries });

        try
        {
            if (bUseBeacon && navigator.sendBeacon)
            {
                navigator.sendBeacon("/Logs/Ingest", new Blob([payload], { type: "application/json" }));
            }
            else
            {
                fetch("/Logs/Ingest",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: payload,
                    keepalive: true,
                    credentials: "same-origin"
                }).catch(() => {});
            }
        }
        catch (flushError)
        {
            // Best-effort — client logs must never break the app.
        }
    }

    static debug(category, title, message, options)
    {
        Logger.#enqueue(logLevel.DEBUG, category, title, message, options);
    }

    static info(category, title, message, options)
    {
        Logger.#enqueue(logLevel.INFO, category, title, message, options);
    }

    static warning(category, title, message, options)
    {
        Logger.#enqueue(logLevel.WARNING, category, title, message, options);
    }

    static error(category, title, message, options)
    {
        Logger.#enqueue(logLevel.ERROR, category, title, message, options);
    }
}

export default Logger;
