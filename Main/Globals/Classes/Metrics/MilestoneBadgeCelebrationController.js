import MetricBadgeHelper from "./MetricBadgeHelper.js";
import BadgeCelebrationDialog from "../../../CommonComponents/BadgeCelebrationDialog.js";

/**
 * Celebrates newly-earned milestone badges (cards / mock tests / hours /
 * doubts) exactly once, then acknowledges them on the server so they don't
 * replay across devices. Invoked after a metrics flush and after each user
 * refresh — analogous to the streak BadgeCelebrationController.
 */
class MilestoneBadgeCelebrationController
{
    static #isRunning = false;
    // "category:threshold" already celebrated this page session (backstop against
    // a stale in-flight payload re-showing before the server ack lands).
    static #celebratedKeys = new Set();

    static async evaluate(user)
    {
        if (MilestoneBadgeCelebrationController.#isRunning || !user)
        {
            return;
        }

        const metrics = MetricBadgeHelper.getMetrics(user);
        const pending = MetricBadgeHelper.getUnacknowledgedBadges(metrics)
            .filter((entry) => !MilestoneBadgeCelebrationController.#celebratedKeys.has(`${entry.category}:${entry.badge.threshold}`));

        if (pending.length === 0)
        {
            return;
        }

        MilestoneBadgeCelebrationController.#isRunning = true;
        for (const entry of pending)
        {
            MilestoneBadgeCelebrationController.#celebratedKeys.add(`${entry.category}:${entry.badge.threshold}`);
        }

        try
        {
            for (const { category, badge } of pending)
            {
                const counter = MetricBadgeHelper.getCounter(metrics, category);
                const nextBadge = MetricBadgeHelper.getNextBadge(category, counter);
                const nextHtml = nextBadge
                    ? `Next badge: <strong>${nextBadge.name}</strong>`
                    : `You've earned every badge here. 🎉`;

                await BadgeCelebrationDialog.present
                ({
                    name: badge.name,
                    imagePath: badge.imagePath,
                    sound: MetricBadgeHelper.getCelebrationSound(category, badge.threshold),
                    subtitleHtml: MetricBadgeHelper.formatThreshold(category, badge.threshold),
                    nextHtml: nextHtml
                });
            }

            await MilestoneBadgeCelebrationController.#acknowledge(user, pending);
        }
        catch (celebrationError)
        {
            console.warn("[MilestoneBadgeCelebrationController] Celebration failed:", celebrationError);
        }
        finally
        {
            MilestoneBadgeCelebrationController.#isRunning = false;
        }
    }

    static async #acknowledge(user, pending)
    {
        // Group thresholds by category.
        const thresholdsByCategory = {};
        for (const { category, badge } of pending)
        {
            (thresholdsByCategory[category] ??= []).push(badge.threshold);
        }

        // Optimistically mark the in-memory copy so a same-session re-evaluate
        // (before the next refresh) doesn't replay.
        const liveMetrics = user.getAdditionalData?.()?.metrics;
        for (const [category, thresholds] of Object.entries(thresholdsByCategory))
        {
            const earnedList = liveMetrics?.badges?.[category];
            if (Array.isArray(earnedList))
            {
                for (const earned of earnedList)
                {
                    if (thresholds.includes(earned.threshold))
                    {
                        earned.acknowledged = true;
                    }
                }
            }

            try
            {
                await fetch("/Metrics/AcknowledgeBadges",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "include",
                    body: JSON.stringify({ category: category, thresholds: thresholds })
                });
            }
            catch (acknowledgeError)
            {
                console.warn("[MilestoneBadgeCelebrationController] Acknowledge failed:", acknowledgeError);
            }
        }
    }
}

export default MilestoneBadgeCelebrationController;
