import AuthenticationEvents from "../../Events/AuthenticationEvents.js";
import InitializationEvents from "../../Events/InitializationEvents.js";
import Deck from "../../Model/Deck.js";
import AutoAnalysisDeckFields from "./AutoAnalysisDeckFields.js";
import AnalysisTaskRunner from "./AnalysisTaskRunner.js";
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
        // popping the sign-in dialog would surprise a visitor who never asked
        // to run an analysis. A signed-out user simply skips auto-analysis;
        // they only see the gate dialog when they explicitly toggle a
        // checkbox or click Generate.
        if (!AiFeatureGate.isAllowed())
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

        // Post-analysis result lands on the deck via
        // AnalysisTaskRunner.triggerSync() (called inside queueAndTrack
        // on COMPLETED). The new curated batch — materials + flashcards
        // + lastCuratedBatchTag — appears on the next time the user
        // opens Curated Study from the deck. The legacy
        // CuratedStudyMaterialBatchReviewDialog flow that used to fire
        // here has been removed; LIVE → ARCHIVED / SUPERSEDED transitions
        // are owned by the agent (auto-supersede on untouched) and by
        // CuratedStudyController.archiveBatch (frontend session terminals).
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
