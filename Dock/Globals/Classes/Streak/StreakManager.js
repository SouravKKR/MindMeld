const StreakBadges = require("../../Constants/StreakBadges");
const AuthenticationQueryEngine = require("../Database/AuthenticationQueryEngine");

// Owns the login-based daily streak and the badges earned from it. The streak
// state lives in users.additionalData.streak and is mutated ONLY here (the
// generic /UpdateUserAdditionalData merge refuses the `streak` key so a client
// cannot award itself badges). A "day" is the server's UTC calendar date.
//
// Streak keeping is login-based (advanced on /GetUser). Recovering a BROKEN
// streak is study-gated: if the user returns within the grace window, they must
// study a quota of spaced-repetition cards (20 per missed day) on the comeback
// day to restore the prior streak — reported through /Streak/ReportStudyActivity.

class StreakManager
{
    // additionalData keys owned exclusively by the streak subsystem.
    static STREAK_OWNED_ADDITIONAL_DATA_KEYS = ["streak"];

    // A broken streak is recoverable only when the user returns within this many
    // missed days; beyond it, the streak resets permanently. Each missed day
    // costs this many spaced-repetition cards on the comeback day to reclaim.
    static MAXIMUM_RECOVERABLE_MISSED_DAYS = 3;
    static REQUIRED_CARDS_PER_MISSED_DAY = 20;

    static isStreakOwnedAdditionalDataKey(fieldKey)
    {
        return StreakManager.STREAK_OWNED_ADDITIONAL_DATA_KEYS.includes(fieldKey);
    }

    static #utcDateString(date)
    {
        return date.toISOString().slice(0, 10);
    }

    // Whole-day difference between two "YYYY-MM-DD" UTC date strings.
    static #dayDifference(laterDateString, earlierDateString)
    {
        const laterMilliseconds = Date.parse(`${laterDateString}T00:00:00Z`);
        const earlierMilliseconds = Date.parse(`${earlierDateString}T00:00:00Z`);
        return Math.round((laterMilliseconds - earlierMilliseconds) / (24 * 60 * 60 * 1000));
    }

    static #defaultStreakState()
    {
        return { current: 0, longest: 0, lastActiveDate: null, earnedBadges: [], pendingRecovery: null };
    }

    // Normalises whatever is on the user record into a well-formed state object
    // so corrupt or partial data never throws downstream.
    static #normalise(rawStreak)
    {
        if (!rawStreak || typeof rawStreak !== "object")
        {
            return StreakManager.#defaultStreakState();
        }

        const current = Number.isFinite(rawStreak.current) ? Math.max(0, Math.floor(rawStreak.current)) : 0;
        const longest = Number.isFinite(rawStreak.longest) ? Math.max(0, Math.floor(rawStreak.longest)) : 0;
        const lastActiveDate = typeof rawStreak.lastActiveDate === "string" ? rawStreak.lastActiveDate : null;
        const earnedBadges = Array.isArray(rawStreak.earnedBadges) ? rawStreak.earnedBadges : [];

        let pendingRecovery = null;
        const rawPending = rawStreak.pendingRecovery;
        if (rawPending && typeof rawPending === "object")
        {
            pendingRecovery =
            {
                priorStreak: Number.isFinite(rawPending.priorStreak) ? Math.max(0, Math.floor(rawPending.priorStreak)) : 0,
                missedDays: Number.isFinite(rawPending.missedDays) ? Math.max(0, Math.floor(rawPending.missedDays)) : 0,
                requiredCards: Number.isFinite(rawPending.requiredCards) ? Math.max(0, Math.floor(rawPending.requiredCards)) : 0,
                recoveryDate: typeof rawPending.recoveryDate === "string" ? rawPending.recoveryDate : null,
            };
        }

        return { current, longest, lastActiveDate, earnedBadges, pendingRecovery };
    }

    // Awards every badge whose threshold the current streak has reached and that
    // is not already earned. Mutates state.earnedBadges; returns the new awards.
    static #awardBadgesInPlace(state, now)
    {
        const alreadyEarnedThresholds = new Set(state.earnedBadges.map((badge) => badge.streak));

        const newlyAwarded = [];
        for (const definition of StreakBadges.BADGES)
        {
            if (definition.streak <= state.current && !alreadyEarnedThresholds.has(definition.streak))
            {
                state.earnedBadges.push({ streak: definition.streak, awardedAt: now.toISOString(), acknowledged: false });
                newlyAwarded.push(definition);
            }
        }
        return newlyAwarded;
    }

