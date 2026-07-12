import GenerationProgressComponent from "../../../Pages/Progress/Components/GenerationProgressComponent.js";
import { taskStatus } from "../../Enumerations/TaskStatus.js";
import { generationOutcomes } from "../../Enumerations/GenerationOutcomes.js";
import AuthenticationEvents from "../../Events/AuthenticationEvents.js";
import PageNavigator from "../PageNavigator.js";
import TaskProgressTracker from "../Task/TaskProgressTracker.js";

/**
 * GenerationNotifier
 *
 * Background completion-notification bridge for AI generations. The
 * ProgressPage only polls (and only surfaces an in-page banner) while it is
 * open — close the tab, switch pages, or background the window and a
 * minutes-long generation finishes with zero feedback. This class closes that
 * gap: it keeps polling tracked generations independently of any page and
 * raises a desktop notification when one reaches a terminal state.
 *
 * Two notification channels are used, picked by platform:
 *   - Web   → the browser Notifications API (same pattern as AlertNotifier).
 *   - Tauri → the native notification plugin (window.__TAURI__.notification).
 *
 * Durability: the set of tracked task IDs is mirrored to localStorage, so a
 * reload (or a desktop relaunch) resumes tracking the in-flight generations
 * rather than dropping them. Each entry carries the time it was registered so
 * stale records (whose live descriptor has long since expired) can be aged
 * out instead of being polled forever.
 *
 * Redundancy guard: while the user is actively watching a generation's
 * ProgressPage (foreground task, document visible) the OS notification for
 * THAT task is suppressed — the page banner is already telling them. The
 * moment they look away (tab hidden) or navigate off the page, the
 * notification fires normally.
 */
class GenerationNotifier
{
    static PROGRESS_ENDPOINT = "/Generate/Progress";
    static POLL_INTERVAL_MILLISECONDS = 5 * 1000;

    // After this many consecutive poll failures for a single task (404/403/
    // network), assume its descriptor is gone and stop tracking it silently —
    // we cannot determine an outcome, so notifying would be misleading.
    static MAX_CONSECUTIVE_POLL_FAILURES = 5;

    // Tracked entries older than this are dropped on the next sweep. A
    // generation that has not terminated in this window has almost certainly
    // had its live descriptor expire server-side (the task TTL is ~5h), so
    // polling it any longer is waste.
    static MAX_TRACKING_AGE_MILLISECONDS = 5 * 60 * 60 * 1000;

    static STORAGE_KEY = "generationNotifier.tracked";

    // taskId → { label: string, startedAt: number, failures: number }
    static #trackedTasks = new Map();
    static #notifiedTaskIds = new Set();
    static #intervalHandle = null;
    static #foregroundTaskId = null;
    static #bPollInFlight = false;

    // A single detached progress component reused to compute terminal state /
    // overall status from a raw task tree, so the roll-up logic stays in one
    // place (the component) rather than being re-implemented here.
    static #statusProbe = null;

    // ─────────────────────────────────────────────
    //  Permission
    // ─────────────────────────────────────────────

    static #isTauri()
    {
        // Matches Platform.js: the presence of the global is the desktop
        // signal. The notification plugin is reached either through its
        // high-level global (window.__TAURI__.notification, present only when
        // the guest-js binding is bundled) or, as a fallback, the always-present
        // core.invoke bridge — so detection must not hinge on .notification.
        return typeof window !== "undefined" && !!window.__TAURI__;
    }

    /**
     * Invokes a notification-plugin command through the core bridge, used when
     * the high-level window.__TAURI__.notification global isn't attached (the
     * common case for an unbundled frontend with only withGlobalTauri).
     * @returns {Promise<*>}
     */
    static async #tauriInvoke(command, payload)
    {
        const core = window.__TAURI__ && (window.__TAURI__.core || window.__TAURI__.tauri);
        if (!core || typeof core.invoke !== "function")
        {
            throw new Error("Tauri core.invoke unavailable");
        }
        return core.invoke(command, payload);
    }

    static async #tauriIsPermissionGranted()
    {
        if (window.__TAURI__.notification && typeof window.__TAURI__.notification.isPermissionGranted === "function")
        {
            return window.__TAURI__.notification.isPermissionGranted();
        }
        return GenerationNotifier.#tauriInvoke("plugin:notification|is_permission_granted");
    }

