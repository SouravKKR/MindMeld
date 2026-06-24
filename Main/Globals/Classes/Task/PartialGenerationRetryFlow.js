import DialogBox from "../../../CommonComponents/DialogBox.js";
import PageNavigator from "../PageNavigator.js";
import CreditNotice from "../Credits/CreditNotice.js";

/**
 * PartialGenerationRetryFlow
 *
 * Drives the "one output type failed but the others were kept" recovery
 * experience for an AI generation:
 *   - describeKept(): the human sentence shown on the progress banner / deck
 *     badge dialog ("50 flashcards were created before generation stopped …").
 *   - presentForDeck(): deck-tile badge entry point — confirm, then retry.
 *   - retry(): re-submits ONLY the failed output types (the stored retryBody),
 *     merging into the existing partial deck, and opens the progress page for
 *     the new run.
 *
 * The backend writes the partialCompletion marker (counts + failed scopes +
 * retryBody) onto both the generation task payload (surfaced by
 * /Generate/Progress) and the top-level decks' additionalData (synced); this
 * class only consumes it. See Dock Generate.js / MoveToDatabase.js.
 */
class PartialGenerationRetryFlow
{
    static #PROGRESS_PAGE_TAG = "progress-page";

    static #SCOPE_LABELS =
    {
        flashcardGeneration: "flashcards",
        studyMaterialGeneration: "study material",
        mockTestGeneration: "mock tests",
    };

    /**
     * Builds the "what was kept — retry the rest?" sentence from a
     * partialCompletion marker.
     * @param {object} partialCompletion
     * @returns {string}
     */
    static describeKept(partialCompletion)
    {
        const keptParts = [];

        const flashcardCount = Number(partialCompletion?.createdFlashcardCount) || 0;
        const studyMaterialCount = Number(partialCompletion?.createdStudyMaterialCount) || 0;

        if (flashcardCount > 0)
        {
            keptParts.push(`${flashcardCount} flashcard${flashcardCount === 1 ? "" : "s"}`);
        }
        if (studyMaterialCount > 0)
        {
            keptParts.push(`${studyMaterialCount} study lesson${studyMaterialCount === 1 ? "" : "s"}`);
        }
        if (partialCompletion?.createdMockTests)
        {
            keptParts.push("mock tests");
        }

        const keptText = keptParts.length > 0 ? keptParts.join(" and ") : "Some content";
        const wasOrWere = keptParts.length === 1 ? "was" : "were";
        const themOrIt = keptParts.length > 0 ? "them" : "it";
        const failedText = PartialGenerationRetryFlow.#describeScopes(partialCompletion?.failedScopes || []);

        return `${keptText} ${wasOrWere} created before generation stopped. We've kept ${themOrIt} — keep them and retry the rest${failedText ? ` (${failedText})` : ""}?`;
    }

    static #describeScopes(scopeKeys)
    {
        const labels = (Array.isArray(scopeKeys) ? scopeKeys : [])
            .map(scopeKey => PartialGenerationRetryFlow.#SCOPE_LABELS[scopeKey])
            .filter(Boolean);

        if (labels.length === 0)
        {
            return "";
        }
        if (labels.length === 1)
        {
            return labels[0];
        }
        return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
    }

    /**
     * Deck-tile badge entry point: confirm with the user, then retry.
     * @param {object} deck
     */
    static async presentForDeck(deck)
    {
        const additionalData = deck?.getAdditionalData?.() || {};
        const partialCompletion = additionalData.partialCompletion;

        if (!partialCompletion)
        {
            return;
        }

        const bConfirmed = await DialogBox.confirm("Generation incomplete", PartialGenerationRetryFlow.describeKept(partialCompletion));
        if (!bConfirmed)
        {
            return;
        }

        await PartialGenerationRetryFlow.retry(partialCompletion);
    }

    /**
     * Re-submits only the failed output types and opens the progress page for
     * the new run. Returns true when the retry request was accepted.
     * @param {object} partialCompletion
     * @returns {Promise<boolean>}
     */
    static async retry(partialCompletion)
    {
        const retryBody = partialCompletion?.retryBody;
        if (!retryBody || typeof retryBody !== "object")
        {
            await DialogBox.alert("Nothing to retry", "We couldn't find the details needed to continue this generation.");
            return false;
        }

        let response;
        try
        {
            response = await fetch("/Generate",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(retryBody),
            });
        }
        catch (retryError)
        {
            await DialogBox.alert("Retry failed", "We couldn't restart your generation. Please try again in a moment.");
            return false;
        }

        if (response.status === 402)
        {
            const insufficientDetail = await response.json().catch(() => ({}));
            await CreditNotice.showInsufficientCredits(insufficientDetail);
            return false;
        }

        if (!response.ok)
        {
            await DialogBox.alert("Retry failed", "We couldn't restart your generation. Please try again in a moment.");
            return false;
        }

        const responseBody = await response.json().catch(() => ({}));
        const newTaskId = responseBody && typeof responseBody.taskId === "string" ? responseBody.taskId : null;

        if (!newTaskId)
        {
            await DialogBox.alert("Generation restarted", "Your generation is running again. You can track it from the Activity page.");
            return true;
        }

        PageNavigator.open(PartialGenerationRetryFlow.#PROGRESS_PAGE_TAG, newTaskId);
        return true;
    }
}

export default PartialGenerationRetryFlow;
