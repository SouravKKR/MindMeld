import MetricBadges from '../../Constants/MetricBadges.js';

/**
 * Read-only helpers over the achievement metrics on the user
 * (additionalData.metrics) and the badge definitions seeded in
 * Common/Constants/MetricBadges.json (mirrored as MetricBadges). Shared by the
 * Settings rows, the gallery, and the milestone celebration controller.
 */
class MetricBadgeHelper
{
    static FALLBACK_BADGE_GLYPH = "🏅";

    // Victory jingles by escalating tier (level 1..5). Index 0 is VictoryLevel1.
    static #VICTORY_SOUNDS =
    [
        "./Globals/Assets/Sounds/Achievements/VictoryLevel1.mp3",
        "./Globals/Assets/Sounds/Achievements/VictoryLevel2.wav",
        "./Globals/Assets/Sounds/Achievements/VictoryLevel3.wav",
        "./Globals/Assets/Sounds/Achievements/VictoryLevel4.wav",
        "./Globals/Assets/Sounds/Achievements/VictoryLevel5.wav"
    ];

    /** Victory jingle escalating with the badge's rank within its category (top tier → VictoryLevel5). */
    static getCelebrationSound(category, threshold)
    {
        const badges = MetricBadgeHelper.getBadgeList(category);
        if (badges.length === 0)
        {
            return MetricBadgeHelper.#VICTORY_SOUNDS[0];
        }
        const index = badges.findIndex((badge) => badge.threshold === threshold);
        const rank = index < 0 ? 0 : index;
        const level = Math.min(5, Math.max(1, Math.ceil(((rank + 1) / badges.length) * 5)));
        return MetricBadgeHelper.#VICTORY_SOUNDS[level - 1];
    }

    static getCategories()
    {
        return Object.keys(MetricBadges);
    }

    static getCategoryDefinition(category)
    {
        return MetricBadges[category] || null;
    }

    static getMetrics(user)
    {
        const raw = user?.getAdditionalData?.()?.metrics;
        const safeCount = (value) => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);

        const metrics =
        {
            cardsStudied: safeCount(raw?.cardsStudied),
            mockTestsTaken: safeCount(raw?.mockTestsTaken),
            minutesStudied: safeCount(raw?.minutesStudied),
            doubtsAsked: safeCount(raw?.doubtsAsked),
            leaderboardScore: safeCount(raw?.leaderboardScore),
            badges: {},
        };

        for (const category of MetricBadgeHelper.getCategories())
        {
            metrics.badges[category] = Array.isArray(raw?.badges?.[category]) ? raw.badges[category] : [];
        }
        return metrics;
    }

    static getCounter(metrics, category)
    {
        const definition = MetricBadges[category];
        return definition ? (metrics[definition.metricKey] || 0) : 0;
    }

    static getBadgeList(category)
    {
        return MetricBadges[category] ? MetricBadges[category].badges : [];
    }

    static getEarnedThresholds(metrics, category)
    {
        return new Set((metrics.badges?.[category] ?? []).map((badge) => badge.threshold));
    }

    static findBadge(category, threshold)
    {
        return MetricBadgeHelper.getBadgeList(category).find((badge) => badge.threshold === threshold) || null;
    }

    static getNextBadge(category, counter)
    {
        for (const badge of MetricBadgeHelper.getBadgeList(category))
        {
            if (badge.threshold > counter)
            {
                return badge;
            }
        }
        return null;
    }

    /** Human display of a counter (hours category converts minutes → hours). */
    static formatCount(metrics, category)
    {
        const definition = MetricBadges[category];
        const counter = MetricBadgeHelper.getCounter(metrics, category);
        if (definition && definition.displayUnit === "hours")
        {
            const hours = Math.round((counter / 60) * 10) / 10;
            return `${hours} hours`;
        }
        return `${counter} ${definition ? definition.unit : ""}`;
    }

    /** Human display of a single badge threshold (hours category → hours). */
    static formatThreshold(category, threshold)
    {
        const definition = MetricBadges[category];
        if (definition && definition.displayUnit === "hours")
        {
            const hours = Math.round((threshold / 60) * 10) / 10;
            return `${hours} hours`;
        }
        return `${threshold} ${definition ? definition.unit : ""}`;
    }

    /** Unacknowledged earned badges across all categories: [{ category, badge }]. */
    static getUnacknowledgedBadges(metrics)
    {
        const result = [];
        for (const category of MetricBadgeHelper.getCategories())
        {
            for (const earned of (metrics.badges?.[category] ?? []))
            {
                if (earned.acknowledged !== true)
                {
                    const definition = MetricBadgeHelper.findBadge(category, earned.threshold);
                    if (definition)
                    {
                        result.push({ category: category, badge: definition });
                    }
                }
            }
        }
        return result;
    }
}

export default MetricBadgeHelper;
