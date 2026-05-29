import AuthenticationEvents from "../../Events/AuthenticationEvents.js";
import InitializationEvents from "../../Events/InitializationEvents.js";
import Deck from "../../Model/Deck.js";
import AutoAnalysisDeckFields from "./AutoAnalysisDeckFields.js";
import CuratedStudyMaterialFields from "./CuratedStudyMaterialFields.js";
import AnalysisTaskRunner from "./AnalysisTaskRunner.js";
import CuratedStudyMaterialBatchReviewDialog from "../../../CommonComponents/CuratedStudyMaterialBatchReviewDialog.js";
import AiFeatureGate from "../AiFeatureGate.js";
import { curatedBatchReviewStates } from "../../Enumerations/CuratedBatchReviewStates.js";


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

            // Kick all eligible decks in parallel via AnalysisTaskRunner.
            // Each call polls its task through /Generate/Progress to
            // terminal. Per-deck syncing is suppressed (bTriggerSync:
            // false) so we only pay one sync round-trip at the end —
            // the analysis results for every deck arrive in one pull
            // and a single re-render is enough.
            const dispatchOutcomes = await Promise.allSettled(eligibleDecks.map((eligibleDeck) =>
            {
                return AnalysisTaskRunner.queueAndTrack(eligibleDeck, { bTriggerSync: false }).catch((trackError) =>
                {
                    console.warn(`[AutoAnalysisDispatcher] Tracking analysis for deck ${eligibleDeck.getId()} failed:`, trackError);
                    throw trackError;
                });
            }));

            const completedCount = dispatchOutcomes.filter(outcome => outcome.status === "fulfilled").length;
            if (completedCount > 0)
            {
                try
                {
                    await AnalysisTaskRunner.triggerSync();
                }
                catch (syncError)
                {
                    console.warn("[AutoAnalysisDispatcher] Post-analysis sync failed:", syncError);
                }
            }
        }

        await AutoAnalysisDispatcher.#presentPendingBatchReviewsIfAny(rootDeck);
    }

    static async #presentPendingBatchReviewsIfAny(rootDeck)
    {
        const decksWithPendingMaterials = [];

        const visit = (deck) =>
        {
            const pendingMaterials = AutoAnalysisDispatcher.#collectPendingReviewMaterials(deck);
            if (pendingMaterials.length > 0)
            {
                decksWithPendingMaterials.push({ deck: deck, materials: pendingMaterials });
            }

            for (const subDeck of deck.getSubDecks())
            {
                visit(subDeck);
            }
        };

        visit(rootDeck);

        for (const pendingDeckEntry of decksWithPendingMaterials)
        {
            try
            {
                await AutoAnalysisDispatcher.#presentBatchReviewForDeck(pendingDeckEntry.deck, pendingDeckEntry.materials);
            }
            catch (presentError)
            {
                console.warn(`[AutoAnalysisDispatcher] Failed to present batch review for deck ${pendingDeckEntry.deck.getId()}:`, presentError);
            }
        }
    }

    /**
     * Returns every curated StudyMaterial directly owned by this deck
     * whose batch-review state is PENDING_REVIEW. Sub-decks are walked
     * separately by the caller's recursion — each deck owns its own
     * pending list so the modal can be staged per deck.
     */
    static #collectPendingReviewMaterials(deck)
    {
        const directMaterials = deck.getStudyMaterials(false);
        const pendingState = curatedBatchReviewStates.PENDING_REVIEW;
        const pendingStateName = Object.keys(curatedBatchReviewStates).find(stateName => curatedBatchReviewStates[stateName] === pendingState);

        return directMaterials.filter((material) =>
        {
            if (!material.isCurated())
            {
                return false;
            }
            const reviewState = material.getAdditionalData()[CuratedStudyMaterialFields.BATCH_REVIEW_STATE];
            return reviewState === pendingStateName;
        });
    }

    static async #presentBatchReviewForDeck(deck, pendingMaterials)
    {
        const entries = pendingMaterials.map((material) =>
        {
            const materialAdditionalData = material.getAdditionalData();
            const topicName = materialAdditionalData[CuratedStudyMaterialFields.TOPIC_NAME] || "";

            return {
                id:        material.getId(),
                title:     topicName ? `Previously curated: ${topicName}` : "Previous curated material",
                topicName: topicName,
                preview:   AutoAnalysisDispatcher.#extractPreview(material.getContent()),
            };
        });

        if (entries.length === 0)
        {
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

        const archivedStateName = AutoAnalysisDispatcher.#stateName(curatedBatchReviewStates.ARCHIVED);
        const liveStateName     = AutoAnalysisDispatcher.#stateName(curatedBatchReviewStates.LIVE);

        const materialsById = new Map(pendingMaterials.map(material => [material.getId(), material]));

        for (const [materialId, actionValue] of decisions.entries())
        {
            const material = materialsById.get(materialId);
            if (!material)
            {
                continue;
            }

            try
            {
                if (actionValue === deleteAction)
                {
                    await material.delete();
                }
                else if (actionValue === archivedAction)
                {
                    material.setAdditionalDataField(CuratedStudyMaterialFields.BATCH_REVIEW_STATE, archivedStateName);
                    await material.save();
                }
                else if (actionValue === keepAction)
                {
                    material.setAdditionalDataField(CuratedStudyMaterialFields.BATCH_REVIEW_STATE, liveStateName);
                    await material.save();
                }
            }
            catch (applyError)
            {
                console.warn(`[AutoAnalysisDispatcher] Failed to apply batch-review decision ${actionValue} on material ${materialId}:`, applyError);
            }
        }
    }

    /**
     * Returns the name string for a numeric curatedBatchReviewStates
     * value. The persisted format is the enum name (e.g. "LIVE") rather
     * than the integer, mirroring how TopicStrength is stored.
     */
    static #stateName(stateValue)
    {
        return Object.keys(curatedBatchReviewStates).find(stateName => curatedBatchReviewStates[stateName] === stateValue);
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
}

AutoAnalysisDispatcher.register();

export default AutoAnalysisDispatcher;
