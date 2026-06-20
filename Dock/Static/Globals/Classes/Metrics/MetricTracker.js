import MilestoneBadgeCelebrationController from "./MilestoneBadgeCelebrationController.js";
import AuthenticationEvents from "../../Events/AuthenticationEvents.js";

/**
 * Client side of the achievement metrics. Cards and mock tests are recomputed
 * server-side from Mongo, and doubts are counted server-side at the AskAi
 * endpoint (the client never reports any of those), so this only:
 *   - accrues study time locally — minutes studied (activity-gated, in 5-minute
 *     blocks via addStudySeconds), the one metric not derivable server-side;
 *   - posts to /Metrics/Sync at activity BOUNDARIES (not per event): a backstop
 *     timer while pending, on tab-hide (beacon), and on explicit triggers
 *     (study-session end, mock completion, login) which also force the server's
 *     cards/mock recompute. The buffer is localStorage-backed and login-gated.
 */
class MetricTracker
{
    static #SYNC_ENDPOINT = "/Metrics/Sync";
    static #PENDING_STORAGE_KEY = "mindmeld.metricsPending";
    static #STUDY_BLOCK_SECONDS = 300;
    static #MINUTES_PER_BLOCK = 5;
    static #BACKSTOP_SYNC_MILLISECONDS = 120000;
    // Only study time is client-reported now; doubts are counted server-side at
    // the AskAi endpoint, and cards / mock tests are recomputed from Mongo.
    static #COUNTER_KEYS = ["minutesStudied"];

    static #pending = null;
    static #studySecondsAccumulator = 0;
    static #backstopTimeoutId = null;
    static #isSyncing = false;
    static #isInitialised = false;

    static
    {
        MetricTracker.initialise();
    }

    static initialise()
    {
        if (MetricTracker.#isInitialised || typeof window === "undefined")
        {
            return;
        }
        MetricTracker.#isInitialised = true;
        MetricTracker.#pending = MetricTracker.#loadPending();

        window.addEventListener("pagehide", () =>
        {
            MetricTracker.#syncOnUnload();
        });
        document.addEventListener("visibilitychange", () =>
        {
            if (document.visibilityState === "hidden")
            {
                MetricTracker.#syncOnUnload();
            }
        });

        // Drop the buffer on logout so one user's pending increments can't be
        // credited to whoever logs in next on this device.
        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_OUT, () =>
        {
            MetricTracker.#clearPending();
        });

        // On login, force a recompute so cards/mock tests/leaderboard reflect any
        // study done on other devices since this device last synced.
        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_IN, () =>
        {
            MetricTracker.sync({ recompute: true });
        });

        if (MetricTracker.#hasPending())
        {
            MetricTracker.#scheduleBackstopSync();
        }
    }

    static #emptyPending()
    {
        return { minutesStudied: 0 };
    }

    static #clearPending()
    {
        MetricTracker.#pending = MetricTracker.#emptyPending();
        MetricTracker.#studySecondsAccumulator = 0;
        MetricTracker.#savePending();
    }