    // Advances the streak for "the user is active today", in place. Idempotent
    // per UTC day (so it is safe to call from both the GetUser and study-report
    // paths in any order). Returns { changed, newlyAwarded }.
    static #advanceDayInPlace(state, now)
    {
        const today = StreakManager.#utcDateString(now);
        let changed = false;

        // A pending recovery only applies to its own comeback day. Once that day
        // has passed (unsatisfied), drop it so the provisional reset stands.
        if (state.pendingRecovery && state.pendingRecovery.recoveryDate !== today)
        {
            state.pendingRecovery = null;
            changed = true;
        }

        if (state.lastActiveDate === today)
        {
            return { changed, newlyAwarded: [] };
        }

        if (!state.lastActiveDate || state.current === 0)
        {
            // First ever active day (or a fully reset streak).
            state.current = 1;
            state.pendingRecovery = null;
        }
        else
        {
            const gap = StreakManager.#dayDifference(today, state.lastActiveDate);

            if (gap <= 0)
            {
                // Anomalous (clock skew / future lastActiveDate) — do not regress.
                return { changed, newlyAwarded: [] };
            }

            if (gap === 1)
            {
                // Consecutive day — normal login increment.
                state.current = state.current + 1;
                state.pendingRecovery = null;
            }
            else
            {
                const missedDays = gap - 1;
                if (missedDays <= StreakManager.MAXIMUM_RECOVERABLE_MISSED_DAYS)
                {
                    // Recoverable lapse: provisionally restart at 1 today, but
                    // remember the prior streak so studying enough cards today
                    // can restore it (see applyStudyActivity).
                    state.pendingRecovery =
                    {
                        priorStreak: state.current,
                        missedDays: missedDays,
                        requiredCards: StreakManager.REQUIRED_CARDS_PER_MISSED_DAY * missedDays,
                        recoveryDate: today,
                    };
                    state.current = 1;
                }
                else
                {
                    // Gap too large — permanent reset.
                    state.current = 1;
                    state.pendingRecovery = null;
                }
            }
        }

        state.lastActiveDate = today;
        state.longest = Math.max(state.longest, state.current);
        const newlyAwarded = StreakManager.#awardBadgesInPlace(state, now);
        return { changed: true, newlyAwarded };
    }

