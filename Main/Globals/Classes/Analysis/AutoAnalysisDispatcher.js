import AuthenticationEvents from "../../Events/AuthenticationEvents.js";
import InitializationEvents from "../../Events/InitializationEvents.js";
import Deck from "../../Model/Deck.js";
import AutoAnalysisDeckFields from "./AutoAnalysisDeckFields.js";
import CuratedStudyMaterialBatchReviewDialog from "../../../CommonComponents/CuratedStudyMaterialBatchReviewDialog.js";
import AiFeatureGate from "../AiFeatureGate.js";


/**
 * Lazy on-login dispatcher for the per-deck weekly auto-analysis.
 *
 * No cron, no polling. On each fresh login, walks the loaded deck tree
 * once, finds decks the user has opted into AND that have been studied
 * since their last analysis AND whose last analysis is more than seven
 * days old AND that carry the minimum number of progress points. Each
 * eligible deck gets one POST to /Analysis/QueueDeckAnalysis. The
 * server enqueues an Agent task — the client never blocks.
 *
 * The "Clear Analysis Data" button on DeckEditorPage wipes the
 * lastAnalyzedAt field, which is what lets a user force a re-analysis
 * outside the natural weekly cadence.
 */
class AutoAnalysisDispatcher
{
    static MIN_PROGRESS_POINTS_FOR_ELIGIBILITY     = 10;
    static WEEKLY_REANALYSIS_INTERVAL_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
    static QUEUE_DECK_ANALYSIS_ENDPOINT            = "/Analysis/QueueDeckAnalysis";

    static #bRegistered = false;
    static #bUserLoggedIn = false;
    static #bDecksLoaded = false;
    static #bDispatchedThisSession = false;

    /**
     * Self-registers at module load (via the bottom-of-file IIFE) so the
     * decision logic is wired up before any login or deck-load event
     * fires. Idempotent — subsequent calls are no-ops.
     */
    static register()
    {
        if (AutoAnalysisDispatcher.#bRegistered)
        {
            return;
        }
        AutoAnalysisDispatcher.#bRegistered = true;

        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_IN, (loginEvent) =>
        {
            const sessionState = loginEvent.detail?.sessionState || AuthenticationEvents.SESSION_STATE_FRESH;

            if (sessionState !== AuthenticationEvents.SESSION_STATE_FRESH)
            {
                return;
            }

            AutoAnalysisDispatcher.#bUserLoggedIn = true;
            AutoAnalysisDispatcher.#tryDispatch();
        });

        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_OUT, () =>
        {
            AutoAnalysisDispatcher.#bUserLoggedIn = false;
            AutoAnalysisDispatcher.#bDispatchedThisSession = false;
        });

        window.addEventListener(InitializationEvents.COMPLETE, () =>
        {
            AutoAnalysisDispatcher.#bDecksLoaded = true;
            AutoAnalysisDispatcher.#tryDispatch();
        });

        if (Deck.getRoot() !== null)
        {
            AutoAnalysisDispatcher.#bDecksLoaded = true;
        }

        if (typeof window["user"] !== "undefined" && window["user"] !== null)
        {
            AutoAnalysisDispatcher.#bUserLoggedIn = true;
        }

        if (AutoAnalysisDispatcher.#bUserLoggedIn && AutoAnalysisDispatcher.#bDecksLoaded)
        {
            AutoAnalysisDispatcher.#tryDispatch();
        }
    }

