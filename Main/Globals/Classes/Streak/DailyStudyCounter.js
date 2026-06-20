import Deck from "../../Model/Deck.js";

/**
 * Counts how many distinct cards the user has studied (spaced repetition) on the
 * current UTC day, across their whole library. A card counts once no matter how
 * many times it was reviewed today, so "20 cards" means 20 distinct cards.
 * Mirrors the source of truth used by StudyActivityHeatmap: every attempt appends
 * a progress point whose `fsrs.lastReview` timestamp is set by Card.attempt (only
 * SpacedRepetition sessions touch this history — mock tests / content reads do
 * not), so filtering to "spaced repetition only" is automatic.
 *
 * Used to satisfy the comeback-day study quota that restores a broken streak.
 */
class DailyStudyCounter
{
    static #MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
    static #ROOT_DECK_ID = "0";

    static #truncateToUtcDay(milliseconds)
    {
        return Math.floor(milliseconds / DailyStudyCounter.#MILLISECONDS_PER_DAY) * DailyStudyCounter.#MILLISECONDS_PER_DAY;
    }

    static #reviewMilliseconds(lastReviewValue)
    {
        if (lastReviewValue instanceof Date)
        {
            return lastReviewValue.getTime();
        }
        if (typeof lastReviewValue === "string")
        {
            return Date.parse(lastReviewValue);
        }
        if (typeof lastReviewValue === "number")
        {
            return lastReviewValue;
        }
        return NaN;
    }

    static #wasStudiedToday(progress, todayDayUtcMilliseconds)
    {
        for (const progressPoint of progress.getProgressPoints())
        {
            const fsrsState = (typeof progressPoint?.getFsrsState === "function") ? progressPoint.getFsrsState() : null;
            const reviewMilliseconds = DailyStudyCounter.#reviewMilliseconds(fsrsState ? fsrsState.lastReview : null);

            if (Number.isFinite(reviewMilliseconds) && reviewMilliseconds > 0
                && DailyStudyCounter.#truncateToUtcDay(reviewMilliseconds) === todayDayUtcMilliseconds)
            {
                return true;
            }
        }
        return false;
    }

    /**
     * @returns {{ count: number, utcDate: string }} distinct cards studied today
     *          (UTC) and the UTC date string the count is for (matches the
     *          server's day boundary).
     */
    static countSpacedRepetitionCardsStudiedTodayUtc()
    {
        const todayDayUtcMilliseconds = DailyStudyCounter.#truncateToUtcDay(Date.now());
        const utcDate = new Date(todayDayUtcMilliseconds).toISOString().slice(0, 10);

        const rootDeck = Deck.getById(DailyStudyCounter.#ROOT_DECK_ID);
        if (!rootDeck)
        {
            return { count: 0, utcDate };
        }

        let count = 0;
        for (const card of rootDeck.getCards(true, true))
        {
            const progress = card.getProgress();
            if (progress && DailyStudyCounter.#wasStudiedToday(progress, todayDayUtcMilliseconds))
            {
                count++;
            }
        }

        return { count, utcDate };
    }
}

export default DailyStudyCounter;
