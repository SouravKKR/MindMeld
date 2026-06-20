import DailyStudyCounter from "./DailyStudyCounter.js";
import StreakBadgeHelper from "./StreakBadgeHelper.js";
import AuthenticationEvents from "../../Events/AuthenticationEvents.js";

/**
 * Reports today's spaced-repetition study count to the server so a pending
 * streak recovery can be satisfied. Only fires when a recovery is actually
 * pending for today (no needless calls otherwise). On a successful recovery it
 * refreshes the user, which re-runs the badge-celebration check — so the
 * restored streak and any newly-crossed badge (with its tier sound) surface.
 */
class StudyActivityReporter
{
    static async reportIfRecoveryPending()
    {
        const user = window["user"];
        if (!user)
        {
            return;
        }

        const streakState = StreakBadgeHelper.getStreakState(user);
        const pendingRecovery = streakState.pendingRecovery;
        if (!pendingRecovery || pendingRecovery.priorStreak <= 0 || pendingRecovery.recoveryDate !== StreakBadgeHelper.todayUtcDateString())
        {
            return;
        }

        const { count, utcDate } = DailyStudyCounter.countSpacedRepetitionCardsStudiedTodayUtc();

        try
        {
            const response = await fetch("/Streak/ReportStudyActivity",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ cardsStudiedToday: count, utcDate: utcDate })
            });

            if (!response.ok)
            {
                return;
            }

            const result = await response.json().catch(() => ({}));
            if (result && (result.recovered === true || result.changed === true))
            {
                await AuthenticationEvents.refreshUserFromServer();
            }
        }
        catch (reportError)
        {
            console.warn("[StudyActivityReporter] Failed to report study activity:", reportError);
        }
    }
}

export default StudyActivityReporter;
