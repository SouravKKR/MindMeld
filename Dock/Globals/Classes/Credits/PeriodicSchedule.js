const { periodicScheduleTypes } = require("../../Enumerations/PeriodicScheduleTypes");

/**
 * PeriodicSchedule
 *
 * Pure, side-effect-free date logic for periodic credit assignments. All math
 * is done in UTC so the schedule never drifts with the server's local timezone
 * or DST. A "period" is one installment window; each period has:
 *
 *   - periodKey      a stable string that, combined with the assignment id and
 *                    the recipient email, forms the grant's idempotency
 *                    referenceKey. The key MUST be deterministic for a given
 *                    (assignment, calendar boundary) so a replay maps to the
 *                    same ledger row.
 *   - periodStartAt  the Date at which that installment becomes due. The
 *                    reconciler grants a period iff its periodStartAt falls
 *                    inside the recipient's eligibility window.
 *
 * The three schedule types:
 *   INTERVAL_DAYS  every N days, anchored at the assignment's startAt.
 *   DAY_OF_WEEK    every occurrence of a weekday (0 = Sunday … 6 = Saturday).
 *   DAY_OF_MONTH   a calendar day each month (31 clamps to the month's last
 *                  day, so February still pays once).
 */
class PeriodicSchedule
{
    static #DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

    // Safety backstop for a pathologically dormant assignment. Any periods
    // beyond this in a single reconcile are simply granted on the next call
    // (the cursor advances), so accumulation still completes — this only
    // bounds the work done per request.
    static MAXIMUM_PERIODS_PER_RECONCILE = 400;

    static #startOfUtcDay(date)
    {
        return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    }

    static #ymd(date)
    {
        return date.toISOString().slice(0, 10);
    }

    static #daysInUtcMonth(year, monthIndex)
    {
        return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    }

    static #clampDayOfMonth(year, monthIndex, dayOfMonth)
    {
        return Math.min(dayOfMonth, PeriodicSchedule.#daysInUtcMonth(year, monthIndex));
    }

    static #intervalDays(assignment)
    {
        const value = assignment.getIntervalDays();
        return Number.isInteger(value) && value > 0 ? value : 1;
    }

    /**
     * Every period whose periodStartAt falls within [windowStart, windowEnd],
     * inclusive, in chronological order. Returns [] when the window is empty.
     * @param {PeriodicCreditAssignment} assignment
     * @param {Date} windowStart
     * @param {Date} windowEnd
     * @returns {Array<{ periodKey: string, periodStartAt: Date }>}
     */
    static enumeratePeriods(assignment, windowStart, windowEnd)
    {
        if (!(windowStart instanceof Date) || !(windowEnd instanceof Date) || windowStart.getTime() > windowEnd.getTime())
        {
            return [];
        }

        const scheduleType = assignment.getScheduleType();
        const periods = [];
        const cap = PeriodicSchedule.MAXIMUM_PERIODS_PER_RECONCILE;

        if (scheduleType === periodicScheduleTypes.INTERVAL_DAYS)
        {
            const anchor = PeriodicSchedule.#startOfUtcDay(assignment.getStartAt());
            const stepMilliseconds = PeriodicSchedule.#intervalDays(assignment) * PeriodicSchedule.#DAY_MILLISECONDS;

            let firstIndex = Math.ceil((windowStart.getTime() - anchor.getTime()) / stepMilliseconds);
            if (firstIndex < 0)
            {
                firstIndex = 0;
            }
            const lastIndex = Math.floor((windowEnd.getTime() - anchor.getTime()) / stepMilliseconds);

            for (let periodIndex = firstIndex; periodIndex <= lastIndex && periods.length < cap; periodIndex++)
            {
                const periodStartAt = new Date(anchor.getTime() + periodIndex * stepMilliseconds);
                periods.push({ periodKey: `i${periodIndex}`, periodStartAt: periodStartAt });
            }
            return periods;
        }

        if (scheduleType === periodicScheduleTypes.DAY_OF_WEEK)
        {
            const startOfDay = PeriodicSchedule.#startOfUtcDay(windowStart);
            const forwardDelta = (assignment.getDayOfWeek() - startOfDay.getUTCDay() + 7) % 7;
            let occurrence = new Date(startOfDay.getTime() + forwardDelta * PeriodicSchedule.#DAY_MILLISECONDS);

            // The first matching weekday's midnight may still precede
            // windowStart's time-of-day; advance a week if so.
            while (occurrence.getTime() < windowStart.getTime())
            {
                occurrence = new Date(occurrence.getTime() + 7 * PeriodicSchedule.#DAY_MILLISECONDS);
            }

            while (occurrence.getTime() <= windowEnd.getTime() && periods.length < cap)
            {
                periods.push({ periodKey: `w${PeriodicSchedule.#ymd(occurrence)}`, periodStartAt: occurrence });
                occurrence = new Date(occurrence.getTime() + 7 * PeriodicSchedule.#DAY_MILLISECONDS);
            }
            return periods;
        }

        // DAY_OF_MONTH — walk month by month from windowStart's month.
        let year = windowStart.getUTCFullYear();
        let monthIndex = windowStart.getUTCMonth();
        let monthsWalked = 0;
        const maximumMonths = cap; // far more than any realistic window

        while (monthsWalked < maximumMonths && periods.length < cap)
        {
            const targetDay = PeriodicSchedule.#clampDayOfMonth(year, monthIndex, assignment.getDayOfMonth());
            const periodStartAt = new Date(Date.UTC(year, monthIndex, targetDay));

            if (periodStartAt.getTime() > windowEnd.getTime())
            {
                break;
            }
            if (periodStartAt.getTime() >= windowStart.getTime())
            {
                periods.push({ periodKey: `m${year}-${monthIndex}`, periodStartAt: periodStartAt });
            }

            monthIndex += 1;
            if (monthIndex > 11)
            {
                monthIndex = 0;
                year += 1;
            }
            monthsWalked += 1;
        }
        return periods;
    }
}

module.exports = PeriodicSchedule;