    /**
     * Records that the user opened the app today and advances the login streak.
     * Called from /GetUser on every app bootstrap. Persists only when changed.
     *
     * @param {string} userId
     * @returns {Promise<{changed: boolean, newlyAwarded: Array, streak: object}>}
     */
    static async recordDailyActivity(userId)
    {
        if (!userId)
        {
            return { changed: false, newlyAwarded: [], streak: StreakManager.#defaultStreakState() };
        }

        const user = await AuthenticationQueryEngine.getUserById(userId);
        if (!user)
        {
            return { changed: false, newlyAwarded: [], streak: StreakManager.#defaultStreakState() };
        }

        const streak = StreakManager.#normalise(user.getAdditionalData()?.streak);
        const advanceResult = StreakManager.#advanceDayInPlace(streak, new Date());

        if (advanceResult.changed)
        {
            await AuthenticationQueryEngine.updateUserAdditionalData(userId, { streak });
        }

        return { changed: advanceResult.changed, newlyAwarded: advanceResult.newlyAwarded, streak };
    }

    /**
     * Applies a comeback-day study count toward a pending streak recovery.
     * Advances the day first (so it works even if GetUser hasn't run yet), then,
     * if a recovery is pending for today and the quota is met, restores the prior
     * streak and continues it (priorStreak + 1, today counts).
     *
     * @param {string} userId
     * @param {number} cardsStudiedToday — spaced-repetition attempts today (client UTC)
     * @param {string} clientUtcDate — the UTC date ("YYYY-MM-DD") the count is for
     * @returns {Promise<{changed: boolean, recovered: boolean, newlyAwarded: Array, streak: object}>}
     */
    static async applyStudyActivity(userId, cardsStudiedToday, clientUtcDate)
    {
        if (!userId)
        {
            return { changed: false, recovered: false, newlyAwarded: [], streak: StreakManager.#defaultStreakState() };
        }

        const user = await AuthenticationQueryEngine.getUserById(userId);
        if (!user)
        {
            return { changed: false, recovered: false, newlyAwarded: [], streak: StreakManager.#defaultStreakState() };
        }

        const streak = StreakManager.#normalise(user.getAdditionalData()?.streak);
        const now = new Date();
        const today = StreakManager.#utcDateString(now);

        const advanceResult = StreakManager.#advanceDayInPlace(streak, now);
        let changed = advanceResult.changed;
        let newlyAwarded = advanceResult.newlyAwarded;
        let recovered = false;

        const studiedCount = Number.isFinite(cardsStudiedToday) ? Math.floor(cardsStudiedToday) : 0;

        if (clientUtcDate === today
            && streak.pendingRecovery
            && streak.pendingRecovery.recoveryDate === today
            && studiedCount >= streak.pendingRecovery.requiredCards)
        {
            // Resume at the old value and count today (old + 1).
            streak.current = streak.pendingRecovery.priorStreak + 1;
            streak.longest = Math.max(streak.longest, streak.current);
            streak.pendingRecovery = null;
            newlyAwarded = newlyAwarded.concat(StreakManager.#awardBadgesInPlace(streak, now));
            recovered = true;
            changed = true;
        }

        if (changed)
        {
            await AuthenticationQueryEngine.updateUserAdditionalData(userId, { streak });
        }

        return { changed, recovered, newlyAwarded, streak };
    }

    /**
     * Marks the given badge thresholds as acknowledged so their celebration is
     * shown exactly once (and stays consistent across the user's devices).
     *
     * @param {string} userId
     * @param {number[]} streaks — the badge `streak` thresholds to acknowledge
     * @returns {Promise<object|null>} the updated streak state, or null
     */
    static async acknowledgeBadges(userId, streaks)
    {
        if (!userId || !Array.isArray(streaks) || streaks.length === 0)
        {
            return null;
        }

        const user = await AuthenticationQueryEngine.getUserById(userId);
        if (!user)
        {
            return null;
        }

        const streak = StreakManager.#normalise(user.getAdditionalData()?.streak);
        const toAcknowledge = new Set(streaks.map((value) => Math.floor(value)));

        let changed = false;
        for (const badge of streak.earnedBadges)
        {
            if (toAcknowledge.has(badge.streak) && badge.acknowledged !== true)
            {
                badge.acknowledged = true;
                changed = true;
            }
        }

        if (!changed)
        {
            return streak;
        }

        await AuthenticationQueryEngine.updateUserAdditionalData(userId, { streak });
        return streak;
    }

    /**
     * Admin/testing tool: set a user's streak to explicit values. Recomputes the
     * earned badges to match `current`. When `celebrateOnNextLaunch` is true the
     * single highest earned badge is left unacknowledged so exactly one
     * celebration (with its tier sound) fires on that user's next launch.
     *
     * @param {string} userId
     * @param {{current?: number, longest?: number, lastActiveDate?: string, celebrateOnNextLaunch?: boolean}} options
     * @returns {Promise<object|null>} the updated streak state, or null if no such user
     */
    static async adminSetStreak(userId, options = {})
    {
        if (!userId)
        {
            return null;
        }

        const user = await AuthenticationQueryEngine.getUserById(userId);
        if (!user)
        {
            return null;
        }

        const now = new Date();
        const newCurrent = Number.isFinite(options.current) ? Math.max(0, Math.floor(options.current)) : 0;
        const newLongest = Math.max(Number.isFinite(options.longest) ? Math.floor(options.longest) : 0, newCurrent);

        // Default to today; accept a supplied date only if it is a well-formed
        // YYYY-MM-DD that is not in the future (a future date would make the next
        // #advanceDayInPlace see a negative gap and freeze the streak).
        const todayString = StreakManager.#utcDateString(now);
        let lastActiveDate = todayString;
        if (typeof options.lastActiveDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(options.lastActiveDate))
        {
            lastActiveDate = options.lastActiveDate <= todayString ? options.lastActiveDate : todayString;
        }

        const earnedBadges = [];
        for (const definition of StreakBadges.BADGES)
        {
            if (definition.streak <= newCurrent)
            {
                earnedBadges.push({ streak: definition.streak, awardedAt: now.toISOString(), acknowledged: true });
            }
        }

        if (options.celebrateOnNextLaunch === true && earnedBadges.length > 0)
        {
            // BADGES is threshold-ascending, so the last entry is the highest.
            earnedBadges[earnedBadges.length - 1].acknowledged = false;
        }

        const streak =
        {
            current: newCurrent,
            longest: newLongest,
            lastActiveDate: lastActiveDate,
            earnedBadges: earnedBadges,
            pendingRecovery: null,
        };

        await AuthenticationQueryEngine.updateUserAdditionalData(userId, { streak });
        return streak;
    }

    /**
     * Admin/testing tool: fully clear a user's streak and badge history.
     *
     * @param {string} userId
     * @returns {Promise<object|null>} the cleared streak state, or null
     */
    static async adminResetStreak(userId)
    {
        if (!userId)
        {
            return null;
        }

        const user = await AuthenticationQueryEngine.getUserById(userId);
        if (!user)
        {
            return null;
        }

        const streak = StreakManager.#defaultStreakState();
        await AuthenticationQueryEngine.updateUserAdditionalData(userId, { streak });
        return streak;
    }
}

module.exports = StreakManager;
