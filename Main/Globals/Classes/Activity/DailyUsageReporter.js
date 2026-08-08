/**
 * DailyUsageReporter — tells the server how much the learner studied today.
 *
 * WHY THE CLIENT HAS TO SAY. Two study actions are invisible to the server as
 * dated events: a card review survives only as one of the 20 most recent points
 * on its card, and a study-material view is a bare counter with no timestamp at
 * all. Both happen entirely in the browser. Without a report from here, an
 * organization's "usage over time" for those two features could only ever be a
 * lifetime total, and the report says so wherever it shows them.
 *
 * BATCHED, NOT PER ACTION. A learner rating cards moves through them in
 * seconds; one request per rating would put a network call in the middle of the
 * study loop for telemetry. Counts accumulate here and flush on a timer, on
 * page hide, and when the day rolls over mid-session.
 *
 * SILENT ON FAILURE, ALWAYS. Nothing here affects a balance, an entitlement or
 * what the learner sees. A failed flush must never interrupt studying, so every
 * path swallows its error and simply keeps the counts for the next attempt.
 * The one thing it must not do is lose counts by clearing them before the
 * server has them — so the pending counts are only cleared once a flush has
 * actually succeeded.
 */
class DailyUsageReporter
{
    static #ENDPOINT = "/Activity/RecordDailyUsage";

    /**
     * Long enough that a study session produces a handful of requests rather
     * than one per card, short enough that a browser killed without firing
     * pagehide loses at most this much.
     */
    static #FLUSH_INTERVAL_MILLISECONDS = 60 * 1000;

    static #pendingCounters = { cardsStudied: 0, studyMaterialsViewed: 0 };
    static #pendingDayUtc = "";
    static #flushTimerHandle = null;
    static #bFlushInFlight = false;
    static #bLifecycleBound = false;

    /**
     * One spaced-repetition card was rated.
     */
    static recordCardStudied()
    {
        DailyUsageReporter.#record("cardsStudied", 1);
    }

    /**
     * One study material was opened for reading.
     */
    static recordStudyMaterialViewed()
    {
        DailyUsageReporter.#record("studyMaterialsViewed", 1);
    }

    static #record(counterName, amount)
    {
        const todayDayUtc = DailyUsageReporter.#todayDayUtc();

        // A session open across midnight would otherwise file this morning's
        // reviews under yesterday. Flush the old day before starting the new
        // one, so neither day is attributed the other's work.
        if (DailyUsageReporter.#pendingDayUtc && DailyUsageReporter.#pendingDayUtc !== todayDayUtc)
        {
            DailyUsageReporter.flush();
        }

        DailyUsageReporter.#pendingDayUtc = todayDayUtc;
        DailyUsageReporter.#pendingCounters[counterName] += amount;

        DailyUsageReporter.#ensureScheduled();
    }

    static #ensureScheduled()
    {
        DailyUsageReporter.#bindLifecycleOnce();

        if (DailyUsageReporter.#flushTimerHandle !== null)
        {
            return;
        }

        DailyUsageReporter.#flushTimerHandle = setTimeout(() =>
        {
            DailyUsageReporter.#flushTimerHandle = null;
            DailyUsageReporter.flush();
        }, DailyUsageReporter.#FLUSH_INTERVAL_MILLISECONDS);
    }

    /**
     * Binds the page-hide flush exactly once.
     *
     * pagehide rather than beforeunload: it fires on mobile when the tab is
     * backgrounded, which is how a phone session usually ends, and beforeunload
     * frequently does not fire there at all.
     */
    static #bindLifecycleOnce()
    {
        if (DailyUsageReporter.#bLifecycleBound || typeof window === "undefined")
        {
            return;
        }

        DailyUsageReporter.#bLifecycleBound = true;

        window.addEventListener("pagehide", () => DailyUsageReporter.flush());
        document.addEventListener("visibilitychange", () =>
        {
            if (document.visibilityState === "hidden")
            {
                DailyUsageReporter.flush();
            }
        });
    }

    /**
     * Sends whatever has accumulated. Safe to call at any time.
     */
    static async flush()
    {
        if (DailyUsageReporter.#bFlushInFlight)
        {
            return;
        }

        const dayUtc = DailyUsageReporter.#pendingDayUtc;
        const counters = DailyUsageReporter.#pendingCounters;

        if (dayUtc.length === 0 || (counters.cardsStudied === 0 && counters.studyMaterialsViewed === 0))
        {
            return;
        }

        DailyUsageReporter.#bFlushInFlight = true;

        // Taken, not cleared. If the request fails these are put back, because
        // clearing first would silently drop a day's study on a flaky network —
        // and the whole point of this class is that the day is countable.
        const countersInFlight = { cardsStudied: counters.cardsStudied, studyMaterialsViewed: counters.studyMaterialsViewed };
        DailyUsageReporter.#pendingCounters = { cardsStudied: 0, studyMaterialsViewed: 0 };

        try
        {
            const response = await fetch(DailyUsageReporter.#ENDPOINT,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ dayUtc: dayUtc, counters: countersInFlight }),
            });

            if (!response.ok)
            {
                DailyUsageReporter.#restore(countersInFlight, dayUtc);
            }
        }
        catch (reportError)
        {
            DailyUsageReporter.#restore(countersInFlight, dayUtc);
        }
        finally
        {
            DailyUsageReporter.#bFlushInFlight = false;
        }
    }

    static #restore(countersInFlight, dayUtc)
    {
        DailyUsageReporter.#pendingCounters.cardsStudied += countersInFlight.cardsStudied;
        DailyUsageReporter.#pendingCounters.studyMaterialsViewed += countersInFlight.studyMaterialsViewed;

        // Only if nothing newer has claimed the slot — a restore must not drag
        // the pending day back to a day the learner has already moved past.
        if (DailyUsageReporter.#pendingDayUtc.length === 0)
        {
            DailyUsageReporter.#pendingDayUtc = dayUtc;
        }

        DailyUsageReporter.#ensureScheduled();
    }

    /**
     * UTC, matching how the server buckets days and how the in-app heatmap
     * already does — FSRS review timestamps carry no timezone normalisation, so
     * a local-time bucket would put one review on two different days for two
     * readers.
     */
    static #todayDayUtc()
    {
        return new Date().toISOString().slice(0, 10);
    }
}

export default DailyUsageReporter;