    static #loadPending()
    {
        const pending = MetricTracker.#emptyPending();
        try
        {
            const raw = window.localStorage.getItem(MetricTracker.#PENDING_STORAGE_KEY);
            const parsed = raw ? JSON.parse(raw) : null;
            if (parsed && typeof parsed === "object")
            {
                for (const key of MetricTracker.#COUNTER_KEYS)
                {
                    pending[key] = Number.isFinite(parsed[key]) ? Math.max(0, Math.floor(parsed[key])) : 0;
                }
            }
        }
        catch (readError)
        {
            // Corrupt buffer — start clean.
        }
        return pending;
    }

    static #savePending()
    {
        try
        {
            window.localStorage.setItem(MetricTracker.#PENDING_STORAGE_KEY, JSON.stringify(MetricTracker.#pending));
        }
        catch (writeError)
        {
            // Non-fatal.
        }
    }

    static #hasPending()
    {
        return MetricTracker.#COUNTER_KEYS.some((key) => (MetricTracker.#pending[key] || 0) > 0);
    }

    static addStudySeconds(seconds)
    {
        if (!Number.isFinite(seconds) || seconds <= 0)
        {
            return;
        }
        MetricTracker.#studySecondsAccumulator += seconds;

        let blocks = 0;
        while (MetricTracker.#studySecondsAccumulator >= MetricTracker.#STUDY_BLOCK_SECONDS)
        {
            MetricTracker.#studySecondsAccumulator -= MetricTracker.#STUDY_BLOCK_SECONDS;
            blocks++;
        }
        if (blocks > 0)
        {
            MetricTracker.#addPending("minutesStudied", blocks * MetricTracker.#MINUTES_PER_BLOCK);
        }
    }

    static #addPending(key, amount)
    {
        if (!MetricTracker.#isInitialised)
        {
            MetricTracker.initialise();
        }
        // Only accrue for a logged-in user.
        if (!window["user"])
        {
            return;
        }
        MetricTracker.#pending[key] = (MetricTracker.#pending[key] || 0) + amount;
        MetricTracker.#savePending();
        MetricTracker.#scheduleBackstopSync();
    }

    static #scheduleBackstopSync()
    {
        if (MetricTracker.#backstopTimeoutId !== null)
        {
            return;
        }
        MetricTracker.#backstopTimeoutId = setTimeout(() =>
        {
            MetricTracker.#backstopTimeoutId = null;
            MetricTracker.sync();
        }, MetricTracker.#BACKSTOP_SYNC_MILLISECONDS);
    }

    /**
     * Posts pending increments to /Metrics/Sync; the server also recomputes
     * cards/mock tests (throttled). Triggered at boundaries (study end, mock
     * completion, login) and by the backstop timer.
     * @param {{recompute?: boolean}} options — recompute:true forces a post even
     *        with no pending increments (login / session boundaries).
     */
    static async sync(options = {})
    {
        if (MetricTracker.#backstopTimeoutId !== null)
        {
            clearTimeout(MetricTracker.#backstopTimeoutId);
            MetricTracker.#backstopTimeoutId = null;
        }

        if (MetricTracker.#isSyncing || !window["user"])
        {
            return;
        }
        if (!MetricTracker.#hasPending() && options.recompute !== true)
        {
            return;
        }

        const snapshot = { ...MetricTracker.#pending };
        MetricTracker.#isSyncing = true;

        try
        {
            const response = await fetch(MetricTracker.#SYNC_ENDPOINT,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ increments: snapshot })
            });

            if (!response.ok)
            {
                return;
            }

            for (const key of MetricTracker.#COUNTER_KEYS)
            {
                MetricTracker.#pending[key] = Math.max(0, (MetricTracker.#pending[key] || 0) - (snapshot[key] || 0));
            }
            MetricTracker.#savePending();

            const result = await response.json().catch(() => ({}));
            if (result && result.metrics && window["user"] && typeof window["user"].getAdditionalData === "function")
            {
                const additionalData = window["user"].getAdditionalData();
                if (additionalData)
                {
                    additionalData.metrics = result.metrics;
                }
                MilestoneBadgeCelebrationController.evaluate(window["user"]);
            }
        }
        catch (syncError)
        {
            // Network error — keep the buffer for the next trigger.
        }
        finally
        {
            MetricTracker.#isSyncing = false;
        }
    }

    /**
     * Tab-hide / unload sync: clears the buffer up front and ships it via
     * sendBeacon (the server also recomputes), so a delivered batch isn't
     * re-sent next session. A rare failed unload-send loses that batch.
     */
    static #syncOnUnload()
    {
        // Skip if a normal sync is in flight — it owns the pending buffer; sending
        // a beacon now would double-apply the same increments.
        if (MetricTracker.#isSyncing || !window["user"] || !MetricTracker.#hasPending())
        {
            return;
        }

        const snapshot = { ...MetricTracker.#pending };
        MetricTracker.#pending = MetricTracker.#emptyPending();
        MetricTracker.#savePending();

        const payload = JSON.stringify({ increments: snapshot });

        let delivered = false;
        try
        {
            if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function")
            {
                delivered = navigator.sendBeacon(MetricTracker.#SYNC_ENDPOINT, new Blob([payload], { type: "application/json" }));
            }
        }
        catch (beaconError)
        {
            delivered = false;
        }

        if (!delivered)
        {
            try
            {
                fetch(MetricTracker.#SYNC_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", keepalive: true, body: payload });
            }
            catch (fetchError)
            {
                // Lost on unload — acceptable.
            }
        }
    }
}

export default MetricTracker;
