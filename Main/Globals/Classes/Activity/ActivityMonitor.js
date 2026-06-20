/**
 * Global user-activity tracker. Records the last time the user interacted
 * (pointer / mouse / keyboard / scroll / wheel / touch — desktop & mobile) and
 * answers whether they are currently "active" (interacted within the idle
 * limit). Used to gate study-time accrual so an idle or backgrounded app does
 * not keep banking time. Self-registers once on import.
 */
class ActivityMonitor
{
    static #IDLE_LIMIT_MILLISECONDS = 5 * 60 * 1000;
    static #ACTIVITY_EVENTS = ["pointermove", "pointerdown", "mousemove", "keydown", "scroll", "wheel", "touchstart", "touchmove"];

    static #lastActivityAtMilliseconds = Date.now();
    static #isInitialised = false;

    static
    {
        ActivityMonitor.initialise();
    }

    static initialise()
    {
        if (ActivityMonitor.#isInitialised || typeof window === "undefined")
        {
            return;
        }
        ActivityMonitor.#isInitialised = true;

        const recordActivity = () =>
        {
            ActivityMonitor.#lastActivityAtMilliseconds = Date.now();
        };

        for (const eventName of ActivityMonitor.#ACTIVITY_EVENTS)
        {
            window.addEventListener(eventName, recordActivity, { passive: true, capture: true });
        }
    }

    /** True when the user has interacted within the idle limit (5 minutes). */
    static isActive()
    {
        return (Date.now() - ActivityMonitor.#lastActivityAtMilliseconds) < ActivityMonitor.#IDLE_LIMIT_MILLISECONDS;
    }
}

export default ActivityMonitor;
