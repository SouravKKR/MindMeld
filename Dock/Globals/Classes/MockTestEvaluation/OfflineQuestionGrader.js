/**
 * Deterministic per-question scorer for option-based question types
 * (MULTIPLE_CHOICE, MULTIPLE_CORRECT). Mirrors the browser-side offline
 * grader in MockTestAttempt.evaluate so the two flows produce identical
 * scores for the same input. Mark normalization (parsing the user's
 * JSON-stringified index array) lives here so callers don't need to
 * understand the runner's answer encoding.
 */
class OfflineQuestionGrader
{
    static scoreOptionBased(typeKey, userAnswerRaw, expectedAnswerRaw, markingRule)
    {
        const userSelectedIndices = OfflineQuestionGrader.parseIndexSet(userAnswerRaw);
        const expectedIndices = OfflineQuestionGrader.parseIndexSet(expectedAnswerRaw);

        const correctMarks = Number.isFinite(markingRule.correctMarks) ? markingRule.correctMarks : 0;
        const wrongMarks = Number.isFinite(markingRule.wrongMarks) ? markingRule.wrongMarks : 0;
        const unattemptedMarks = Number.isFinite(markingRule.unattemptedMarks) ? markingRule.unattemptedMarks : 0;
        const partialMarks = Number.isFinite(markingRule.partialMarks) ? markingRule.partialMarks : 0;

        if (userSelectedIndices.size === 0)
        {
            return unattemptedMarks;
        }

        if (typeKey === "MULTIPLE_CHOICE")
        {
            const onlyExpected = userSelectedIndices.size === 1
                && expectedIndices.size === 1
                && OfflineQuestionGrader.firstOf(userSelectedIndices) === OfflineQuestionGrader.firstOf(expectedIndices);
            return onlyExpected ? correctMarks : wrongMarks;
        }

        const anyIncorrectSelected = [...userSelectedIndices].some((selectedIndex) => !expectedIndices.has(selectedIndex));
        const allCorrectSelected = [...expectedIndices].every((expectedIndex) => userSelectedIndices.has(expectedIndex));

        if (anyIncorrectSelected)
        {
            return wrongMarks;
        }

        if (allCorrectSelected)
        {
            return correctMarks;
        }

        if (partialMarks !== 0)
        {
            const correctSelectedCount = [...userSelectedIndices].filter((selectedIndex) => expectedIndices.has(selectedIndex)).length;
            return partialMarks * correctSelectedCount;
        }

        return wrongMarks;
    }

    static parseIndexSet(rawValue)
    {
        if (rawValue === null || rawValue === undefined)
        {
            return new Set();
        }

        const text = String(rawValue).trim();
        if (text.length === 0)
        {
            return new Set();
        }

        try
        {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed))
            {
                return new Set(parsed.map((entry) => parseInt(entry, 10)).filter((entry) => Number.isFinite(entry)));
            }
            if (Number.isFinite(parsed))
            {
                return new Set([parseInt(parsed, 10)]);
            }
        }
        catch (parseError)
        {
            // Fall through to the plain-number fallback below.
        }

        const numericValue = parseInt(text, 10);
        return Number.isFinite(numericValue) ? new Set([numericValue]) : new Set();
    }

    static firstOf(set)
    {
        for (const value of set)
        {
            return value;
        }
        return null;
    }
}

module.exports = OfflineQuestionGrader;
