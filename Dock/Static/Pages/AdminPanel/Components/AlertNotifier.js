import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import AiFeatureGate from "../../../Globals/Classes/AiFeatureGate.js";

/**
 * AlertNotifier
 *
 * Foreground browser-notification bridge for the operational alert log. For
 * admin users it polls /Admin/Alerts/List for newly-raised (or re-occurred)
 * alerts while the app is open and raises a desktop Notification for each.
 *
 * Permission is opt-in: the Alerts tab exposes an "Enable browser
 * notifications" button that calls requestPermission(). The poller runs
 * regardless (it's cheap) but only fires Notifications once permission is
 * "granted"; it degrades to a silent no-op when the API is unsupported or
 * permission is denied.
 *
 * De-duplication: a stored "last seen" timestamp is the cursor — the poll
 * asks the backend for rows whose lastSeenAt is strictly newer, so a reload
 * never re-notifies the existing backlog. A re-occurring (deduped) alert gets
 * a fresh lastSeenAt and is therefore surfaced again, which is intended.
 */
class AlertNotifier
{
    static #LIST_ENDPOINT = "/Admin/Alerts/List";
    static #LAST_SEEN_KEY = "alertNotifier.lastSeenAt";
    static #POLL_INTERVAL_MILLISECONDS = 60 * 1000;

    static #intervalHandle = null;
    static #notifiedKeys = new Set();

    static isSupported()
    {
        return typeof window !== "undefined" && "Notification" in window;
    }

    static getPermission()
    {
        return AlertNotifier.isSupported() ? Notification.permission : "unsupported";
    }

    /**
     * Prompts for notification permission. Returns the resulting permission
     * string ("granted" / "denied" / "default" / "unsupported").
     */
    static async requestPermission()
    {
        if (!AlertNotifier.isSupported())
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

    /**
     * Starts the poll loop for admin users. Idempotent. Establishes the
     * "last seen" cursor at the current time on first ever run so only
     * alerts raised from now on can notify.
     */
    static start()
    {
        if (AlertNotifier.#intervalHandle !== null)
        {
            return;
        }
        if (!AlertNotifier.isSupported() || !AiFeatureGate.isAdmin())
        {
            return;
        }

        if (!AlertNotifier.#getLastSeen())
        {
            AlertNotifier.#setLastSeen(new Date().toISOString());
        }

        AlertNotifier.#intervalHandle = setInterval(AlertNotifier.#poll, AlertNotifier.#POLL_INTERVAL_MILLISECONDS);
        AlertNotifier.#poll();
    }

    static stop()
    {
        if (AlertNotifier.#intervalHandle === null)
        {
            return;
        }
        clearInterval(AlertNotifier.#intervalHandle);
        AlertNotifier.#intervalHandle = null;
    }

    static #getLastSeen()
    {
        try
        {
            return window.localStorage.getItem(AlertNotifier.#LAST_SEEN_KEY) || "";
        }
        catch (storageError)
        {
            return "";
        }
    }

    static #setLastSeen(isoString)
    {
        try
        {
            window.localStorage.setItem(AlertNotifier.#LAST_SEEN_KEY, isoString);
        }
        catch (storageError)
        {
            // Private mode / disabled storage — cursor just won't persist
            // across reloads, which only risks re-notifying once.
        }
    }

    static async #poll()
    {
        try
        {
            const since = AlertNotifier.#getLastSeen();
            const url = `${AlertNotifier.#LIST_ENDPOINT}?onlyUnacknowledged=true${since ? `&since=${encodeURIComponent(since)}` : ""}`;
            const response = await fetch(url);
            if (!response.ok)
            {
                return;
            }
            const payload = await response.json();
            const alerts = Array.isArray(payload?.alerts) ? payload.alerts : [];
            if (alerts.length === 0)
            {
                return;
            }

            // Backend returns newest-first; advance the cursor to the newest
            // lastSeenAt so the next poll only sees genuinely newer activity.
            let newestSeen = since;
            for (const alert of alerts)
            {
                if (alert.lastSeenAt && alert.lastSeenAt > newestSeen)
                {
                    newestSeen = alert.lastSeenAt;
                }
            }

            if (Notification.permission === "granted")
            {
                // Notify oldest-first so the most recent ends up on top.
                for (const alert of [...alerts].reverse())
                {
                    AlertNotifier.#notify(alert);
                }
            }

            if (newestSeen && newestSeen !== since)
            {
                AlertNotifier.#setLastSeen(newestSeen);
            }
        }
        catch (pollError)
        {
            // Network blip / not-admin-anymore — try again next tick.
        }
    }

    static #notify(alert)
    {
        const deduplicationKey = `${alert.id}:${alert.lastSeenAt}`;
        if (AlertNotifier.#notifiedKeys.has(deduplicationKey))
        {
            return;
        }
        AlertNotifier.#notifiedKeys.add(deduplicationKey);

        const occurrenceSuffix = alert.occurrenceCount > 1 ? ` (x${alert.occurrenceCount})` : "";
        const title = `${alert.source || "Alert"}: ${alert.title || "Alert"}${occurrenceSuffix}`;

        try
        {
            const notification = new Notification(title,
            {
                body: alert.message || "",
                tag: alert.id
            });

            notification.onclick = () =>
            {
                try { window.focus(); } catch (focusError) { /* ignore */ }
                try { PageNavigator.open("admin-panel-page"); } catch (navigationError) { /* ignore */ }
                notification.close();
            };
        }
        catch (notificationError)
        {
            // Constructing a Notification can throw on some platforms (e.g.
            // Android requires a Service Worker) — silently skip.
        }
    }
}

export default AlertNotifier;