    static async #tryDispatch()
    {
        if (!AutoAnalysisDispatcher.#bUserLoggedIn || !AutoAnalysisDispatcher.#bDecksLoaded)
        {
            return;
        }

        // Silent gate — this fires automatically on every fresh login, so
        // popping the standard "AI restricted" dialog would surprise a
        // non-admin who never asked to run an analysis. They only see the
        // gate when they explicitly toggle a checkbox or click Generate.
        if (!AiFeatureGate.isAdmin())
        {
            return;
        }

        if (AutoAnalysisDispatcher.#bDispatchedThisSession)
        {
            return;
        }

        AutoAnalysisDispatcher.#bDispatchedThisSession = true;

        try
        {
            await AutoAnalysisDispatcher.#dispatchEligibleDecks();
        }
        catch (dispatchError)
        {
            console.warn("[AutoAnalysisDispatcher] Dispatch failed:", dispatchError);
        }
    }

    static async #dispatchEligibleDecks()
    {
        const rootDeck = Deck.getRoot();
        if (rootDeck === null)
        {
            return;
        }

        const eligibleDecks = AutoAnalysisDispatcher.#collectEligibleDecks(rootDeck);
        if (eligibleDecks.length > 0)
        {
            console.log(`[AutoAnalysisDispatcher] Queueing analysis for ${eligibleDecks.length} eligible deck(s).`);

            for (const eligibleDeck of eligibleDecks)
            {
                try
                {
                    await AutoAnalysisDispatcher.#queueDeckAnalysisRequest(eligibleDeck);
                }
                catch (requestError)
                {
                    console.warn(`[AutoAnalysisDispatcher] Failed to queue analysis for deck ${eligibleDeck.getId()}:`, requestError);
                }
            }
        }

        await AutoAnalysisDispatcher.#presentPendingBatchReviewsIfAny(rootDeck);
    }

    static async #presentPendingBatchReviewsIfAny(rootDeck)
    {
        const decksWithPendingBatch = [];

        const visit = (deck) =>
        {
            const additionalData = deck.getAdditionalData() || {};
            const pendingIds = additionalData[AutoAnalysisDeckFields.PENDING_BATCH_REVIEW_MATERIAL_IDS];

            if (Array.isArray(pendingIds) && pendingIds.length > 0)
            {
                decksWithPendingBatch.push(deck);
            }

            for (const subDeck of deck.getSubDecks())
            {
                visit(subDeck);
            }
        };

        visit(rootDeck);

        for (const deck of decksWithPendingBatch)
        {
            try
            {
                await AutoAnalysisDispatcher.#presentBatchReviewForDeck(deck);
            }
            catch (presentError)
            {
                console.warn(`[AutoAnalysisDispatcher] Failed to present batch review for deck ${deck.getId()}:`, presentError);
            }
        }
    }

    static async #presentBatchReviewForDeck(deck)
    {
        const additionalData = deck.getAdditionalData() || {};
        const pendingIds = additionalData[AutoAnalysisDeckFields.PENDING_BATCH_REVIEW_MATERIAL_IDS] || [];

        const allDeckStudyMaterials = deck.getStudyMaterials(true);
        const materialsById = new Map(allDeckStudyMaterials.map(material => [material.getId(), material]));

        const entries = [];
        const stalePendingIds = [];
        for (const pendingId of pendingIds)
        {
            const material = materialsById.get(pendingId);
            if (!material)
            {
                stalePendingIds.push(pendingId);
                continue;
            }

            entries.push({
                id:        pendingId,
                title:     `Previous curated material`,
                topicName: "",
                preview:   AutoAnalysisDispatcher.#extractPreview(material.getContent()),
            });
        }

        if (entries.length === 0)
        {
            if (stalePendingIds.length > 0)
            {
                deck.setAdditionalDataField(AutoAnalysisDeckFields.PENDING_BATCH_REVIEW_MATERIAL_IDS, []);
                await deck.save(false);
            }
            return;
        }

        const decisions = await CuratedStudyMaterialBatchReviewDialog.present(entries);
        if (decisions.size === 0)
        {
            return;
        }

        const archivedAction = CuratedStudyMaterialBatchReviewDialog.getArchiveAction();
        const keepAction     = CuratedStudyMaterialBatchReviewDialog.getKeepAction();
        const deleteAction   = CuratedStudyMaterialBatchReviewDialog.getDeleteAction();

        const archivedIdsInitial = Array.isArray(additionalData[AutoAnalysisDeckFields.ARCHIVED_CURATED_STUDY_MATERIAL_IDS])
            ? additionalData[AutoAnalysisDeckFields.ARCHIVED_CURATED_STUDY_MATERIAL_IDS]
            : [];
        const archivedIdsAfter = new Set(archivedIdsInitial);

        const remainingPendingIds = [];

        for (const [materialId, actionValue] of decisions.entries())
        {
            const material = materialsById.get(materialId);

            if (actionValue === deleteAction && material)
            {
                try
                {
                    await material.delete();
                    archivedIdsAfter.delete(materialId);
                }
                catch (deleteError)
                {
                    console.warn(`[AutoAnalysisDispatcher] Failed to delete material ${materialId}:`, deleteError);
                    remainingPendingIds.push(materialId);
                }
            }
            else if (actionValue === archivedAction)
            {
                archivedIdsAfter.add(materialId);
            }
            else if (actionValue === keepAction)
            {
                archivedIdsAfter.delete(materialId);
            }
        }

        deck.setAdditionalDataField(AutoAnalysisDeckFields.PENDING_BATCH_REVIEW_MATERIAL_IDS, remainingPendingIds);
        deck.setAdditionalDataField(AutoAnalysisDeckFields.ARCHIVED_CURATED_STUDY_MATERIAL_IDS, Array.from(archivedIdsAfter));
        await deck.save(false);
    }

    static #extractPreview(htmlContent)
    {
        if (typeof htmlContent !== "string")
        {
            return "";
        }
        const withoutTags = htmlContent.replace(/<[^>]+>/g, " ");
        return withoutTags.replace(/\s+/g, " ").trim().substring(0, 220);
    }

    static #collectEligibleDecks(rootDeck)
    {
        const eligibleDecks = [];

        const visit = (deck) =>
        {
            if (deck !== rootDeck && AutoAnalysisDispatcher.#isDeckEligible(deck))
            {
                eligibleDecks.push(deck);
            }

            const subDecks = deck.getSubDecks();
            for (const subDeck of subDecks)
            {
                visit(subDeck);
            }
        };

        visit(rootDeck);
        return eligibleDecks;
    }

    static #isDeckEligible(deck)
    {
        const additionalData = deck.getAdditionalData() || {};

        if (additionalData[AutoAnalysisDeckFields.AUTO_PERFORMANCE_ANALYSIS_ENABLED] !== true)
        {
            return false;
        }

        const progressPointSnapshots = AutoAnalysisDispatcher.#collectProgressPointTimestamps(deck);
        if (progressPointSnapshots.length < AutoAnalysisDispatcher.MIN_PROGRESS_POINTS_FOR_ELIGIBILITY)
        {
            return false;
        }

        const lastAnalyzedAtIso = additionalData[AutoAnalysisDeckFields.LAST_ANALYZED_AT];
        const lastAnalyzedAtMilliseconds = (typeof lastAnalyzedAtIso === "string" && lastAnalyzedAtIso.length > 0)
            ? Date.parse(lastAnalyzedAtIso)
            : null;

        const nowMilliseconds = Date.now();

        if (lastAnalyzedAtMilliseconds !== null && Number.isFinite(lastAnalyzedAtMilliseconds))
        {
            if (nowMilliseconds - lastAnalyzedAtMilliseconds < AutoAnalysisDispatcher.WEEKLY_REANALYSIS_INTERVAL_MILLISECONDS)
            {
                return false;
            }

            const studiedSinceLastAnalysis = progressPointSnapshots.some(progressTimestamp => progressTimestamp > lastAnalyzedAtMilliseconds);
            if (!studiedSinceLastAnalysis)
            {
                return false;
            }
        }

        return true;
    }

    static #collectProgressPointTimestamps(deck)
    {
        const timestamps = [];
        const cards = deck.getCards(true);

        for (const card of cards)
        {
            const progress = card.getProgress();
            if (!progress)
            {
                continue;
            }

            const progressPoints = progress.getProgressPoints();
            for (const progressPoint of progressPoints)
            {
                const fsrsState = (typeof progressPoint?.getFsrsState === "function") ? progressPoint.getFsrsState() : null;
                const lastReviewValue = fsrsState?.lastReview;

                let timestampMilliseconds = NaN;
                if (typeof lastReviewValue === "string")
                {
                    timestampMilliseconds = Date.parse(lastReviewValue);
                }
                else if (lastReviewValue instanceof Date)
                {
                    timestampMilliseconds = lastReviewValue.getTime();
                }
                else if (typeof lastReviewValue === "number")
                {
                    timestampMilliseconds = lastReviewValue;
                }

                if (Number.isFinite(timestampMilliseconds))
                {
                    timestamps.push(timestampMilliseconds);
                }
                else
                {
                    timestamps.push(0);
                }
            }
        }

        return timestamps;
    }

    static async #queueDeckAnalysisRequest(deck)
    {
        const additionalData = deck.getAdditionalData() || {};
        const autoGenerateCuratedStudy = additionalData[AutoAnalysisDeckFields.AUTO_GENERATE_CURATED_STUDY_ENABLED] === true;

        const requestBody = JSON.stringify
        ({
            deckId: deck.getId(),
            autoGenerateCuratedStudy: autoGenerateCuratedStudy,
        });

        const response = await fetch(AutoAnalysisDispatcher.QUEUE_DECK_ANALYSIS_ENDPOINT,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: requestBody,
        });

        if (!response.ok)
        {
            const responseText = await response.text().catch(() => "");
            throw new Error(`/Analysis/QueueDeckAnalysis returned ${response.status}: ${responseText}`);
        }
    }
}

AutoAnalysisDispatcher.register();

export default AutoAnalysisDispatcher;
