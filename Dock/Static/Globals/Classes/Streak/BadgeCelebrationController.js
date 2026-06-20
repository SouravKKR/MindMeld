import StreakBadgeHelper from "./StreakBadgeHelper.js";
import BadgeCelebrationDialog from "../../../CommonComponents/BadgeCelebrationDialog.js";
import BadgeEvents from "../../Events/BadgeEvents.js";

/**
 * Drives the badge-celebration sequence. After the user record is refreshed
 * from the server (bootstrap, periodic recheck, or an explicit refresh), this
 * looks for badges that were awarded server-side but not yet celebrated
 * (acknowledged === false), shows the celebration for each in turn, then tells
 * the server to acknowledge them so they never celebrate twice — including
 * across devices.
 */
class BadgeCelebrationController
{
    // Guards against overlapping sequences if two refreshes resolve close
    // together (e.g. bootstrap + a Settings refresh).
    static #isRunning = false;

    // Badge thresholds already celebrated this page session. The server-side
    // acknowledgement is the durable, cross-device guard; this is a same-session
    // backstop so a second /GetUser response that was already in flight before
    // the acknowledgement persisted (still carrying acknowledged:false) cannot
    // replay a celebration. Thresholds are permanent, so this never wrongly
    // suppresses a future, distinct badge.
    static #celebratedThresholds = new Set();

    /**
     * @param {object} user — the freshly-loaded in-memory User (window["user"])
     */
    static async evaluate(user)
    {
        if (BadgeCelebrationController.#isRunning || !user)
        {
            return;
        }

        const streakState = StreakBadgeHelper.getStreakState(user);
        const pendingBadges = StreakBadgeHelper.getUnacknowledgedBadges(streakState)
            .filter((badge) => !BadgeCelebrationController.#celebratedThresholds.has(badge.streak));

        if (pendingBadges.length === 0)
        {
            return;
        }

        BadgeCelebrationController.#isRunning = true;
        for (const badge of pendingBadges)
        {
            BadgeCelebrationController.#celebratedThresholds.add(badge.streak);
        }

        try
        {
            window.dispatchEvent(new CustomEvent(BadgeEvents.STREAK_UPDATED, {
                detail: { current: streakState.current, longest: streakState.longest }
            }));

            for (const badge of pendingBadges)
            {
                await BadgeCelebrationDialog.show(badge, streakState.current);
                window.dispatchEvent(new CustomEvent(BadgeEvents.ACHIEVED, {
                    detail: { badge, currentStreak: streakState.current }
                }));
            }

            await BadgeCelebrationController.#acknowledge(user, pendingBadges.map((badge) => badge.streak));
        }
        catch (celebrationError)
        {
            console.warn("[BadgeCelebrationController] Celebration failed:", celebrationError);
        }
        finally
        {
            BadgeCelebrationController.#isRunning = false;
        }
    }

    static async #acknowledge(user, streaks)
    {
        // Optimistically mark the in-memory copy so a same-session re-evaluate
        // (before the next server refresh) doesn't replay the celebration.
        const additionalData = user.getAdditionalData?.();
        if (additionalData?.streak?.earnedBadges)
        {
            for (const badge of additionalData.streak.earnedBadges)
            {
                if (streaks.includes(badge.streak))
                {
                    badge.acknowledged = true;
                }
            }
        }

        try
        {
            await fetch("/Streak/AcknowledgeBadges", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ streaks })
            });
        }
        catch (acknowledgeError)
        {
            // Non-fatal: the optimistic local flag prevents a same-session
            // replay; the server will simply re-send them on the next load,
            // which is a benign re-celebration rather than data loss.
            console.warn("[BadgeCelebrationController] Acknowledge request failed:", acknowledgeError);
        }
    }
}

export default BadgeCelebrationController;
