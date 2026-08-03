import { aiGeneratedExportBlockReasons } from "../../Enumerations/AiGeneratedExportBlockReasons.js";

/**
 * AiGeneratedExportReporter
 *
 * Reports an attempted export that involved AI-generated deck content to the
 * server, so the platform has a record of when the export gate was exercised
 * and whether it held.
 *
 * The gate itself lives in the client (DeckOptionsContextMenu hides the button
 * for a generated node; the export dialog refuses a recursive export whose
 * subtree contains generated content; Deck.getExportData throws as a last
 * resort). Export never touches the server — the deck is already in the user's
 * own store — so there is nothing to enforce there. This reporter is the only
 * reason a bypass would ever be visible: an unmodified client always announces
 * the attempt, so a sustained gap between attempts and blocks, or a run of
 * `bBlocked: false`, is the signal that the gate is being edited out.
 *
 * Deliberately fire-and-forget: telemetry must never delay or fail a user action,
 * and an offline client simply produces no record rather than an error.
 */
class AiGeneratedExportReporter
{
    static ENDPOINT_PATH = "/Security/AiGeneratedExportAttempt";

    /**
     * Records one attempted export of AI-generated content.
     *
     * @param {object} attemptDetails
     * @param {string|null} attemptDetails.deckId The deck the export was requested on.
     * @param {boolean} attemptDetails.bRecursiveRequested Whether the whole subtree was requested.
     * @param {boolean} attemptDetails.bBlocked Whether the client gate actually refused.
     * @param {number} attemptDetails.reason An aiGeneratedExportBlockReasons value.
     */
    static report(attemptDetails)
    {
        const reasonName = AiGeneratedExportReporter.#resolveReasonName(attemptDetails.reason);

        fetch(AiGeneratedExportReporter.ENDPOINT_PATH,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify
            ({
                deckId: attemptDetails.deckId ?? null,
                recursiveRequested: attemptDetails.bRecursiveRequested === true,
                blocked: attemptDetails.bBlocked === true,
                reason: reasonName,
                userAgent: navigator.userAgent
            })
        }).catch((reportError) =>
        {
            console.warn("[AiGeneratedExportReporter] Telemetry POST failed:", reportError);
        });
    }

    /**
     * Turns the numeric enum value into its stable name, so the stored record
     * stays readable if the numeric values are ever renumbered. Returns null for
     * an unrecognised value rather than inventing one.
     */
    static #resolveReasonName(reasonValue)
    {
        for (const [reasonName, enumeratedValue] of Object.entries(aiGeneratedExportBlockReasons))
        {
            if (enumeratedValue === reasonValue)
            {
                return reasonName;
            }
        }
        return null;
    }
}

export default AiGeneratedExportReporter;
