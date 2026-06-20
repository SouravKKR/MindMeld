import StreakBadges from '../../Constants/StreakBadges.js';

/**
 * Read-only helpers over the login-streak state that rides on the user record
 * (additionalData.streak) and the badge definitions seeded in
 * Common/Constants/StreakBadges.json (mirrored here as StreakBadges.BADGES).
 * Shared by the Settings section and the celebration dialog so the "next
 * badge" maths and image-fallback live in one place.
 */
class StreakBadgeHelper
{
    // Shown when a badge's image file has not been supplied yet (or fails to
    // load), so the feature is fully usable before any art is dropped in.
    static FALLBACK_BADGE_GLYPH = "🏅";

    static getBadgeDefinitions()
    {
        return Array.isArray(StreakBadges.BADGES) ? StreakBadges.BADGES : [];
    }

    /**
     * Normalises whatever streak object is on the user into a safe shape.
     * @param {object} user — the in-memory User (window["user"])
     */
    static getStreakState(user)
    {
        const raw = user?.getAdditionalData?.()?.streak;
        const current = Number.isFinite(raw?.current) ? Math.max(0, Math.floor(raw.current)) : 0;
        const longest = Number.isFinite(raw?.longest) ? Math.max(0, Math.floor(raw.longest)) : 0;
        const lastActiveDate = typeof raw?.lastActiveDate === "string" ? raw.lastActiveDate : null;
        const earnedBadges = Array.isArray(raw?.earnedBadges) ? raw.earnedBadges : [];

        let pendingRecovery = null;
        if (raw?.pendingRecovery && typeof raw.pendingRecovery === "object")
        {
            pendingRecovery =
            {
                priorStreak: Number.isFinite(raw.pendingRecovery.priorStreak) ? Math.max(0, Math.floor(raw.pendingRecovery.priorStreak)) : 0,
                missedDays: Number.isFinite(raw.pendingRecovery.missedDays) ? Math.max(0, Math.floor(raw.pendingRecovery.missedDays)) : 0,
                requiredCards: Number.isFinite(raw.pendingRecovery.requiredCards) ? Math.max(0, Math.floor(raw.pendingRecovery.requiredCards)) : 0,
                recoveryDate: typeof raw.pendingRecovery.recoveryDate === "string" ? raw.pendingRecovery.recoveryDate : null,
            };
        }

        return { current, longest, lastActiveDate, earnedBadges, pendingRecovery };
    }

    /** UTC calendar date string ("YYYY-MM-DD") for now — matches the server. */
    static todayUtcDateString()
    {
        return new Date().toISOString().slice(0, 10);
    }

    static getEarnedThresholds(streakState)
    {
        return new Set((streakState?.earnedBadges ?? []).map((badge) => badge.streak));
    }

    /**
     * The next badge the user has not yet reached, given a current streak.
     * @returns {object|null} the badge definition, or null when all are earned
     */
    static getNextBadge(currentStreak)
    {
        for (const definition of StreakBadgeHelper.getBadgeDefinitions())
        {
            if (definition.streak > currentStreak)
            {
                return definition;
            }
        }
        return null;
    }

    /**
     * Days remaining until the next badge, or null when all are earned.
     */
    static daysUntilNextBadge(currentStreak)
    {
        const next = StreakBadgeHelper.getNextBadge(currentStreak);
        return next ? Math.max(0, next.streak - currentStreak) : null;
    }

    static findDefinitionByStreak(streakThreshold)
    {
        return StreakBadgeHelper.getBadgeDefinitions().find((definition) => definition.streak === streakThreshold) || null;
    }

    /**
     * Badges that have been awarded but not yet celebrated, in award order.
     */
    static getUnacknowledgedBadges(streakState)
    {
        const awarded = streakState?.earnedBadges ?? [];
        return awarded
            .filter((badge) => badge.acknowledged !== true)
            .map((badge) => StreakBadgeHelper.findDefinitionByStreak(badge.streak))
            .filter(Boolean);
    }
}

export default StreakBadgeHelper;