    static async #tauriRequestPermission()
    {
        if (window.__TAURI__.notification && typeof window.__TAURI__.notification.requestPermission === "function")
        {
            return window.__TAURI__.notification.requestPermission();
        }
        return GenerationNotifier.#tauriInvoke("plugin:notification|request_permission");
    }

    static async #tauriSendNotification(title, body)
    {
        if (window.__TAURI__.notification && typeof window.__TAURI__.notification.sendNotification === "function")
        {
            window.__TAURI__.notification.sendNotification({ title, body });
            return;
        }
        await GenerationNotifier.#tauriInvoke("plugin:notification|notify", { options: { title, body } });
    }

    static #isWebNotificationSupported()
    {
        return typeof window !== "undefined" && "Notification" in window;
    }

    static isSupported()
    {
        return GenerationNotifier.#isTauri() || GenerationNotifier.#isWebNotificationSupported();
    }

    static getPermission()
    {
        if (GenerationNotifier.#isWebNotificationSupported())
        {
            return Notification.permission;
        }
        // On Tauri the web Notification API is typically absent; permission is
        // resolved lazily through the plugin when a notification is sent.
        return GenerationNotifier.#isTauri() ? "default" : "unsupported";
    }

    /**
     * Prompts for notification permission. Must be called from a user gesture
     * (e.g. the "Start Generation" click) for the browser prompt to appear.
     * Returns the resulting permission string.
     */
    static async requestPermission()
    {
        if (GenerationNotifier.#isTauri())
        {
            try
            {
                const alreadyGranted = await GenerationNotifier.#tauriIsPermissionGranted();
                if (alreadyGranted === true || alreadyGranted === "granted")
                {
                    return "granted";
                }
                return await GenerationNotifier.#tauriRequestPermission();
            }
            catch (tauriPermissionError)
            {
                return "default";
            }
        }

        if (!GenerationNotifier.#isWebNotificationSupported())
        {
            return "unsupported";
        }
        if (Notification.permission === "granted" || Notification.permission === "denied")
        {
            return Notification.permission;
        }
        try
        {
            return await Notification.requestPermission();
        }
        catch (permissionError)
        {
            // Older browsers use the callback form; fall back to current state.
            return Notification.permission;
        }
    }

    // ─────────────────────────────────────────────
    //  Tracking lifecycle
    // ─────────────────────────────────────────────

    /**
     * Registers a generation to be tracked in the background. Idempotent —
     * re-tracking an already-tracked (and not-yet-notified) task only refreshes
     * its label. Starts the global poll loop if it is not already running.
     *
     * @param {string} taskId
     * @param {string} label - Human label for the notification (e.g. subject).
     */
    static track(taskId, label)
    {
        if (typeof taskId !== "string" || taskId.length === 0)
        {
            return;
        }
        if (GenerationNotifier.#notifiedTaskIds.has(taskId))
        {
            return;
        }

        const existing = GenerationNotifier.#trackedTasks.get(taskId);
        GenerationNotifier.#trackedTasks.set(taskId,
        {
            label: (typeof label === "string" && label.length > 0) ? label : (existing?.label || "Your generation"),
            startedAt: existing?.startedAt ?? GenerationNotifier.#now(),
            failures: existing?.failures ?? 0
        });

        GenerationNotifier.#persist();
        GenerationNotifier.#ensurePolling();
    }

    static stopTracking(taskId)
    {
        if (GenerationNotifier.#trackedTasks.delete(taskId))
        {
            GenerationNotifier.#persist();
        }
        if (GenerationNotifier.#trackedTasks.size === 0)
        {
            GenerationNotifier.#stopPolling();
        }
    }

    /**
     * Marks a task as the one whose ProgressPage is currently on screen, so
     * the redundant OS notification is suppressed while the user watches it.
     * ProgressPage calls this on connect and clears it (null) on disconnect.
     * @param {string|null} taskId
     */
    static setForegroundTask(taskId)
    {
        GenerationNotifier.#foregroundTaskId = (typeof taskId === "string" && taskId.length > 0) ? taskId : null;
    }

    /**
     * Clears the foreground task, but only if it still matches the given id.
     * A leaving ProgressPage calls this on disconnect; the guard prevents it
     * from wiping a foreground task that a freshly-connected ProgressPage just
     * claimed (web-component lifecycle can fire the new element's connect
     * before the old element's disconnect).
     * @param {string} taskId
     */
    static clearForegroundTask(taskId)
    {
        if (GenerationNotifier.#foregroundTaskId === taskId)
        {
            GenerationNotifier.#foregroundTaskId = null;
        }
    }

    /**
     * Re-hydrates tracked tasks from localStorage and resumes polling. Safe to
     * call multiple times; only the first call does work. Invoked on module
     * load and again on login (the session cookie the poll relies on is only
     * guaranteed present once authenticated).
     */
    static resume()
    {
        const persisted = GenerationNotifier.#readPersisted();
        const nowMilliseconds = GenerationNotifier.#now();

        for (const [taskId, entry] of Object.entries(persisted))
        {
            if (GenerationNotifier.#trackedTasks.has(taskId) || GenerationNotifier.#notifiedTaskIds.has(taskId))
            {
                continue;
            }
            const startedAt = typeof entry?.startedAt === "number" ? entry.startedAt : nowMilliseconds;
            if (nowMilliseconds - startedAt > GenerationNotifier.MAX_TRACKING_AGE_MILLISECONDS)
            {
                continue;
            }
            GenerationNotifier.#trackedTasks.set(taskId,
            {
                label: (typeof entry?.label === "string" && entry.label.length > 0) ? entry.label : "Your generation",
                startedAt,
                failures: 0
            });
        }

        GenerationNotifier.#persist();

        if (GenerationNotifier.#trackedTasks.size > 0)
        {
            GenerationNotifier.#ensurePolling();
        }
    }

    // ─────────────────────────────────────────────
    //  Polling
    // ─────────────────────────────────────────────

    static #ensurePolling()
    {
        if (GenerationNotifier.#intervalHandle !== null)
        {
            return;
        }
        GenerationNotifier.#intervalHandle = setInterval(GenerationNotifier.#pollAll, GenerationNotifier.POLL_INTERVAL_MILLISECONDS);
        GenerationNotifier.#pollAll();
    }

    static #stopPolling()
    {
        if (GenerationNotifier.#intervalHandle === null)
        {
            return;
        }
        clearInterval(GenerationNotifier.#intervalHandle);
        GenerationNotifier.#intervalHandle = null;
    }

    static async #pollAll()
    {
        // Re-entrancy guard: a slow cycle (many tasks / slow link) can run
        // longer than the poll interval; without this a second setInterval
        // tick would start an overlapping sweep that could double-process and
        // double-notify the same task.
        if (GenerationNotifier.#bPollInFlight)
        {
            return;
        }
        GenerationNotifier.#bPollInFlight = true;
        try
        {
            // Snapshot the IDs up front — #pollTask mutates the map as tasks
            // terminate or age out, which would otherwise disturb iteration.
            const taskIds = [...GenerationNotifier.#trackedTasks.keys()];
            const nowMilliseconds = GenerationNotifier.#now();

            for (const taskId of taskIds)
            {
                const entry = GenerationNotifier.#trackedTasks.get(taskId);
                if (!entry)
                {
                    continue;
                }
                if (nowMilliseconds - entry.startedAt > GenerationNotifier.MAX_TRACKING_AGE_MILLISECONDS)
                {
                    GenerationNotifier.stopTracking(taskId);
                    continue;
                }
                await GenerationNotifier.#pollTask(taskId, entry);
            }
        }
        finally
        {
            GenerationNotifier.#bPollInFlight = false;
        }
    }

    static async #pollTask(taskId, entry)
    {
        let payload;
        try
        {
            const response = await fetch(`${GenerationNotifier.PROGRESS_ENDPOINT}?taskid=${encodeURIComponent(taskId)}`);
            if (!response.ok)
            {
                // 401/403 means the session cookie isn't ready yet (e.g. polling
                // resumed at startup before /GetUser established auth). This is
                // transient — skip WITHOUT counting it, otherwise a logged-out
                // reload window would burn the failure budget and permanently
                // drop a still-running generation before login completes.
                if (response.status !== 401 && response.status !== 403)
                {
                    GenerationNotifier.#recordFailure(taskId, entry);
                }
                return;
            }
            payload = await response.json();
        }
        catch (pollError)
        {
            GenerationNotifier.#recordFailure(taskId, entry);
            return;
        }

        // Successful poll resets the transient-failure counter.
        if (entry.failures !== 0)
        {
            entry.failures = 0;
            GenerationNotifier.#persist();
        }

        const outcome = GenerationNotifier.#resolveOutcome(payload);
        if (outcome === null)
        {
            return; // Still in progress.
        }

        GenerationNotifier.#finishTask(taskId, entry, outcome);
    }

    static #recordFailure(taskId, entry)
    {
        entry.failures = (entry.failures || 0) + 1;
        if (entry.failures >= GenerationNotifier.MAX_CONSECUTIVE_POLL_FAILURES)
        {
            // Descriptor is gone / unreachable — drop it without notifying,
            // since we can no longer determine a success/failure outcome.
            GenerationNotifier.stopTracking(taskId);
            return;
        }
        GenerationNotifier.#persist();
    }

    /**
     * Maps a /Generate/Progress payload to a terminal GenerationOutcomes value,
     * or null when the pipeline is still running.
     * @returns {number|null}
     */
    static #resolveOutcome(payload)
    {
        if (!payload || typeof payload !== "object")
        {
            return null;
        }

        // Server-computed recoverable stop takes precedence over the root
        // status (which can read COMPLETED even when a deep child ran out).
        if (payload.outOfCredits === true)
        {
            return generationOutcomes.OUT_OF_CREDITS;
        }

        // A recoverable, resumable stop (user-initiated pause, or a post-pipeline
        // image-step failure) is NOT a true failure — the run is held with a
        // resumable snapshot and surfaced by the home PausedTaskBanner. Returning
        // null suppresses a misleading "generation failed" notification; the task
        // ages out (or its live blob TTLs) with no notification, and the eventual
        // resumed run notifies under its own id.
        if (payload.paused === true || payload.imagePreparationFailed === true)
        {
            return null;
        }

        // Archived record (live descriptor expired) — terminal by definition.
        if (payload.historical === true)
        {
            return payload.status === taskStatus.FAILED ? generationOutcomes.FAILURE : generationOutcomes.SUCCESS;
        }

        const probe = GenerationNotifier.#getStatusProbe();
        probe.update(payload);
        if (!probe.isTerminal())
        {
            return null;
        }

        return probe.getOverallStatus() === taskStatus.COMPLETED ? generationOutcomes.SUCCESS : generationOutcomes.FAILURE;
    }

    static #getStatusProbe()
    {
        if (GenerationNotifier.#statusProbe === null)
        {
            // Detached element — never inserted into the DOM. update()/isTerminal()
            // operate purely on the task tree (render() short-circuits when not
            // connected), so this is a safe, side-effect-free computation host.
            GenerationNotifier.#statusProbe = document.createElement("generation-progress-component");
        }
        return GenerationNotifier.#statusProbe;
    }

    static #finishTask(taskId, entry, outcome)
    {
        // Remove from tracking BEFORE notifying so a re-entrant poll cannot
        // double-fire for the same task.
        GenerationNotifier.#notifiedTaskIds.add(taskId);
        GenerationNotifier.stopTracking(taskId);

        // Auto-sync the freshly generated decks/cards/study-materials/mock-tests
        // down to the local model so they appear without a manual sync. This is
        // the single, central place that fires for EVERY generation (the notifier
        // tracks each run in the background from the moment it starts, regardless
        // of which page the user is on), so it runs exactly once and never double-
        // syncs. Fire-and-forget — independent of the OS notification below, and a
        // sync failure is non-fatal (the next routine sync still catches up). Only
        // a successful run produced new content worth pulling.
        if (outcome === generationOutcomes.SUCCESS)
        {
            TaskProgressTracker.triggerSync().catch((syncError) =>
                console.warn("[GenerationNotifier] Post-generation auto-sync failed:", syncError));
        }

        if (GenerationNotifier.#shouldSuppress(taskId))
        {
            return;
        }

        const { title, body } = GenerationNotifier.#buildMessage(entry.label, outcome);
        GenerationNotifier.#notify(taskId, title, body);
    }

    /**
     * Suppresses the OS notification only when the user is demonstrably already
     * watching this exact generation: its ProgressPage is the foreground page
     * AND the document is visible. Any other situation (different page, hidden
     * tab, minimised window) lets the notification through.
     */
    static #shouldSuppress(taskId)
    {
        const documentVisible = typeof document !== "undefined" && document.visibilityState === "visible";
        return documentVisible && GenerationNotifier.#foregroundTaskId === taskId;
    }

    static #buildMessage(label, outcome)
    {
        const safeLabel = (typeof label === "string" && label.length > 0) ? label : "Your generation";
        if (outcome === generationOutcomes.OUT_OF_CREDITS)
        {
            return {
                title: "Generation paused",
                body: `${safeLabel} ran out of credits. Top up to continue.`
            };
        }
        if (outcome === generationOutcomes.FAILURE)
        {
            return {
                title: "Generation failed",
                body: `${safeLabel} couldn't be completed. Open MindMeld to try again.`
            };
        }
        return {
            title: "Generation complete",
            body: `${safeLabel} is ready — your decks and study materials are waiting.`
        };
    }

    // ─────────────────────────────────────────────
    //  Notification channels
    // ─────────────────────────────────────────────

    static #notify(taskId, title, body)
    {
        if (GenerationNotifier.#isTauri())
        {
            GenerationNotifier.#notifyTauri(title, body);
            return;
        }
        GenerationNotifier.#notifyWeb(taskId, title, body);
    }

    static async #notifyTauri(title, body)
    {
        try
        {
            const grantedState = await GenerationNotifier.#tauriIsPermissionGranted();
            let granted = grantedState === true || grantedState === "granted";
            if (!granted)
            {
                const requested = await GenerationNotifier.#tauriRequestPermission();
                granted = requested === true || requested === "granted";
            }
            if (granted)
            {
                await GenerationNotifier.#tauriSendNotification(title, body);
            }
        }
        catch (tauriNotifyError)
        {
            // Plugin missing / permission backend unavailable — silently skip.
        }
    }

    static #notifyWeb(taskId, title, body)
    {
        if (!GenerationNotifier.#isWebNotificationSupported() || Notification.permission !== "granted")
        {
            return;
        }
        try
        {
            const notification = new Notification(title,
            {
                body,
                tag: `generation:${taskId}`
            });

            notification.onclick = () =>
            {
                try { window.focus(); } catch (focusError) { /* ignore */ }
                try { PageNavigator.open("progress-page", taskId); } catch (navigationError) { /* ignore */ }
                notification.close();
            };
        }
        catch (notificationError)
        {
            // Constructing a Notification can throw on some platforms (e.g.
            // Android requires a Service Worker) — silently skip.
        }
    }

    // ─────────────────────────────────────────────
    //  Persistence helpers
    // ─────────────────────────────────────────────

    static #now()
    {
        return new Date().getTime();
    }

    static #readPersisted()
    {
        try
        {
            const raw = window.localStorage.getItem(GenerationNotifier.STORAGE_KEY);
            if (!raw)
            {
                return {};
            }
            const parsed = JSON.parse(raw);
            return (parsed && typeof parsed === "object") ? parsed : {};
        }
        catch (storageError)
        {
            return {};
        }
    }

    static #persist()
    {
        try
        {
            const serialisable = {};
            for (const [taskId, entry] of GenerationNotifier.#trackedTasks.entries())
            {
                serialisable[taskId] = { label: entry.label, startedAt: entry.startedAt };
            }
            window.localStorage.setItem(GenerationNotifier.STORAGE_KEY, JSON.stringify(serialisable));
        }
        catch (storageError)
        {
            // Private mode / disabled storage — tracking just won't survive a
            // reload, which only costs the notification for an in-flight run.
        }
    }
}

// Resume tracking any in-flight generations as soon as the module loads, then
// again on login (the poll relies on the session cookie, which is only
// guaranteed available once authenticated).
GenerationNotifier.resume();
window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_IN, () => GenerationNotifier.resume());

export default GenerationNotifier;
