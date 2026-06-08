import AnalysisTaskRunner from "../Analysis/AnalysisTaskRunner.js";
import AutoAnalysisDeckFields from "../Analysis/AutoAnalysisDeckFields.js";
import CuratedFlashcardFields from "../Analysis/CuratedFlashcardFields.js";
import CuratedStudyMaterialFields from "../Analysis/CuratedStudyMaterialFields.js";
import SyncEvents from "../../Events/SyncEvents.js";
import { curatedBatchReviewStates } from "../../Enumerations/CuratedBatchReviewStates.js";
import { curatedFlashcardGrade } from "../../Enumerations/CuratedFlashcardGrade.js";
import { curatedSessionOutcomes } from "../../Enumerations/CuratedSessionOutcomes.js";
import { entityTypes } from "../../Enumerations/EntityTypes.js";


/**
 * Stateless controller for the curated-study workflow. Owns every
 * read / write the entry dialog, session, and archive view perform on
 * curated materials, cards, and the deck's curated-batch bookkeeping.
 *
 * Why static-only: there is no per-instance state worth keeping. Every
 * method takes a Deck (or a batch object derived from one) and reads
 * the truth from there + the underlying StudyMaterial / Card models.
 * Keeping everything stateless lets the session class call onResumed()
 * and re-read the entire batch shape after a sync arrival without
 * worrying about stale controller state.
 *
 * Concepts:
 *   - **Batch** — every curated material spawned by one analysis run
 *     shares a `generatedForAnalysisAt` ISO timestamp. That string is
 *     the canonical batch tag throughout the codebase. The deck's
 *     `lastCuratedBatchTag` field names the currently-LIVE batch.
 *   - **Topic** — one material + its accompanying flashcards share a
 *     `topicIndex` (0-based) inside the batch. The session walks
 *     topics in topicIndex order; the archive displays them the same
 *     way.
 *   - **Flow phases** — material → flashcards → next topic. The
 *     all-easy-vs-mixed branch fires only after every topic in the
 *     batch is fully graded.
 */
class CuratedStudyController
{
    // FSRS userRating used when applying the grade-back review on
    // source cards. 1.0 is "Easy" on the 0..1 scale the standard
    // Easy button passes through (`<button class="easy-button" score="1">`
    // in StudyPage's template). The user finished the curated batch
    // with every flashcard marked Easy — Easy is the correct mirror.
    static SOURCE_CARD_GRADE_BACK_RATING = 1.0;
    // Estimated time-spent the FSRS review function uses for its
    // time-on-card term. The user didn't actually attempt each source
    // card individually; ~30 s is a reasonable proxy for "engaged with
    // the topic" averaged across the curated material + flashcards.
    static SOURCE_CARD_GRADE_BACK_TIME_SECONDS = 30;

    /**
     * Returns the deck's currently-LIVE curated batch as a structured
     * object, or null if no LIVE batch exists. The skippedDueToInProgress
     * timestamp travels with the batch info so the entry dialog can show
     * its banner without re-reading deck additionalData.
     */
    static getLiveBatchInfo(deck)
    {
        if (!deck)
        {
            return null;
        }

        const additionalData = deck.getAdditionalData() || {};
        const batchTag = additionalData[AutoAnalysisDeckFields.LAST_CURATED_BATCH_TAG];
        if (typeof batchTag !== "string" || batchTag.length === 0)
        {
            return null;
        }

        const liveMaterials = deck.getCuratedStudyMaterials(batchTag).filter((material) =>
        {
            return material.getAdditionalData()?.[CuratedStudyMaterialFields.BATCH_REVIEW_STATE] === CuratedStudyController.#stateName(curatedBatchReviewStates.LIVE);
        });

        if (liveMaterials.length === 0)
        {
            // The deck thinks it has a LIVE batch but no materials carry
            // the LIVE flag — orphaned tag. The caller should run
            // repairOrphanedLiveBatches before retrying.
            return null;
        }

        const liveCards = deck.getCuratedCards(batchTag);
        const topicGroups = CuratedStudyController.#groupByTopic(liveMaterials, liveCards);

        const recordedTopics = additionalData[AutoAnalysisDeckFields.LAST_CURATED_BATCH_TOPICS];
        const topicSummary = Array.isArray(recordedTopics) ? recordedTopics : topicGroups.map((group) =>
        {
            return { name: group.topicName, strength: group.topicStrength };
        });

        return {
            tag: batchTag,
            topics: topicSummary,
            topicGroups: topicGroups,
            materials: liveMaterials,
            cards: liveCards,
            skippedDueToInProgressAt: additionalData[AutoAnalysisDeckFields.LAST_SKIPPED_DUE_TO_IN_PROGRESS_AT] || null,
        };
    }

    /**
     * Returns every archived (or superseded) batch the deck has ever
     * produced, sorted descending by generatedAt. The currently-LIVE
     * batch tag (if any) is filtered out — even if some of its
     * materials have been partial-archived by a Continue branch, the
     * batch as a whole is still in progress and belongs to the LIVE
     * surface, not the archive.
     */
    static getArchivedBatches(deck)
    {
        if (!deck)
        {
            return [];
        }

        const liveStateName = CuratedStudyController.#stateName(curatedBatchReviewStates.LIVE);
        const liveBatchTag = deck.getAdditionalData()?.[AutoAnalysisDeckFields.LAST_CURATED_BATCH_TAG] || null;
        const allCuratedMaterials = deck.getCuratedStudyMaterials();
        const allCuratedCards = deck.getCuratedCards();

        // Partition by batch tag. Two filters apply:
        //   - skip materials still flagged LIVE (those belong to the
        //     current session, not the archive)
        //   - skip materials whose tag matches the deck's LIVE-batch
        //     tag (partial archives from a Continue branch still belong
        //     to the in-progress LIVE batch — they shouldn't appear as
        //     their own "past batch" entry while the LIVE batch is
        //     active)
        const batchTagToMaterials = new Map();
        for (const material of allCuratedMaterials)
        {
            const additionalData = material.getAdditionalData() || {};
            const batchReviewState = additionalData[CuratedStudyMaterialFields.BATCH_REVIEW_STATE];
            if (batchReviewState === liveStateName)
            {
                continue;
            }
            const batchTag = additionalData[CuratedStudyMaterialFields.GENERATED_FOR_ANALYSIS_AT];
            if (typeof batchTag !== "string" || batchTag.length === 0)
            {
                continue;
            }
            if (liveBatchTag !== null && batchTag === liveBatchTag)
            {
                continue;
            }
            if (!batchTagToMaterials.has(batchTag))
            {
                batchTagToMaterials.set(batchTag, []);
            }
            batchTagToMaterials.get(batchTag).push(material);
        }

        const batchTagToCards = new Map();
        for (const card of allCuratedCards)
        {
            const batchTag = card.getAdditionalData()?.[CuratedFlashcardFields.GENERATED_FOR_ANALYSIS_AT];
            if (typeof batchTag !== "string" || !batchTagToMaterials.has(batchTag))
            {
                continue;
            }
            if (!batchTagToCards.has(batchTag))
            {
                batchTagToCards.set(batchTag, []);
            }
            batchTagToCards.get(batchTag).push(card);
        }

        const archivedBatches = [];
        for (const [batchTag, materials] of batchTagToMaterials.entries())
        {
            const cards = batchTagToCards.get(batchTag) || [];
            const topicGroups = CuratedStudyController.#groupByTopic(materials, cards);
            const batchOutcome = CuratedStudyController.#pickBatchOutcome(materials);
            const batchReviewState = CuratedStudyController.#pickBatchReviewState(materials);

            archivedBatches.push({
                tag: batchTag,
                generatedAt: batchTag,
                outcome: batchOutcome,
                batchReviewState: batchReviewState,
                topics: topicGroups.map((group) => ({ name: group.topicName, strength: group.topicStrength })),
                topicGroups: topicGroups,
                materials: materials,
                cards: cards,
            });
        }

        archivedBatches.sort((firstBatch, secondBatch) =>
        {
            return CuratedStudyController.#parseBatchTagToTimestamp(secondBatch.tag) - CuratedStudyController.#parseBatchTagToTimestamp(firstBatch.tag);
        });

        return archivedBatches;
    }

    /**
     * Marks a single curated material as read. Idempotent — reading an
     * already-READ material just bumps lifecycle.lastModified so the
     * sync layer notices nothing changed.
     */
    static async markMaterialRead(material)
    {
        if (!material || !material.isCurated())
        {
            return;
        }

        const nowIso = new Date().toISOString();
        material.setAdditionalDataField(CuratedStudyMaterialFields.READ_STATE, "READ");
        material.setAdditionalDataField(CuratedStudyMaterialFields.READ_AT, nowIso);
        await material.save();
    }

    /**
     * Grades a curated flashcard with one of the two-choice values
     * ("EASY" or "HARD"). Stamps lastCuratedGradedAt so a multi-device
     * sync race tiebreaks on the latest write.
     */
    static async gradeCard(card, grade)
    {
        if (!card || card.getAdditionalData()?.[CuratedFlashcardFields.B_CURATED] !== true)
        {
            return;
        }

        const normalisedGrade = (grade === CuratedStudyController.#gradeName(curatedFlashcardGrade.EASY))
            ? CuratedStudyController.#gradeName(curatedFlashcardGrade.EASY)
            : CuratedStudyController.#gradeName(curatedFlashcardGrade.HARD);

        card.setAdditionalDataField(CuratedFlashcardFields.LAST_CURATED_GRADE, normalisedGrade);
        card.setAdditionalDataField(CuratedFlashcardFields.LAST_CURATED_GRADED_AT, new Date().toISOString());
        await card.save();
    }

    /**
     * Archives every material in the given LIVE batch and stamps each
     * with the supplied session outcome. Clears the deck's LIVE-batch
     * tag + topic summary so getLiveBatchInfo returns null afterwards.
     * Use this for the all-easy congratulations path, the End-session
     * path, and the manual Regenerate confirm path (frontend side —
     * the agent handles archival for auto-supersede).
     *
     * Mutations are batched: every material's additionalData is
     * updated in memory first, then ONE deck.save() persists the lot
     * in a single IndexedDB write, then we fire one ENTITY_CHANGED
     * event per material so the sync layer's pending-changes set tags
     * each material for the next push. Avoids the N-square pattern of
     * material.save() (which internally re-serialises and writes the
     * entire deck per material).
     */
    static async archiveBatch(deck, batchTag, outcome)
    {
        if (!deck || typeof batchTag !== "string" || !batchTag)
        {
            return;
        }

        const liveStateName = CuratedStudyController.#stateName(curatedBatchReviewStates.LIVE);
        const archivedStateName = CuratedStudyController.#stateName(curatedBatchReviewStates.ARCHIVED);
        const outcomeName = CuratedStudyController.#outcomeName(outcome);

        const mutatedMaterials = [];
        const materialsInBatch = deck.getCuratedStudyMaterials(batchTag);
        for (const material of materialsInBatch)
        {
            const currentState = material.getAdditionalData()?.[CuratedStudyMaterialFields.BATCH_REVIEW_STATE];
            if (currentState !== liveStateName)
            {
                continue;
            }
            material.setAdditionalDataField(CuratedStudyMaterialFields.BATCH_REVIEW_STATE, archivedStateName);
            material.setAdditionalDataField(CuratedStudyMaterialFields.SESSION_OUTCOME, outcomeName);
            mutatedMaterials.push(material);
        }

        deck.setAdditionalDataField(AutoAnalysisDeckFields.LAST_CURATED_BATCH_TAG, null);
        deck.setAdditionalDataField(AutoAnalysisDeckFields.LAST_CURATED_BATCH_TOPICS, null);

        // Grade-back: when the user completed the batch with every
        // flashcard marked Easy, apply a positive FSRS review to each
        // archived material's source cards so the next analysis pass
        // sees the updated stability / Glicko rating instead of
        // re-flagging the same topics. Skipped on every other outcome
        // (ENDED_WITH_HARDS / REPLACED_BY_REGEN / AUTO_REPLACED — none
        // of those count as mastery evidence).
        if (outcomeName === CuratedStudyController.#outcomeName(curatedSessionOutcomes.COMPLETED_ALL_EASY))
        {
            await CuratedStudyController.#applyGradeBackToSourceCards(deck, mutatedMaterials);
        }

        await CuratedStudyController.#persistDeckAndDispatchMaterialChanges(deck, mutatedMaterials);
    }

    /**
     * Archives ONLY the materials in the given LIVE batch whose
     * topicIndex appears in `topicIndices`. Used by the Continue branch
     * — the user struggled with these topics and the new round will
     * regenerate them; other topics in the batch stay LIVE under the
     * same batch tag so the session can resume into the new content
     * without losing the topics they already passed.
     *
     * Batched save: mutate every targeted material in memory, then
     * persist with a single deck.save() and one ENTITY_CHANGED per
     * material so the sync push picks up exactly which materials
     * changed.
     */
    static async archivePartialBatchTopics(deck, batchTag, topicIndices, outcome)
    {
        if (!deck || typeof batchTag !== "string" || !batchTag || !Array.isArray(topicIndices) || topicIndices.length === 0)
        {
            return;
        }

        const liveStateName = CuratedStudyController.#stateName(curatedBatchReviewStates.LIVE);
        const archivedStateName = CuratedStudyController.#stateName(curatedBatchReviewStates.ARCHIVED);
        const outcomeName = CuratedStudyController.#outcomeName(outcome);
        const topicIndexSet = new Set(topicIndices);

        const mutatedMaterials = [];
        const materialsInBatch = deck.getCuratedStudyMaterials(batchTag);
        for (const material of materialsInBatch)
        {
            const additionalData = material.getAdditionalData() || {};
            if (additionalData[CuratedStudyMaterialFields.BATCH_REVIEW_STATE] !== liveStateName)
            {
                continue;
            }
            if (!topicIndexSet.has(additionalData[CuratedStudyMaterialFields.TOPIC_INDEX]))
            {
                continue;
            }
            material.setAdditionalDataField(CuratedStudyMaterialFields.BATCH_REVIEW_STATE, archivedStateName);
            material.setAdditionalDataField(CuratedStudyMaterialFields.SESSION_OUTCOME, outcomeName);
            mutatedMaterials.push(material);
        }

        // deck.lastCuratedBatchTag stays set — the LIVE batch is
        // partial-but-still-LIVE; agent regen will land replacement
        // materials carrying the same batch tag.
        await CuratedStudyController.#persistDeckAndDispatchMaterialChanges(deck, mutatedMaterials);
    }

    /**
     * Queues a same-topics regen task — the COMPLETED_ALL_EASY
     * auto-queue and the Continue branch both end up here. Sends
     * `force=true skipAnalysis=true regenerateTopics=[...]` plus an
     * unconditional `autoGenerateCuratedStudy=true` — a user-initiated
     * curated flow always wants curated children spawned regardless
     * of the deck's auto-flag (which only governs unattended
     * behaviour). The optional `onStatusChange` callback is wired
     * through to AnalysisTaskRunner so a progress overlay can render
     * the task tree as it streams in.
     */
    static async queueSameTopicsRegen(deck, regenerateTopics, options = {})
    {
        return AnalysisTaskRunner.queueAndTrack(deck, {
            force: true,
            skipAnalysis: true,
            regenerateTopics: regenerateTopics,
            autoGenerateCuratedStudy: true,
            bClearPreviousFirst: false,
            bTriggerSync: true,
            onStatusChange: options.onStatusChange || null,
        });
    }

    /**
     * Queues a manual Regenerate — the entry dialog's Regenerate button
     * lands here. Sends `force=true skipAnalysis=false
     * autoGenerateCuratedStudy=true`. The agent re-analyses the deck
     * from scratch (fresh weak/volatile topic detection) and replaces
     * the LIVE batch. The autoGenerateCuratedStudy override means the
     * deck's auto-flag does NOT have to be enabled — that flag exists
     * solely to govern unattended weekly behaviour.
     */
    static async queueForceRegen(deck, options = {})
    {
        return AnalysisTaskRunner.queueAndTrack(deck, {
            force: true,
            skipAnalysis: false,
            regenerateTopics: [],
            autoGenerateCuratedStudy: true,
            bClearPreviousFirst: false,
            bTriggerSync: true,
            onStatusChange: options.onStatusChange || null,
        });
    }

    /**
     * Returns true iff the user has graded at least one (non-curated)
     * card AFTER the deck's last analysis. Used to gate the manual
     * Regenerate button — re-running analysis with no new evidence
     * produces the same topics, which means the LLM burn would be
     * wasted. When the deck has never been analysed (no
     * lastAnalyzedAt), this returns true — the first regen is always
     * allowed.
     */
    static hasStudiedSinceLastAnalysis(deck)
    {
        if (!deck)
        {
            return false;
        }
        const additionalData = deck.getAdditionalData() || {};
        const lastAnalyzedAtIso = additionalData[AutoAnalysisDeckFields.LAST_ANALYZED_AT];
        if (typeof lastAnalyzedAtIso !== "string" || lastAnalyzedAtIso.length === 0)
        {
            return true;
        }
        const lastAnalyzedAtMilliseconds = Date.parse(lastAnalyzedAtIso);
        if (!Number.isFinite(lastAnalyzedAtMilliseconds))
        {
            return true;
        }

        // getCards default excludes curated, which is what we want —
        // curated card grades are an artefact of the curated session
        // itself and shouldn't count as evidence of the user studying
        // their actual deck content.
        //
        // The per-attempt timestamp lives inside `fsrs.lastReview` on
        // each ProgressPoint — the model has no top-level
        // `getTimestamp()`. Reading the wrong field made every check
        // return "no new progress" and the Regenerate button stayed
        // disabled even right after a study session. Pattern mirrors
        // AutoAnalysisDispatcher.#collectProgressPointTimestamps.
        const allCards = deck.getCards(true);
        for (const card of allCards)
        {
            const progress = card.getProgress?.();
            if (!progress)
            {
                continue;
            }
            const progressPoints = typeof progress.getProgressPoints === "function" ? progress.getProgressPoints() : [];
            for (const progressPoint of progressPoints)
            {
                const fsrsState = typeof progressPoint?.getFsrsState === "function" ? progressPoint.getFsrsState() : null;
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

                if (Number.isFinite(timestampMilliseconds) && timestampMilliseconds > lastAnalyzedAtMilliseconds)
                {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Computes the session's current step. The session calls this on
     * start() and after every grade / "I've read this" click to figure
     * out what to render next. Phases:
     *   - "material"   — there is at least one topic whose material is
     *                    UNREAD; render that material's content.
     *   - "flashcards" — all preceding topics are fully graded and the
     *                    current topic's material has been read but its
     *                    cards still carry UNGRADED; render the next
     *                    ungraded card for that topic.
     *   - "complete"   — every topic's material has been read and every
     *                    card has been graded; the session is ready to
     *                    branch on all-easy vs mixed-results.
     */
    static computeFlowState(batchInfo)
    {
        if (!batchInfo || !Array.isArray(batchInfo.topicGroups) || batchInfo.topicGroups.length === 0)
        {
            return { phase: "complete", currentTopicIndex: -1, currentMaterial: null, currentCard: null, allEasy: false };
        }

        const ungradedName = CuratedStudyController.#gradeName(curatedFlashcardGrade.UNGRADED);
        const hardName     = CuratedStudyController.#gradeName(curatedFlashcardGrade.HARD);
        const easyName     = CuratedStudyController.#gradeName(curatedFlashcardGrade.EASY);

        for (const topicGroup of batchInfo.topicGroups)
        {
            const materialReadState = topicGroup.material?.getAdditionalData()?.[CuratedStudyMaterialFields.READ_STATE];
            if (materialReadState !== "READ")
            {
                return {
                    phase: "material",
                    currentTopicIndex: topicGroup.topicIndex,
                    currentTopicGroup: topicGroup,
                    currentMaterial: topicGroup.material,
                    currentCard: null,
                    allEasy: false,
                };
            }

            const ungradedCards = topicGroup.cards.filter((card) =>
            {
                const lastGrade = card.getAdditionalData()?.[CuratedFlashcardFields.LAST_CURATED_GRADE];
                return lastGrade !== easyName && lastGrade !== hardName;
            });

            if (ungradedCards.length > 0)
            {
                return {
                    phase: "flashcards",
                    currentTopicIndex: topicGroup.topicIndex,
                    currentTopicGroup: topicGroup,
                    currentMaterial: topicGroup.material,
                    currentCard: ungradedCards[0],
                    allEasy: false,
                };
            }

            // Diagnostic — surface the most common "cards not asked"
            // root cause when nothing surfaces between two materials.
            // A topic with zero cards means the agent generated the
            // material but failed (or was skipped) on flashcard
            // generation for it. The flow correctly skips to the next
            // topic; logging the gap saves the developer from staring
            // at the UI wondering why flashcards never appear.
            if (topicGroup.cards.length === 0)
            {
                console.warn(`[CuratedStudyController] Topic "${topicGroup.topicName}" (index ${topicGroup.topicIndex}) has 0 curated flashcards — skipping straight to the next topic. The agent's flashcard generation likely failed for this material; consider regenerating from the entry dialog.`);
            }
        }

        // Every topic's material has been read and every card has been
        // graded. Surface allEasy so the session can pick between the
        // congrats screen and the mixed-results dialog without
        // re-walking the cards. Topics with zero cards (flashcard
        // generation failed for that topic) are treated as "passed" —
        // the material was still read, and a half-failed batch should
        // not punish the user with a mixed-results dialog showing zero
        // hard topics. They are effectively skipped from the gating
        // check while still contributing to the read flow.
        const allEasy = batchInfo.topicGroups.every((topicGroup) =>
        {
            if (topicGroup.cards.length === 0)
            {
                return true;
            }
            return topicGroup.cards.every((card) =>
            {
                return card.getAdditionalData()?.[CuratedFlashcardFields.LAST_CURATED_GRADE] === easyName;
            });
        });

        return { phase: "complete", currentTopicIndex: -1, currentTopicGroup: null, currentMaterial: null, currentCard: null, allEasy: allEasy };
    }

    /**
     * Returns the topicGroups for the given batch whose flashcards
     * include at least one HARD grade. Used by the mixed-results
     * Continue branch to compute the subset of topics to regenerate.
     */
    static getHardTopicGroups(batchInfo)
    {
        if (!batchInfo || !Array.isArray(batchInfo.topicGroups))
        {
            return [];
        }
        const hardName = CuratedStudyController.#gradeName(curatedFlashcardGrade.HARD);
        return batchInfo.topicGroups.filter((topicGroup) =>
        {
            return topicGroup.cards.some((card) =>
            {
                return card.getAdditionalData()?.[CuratedFlashcardFields.LAST_CURATED_GRADE] === hardName;
            });
        });
    }

    /**
     * Walks every curated material on the deck and demotes any
     * LIVE-tagged material whose generatedForAnalysisAt doesn't match
     * the deck's lastCuratedBatchTag. Defense-in-depth against data
     * corruption — if a partial write left orphans behind, the entry
     * dialog calls this before reading getLiveBatchInfo so a stale
     * LIVE material from a prior batch can't masquerade as the current
     * one.
     *
     * Batched save: collect all orphan mutations in memory, then one
     * deck.save() and per-material ENTITY_CHANGED for the affected
     * subset.
     */
    static async repairOrphanedLiveBatches(deck)
    {
        if (!deck)
        {
            return;
        }

        const additionalData = deck.getAdditionalData() || {};
        const canonicalBatchTag = additionalData[AutoAnalysisDeckFields.LAST_CURATED_BATCH_TAG] || null;
        const liveStateName = CuratedStudyController.#stateName(curatedBatchReviewStates.LIVE);
        const archivedStateName = CuratedStudyController.#stateName(curatedBatchReviewStates.ARCHIVED);
        const autoReplacedName = CuratedStudyController.#outcomeName(curatedSessionOutcomes.AUTO_REPLACED);

        const allCuratedMaterials = deck.getCuratedStudyMaterials();
        const mutatedMaterials = [];

        for (const material of allCuratedMaterials)
        {
            const fields = material.getAdditionalData() || {};
            if (fields[CuratedStudyMaterialFields.BATCH_REVIEW_STATE] !== liveStateName)
            {
                continue;
            }
            const ownTag = fields[CuratedStudyMaterialFields.GENERATED_FOR_ANALYSIS_AT];
            if (canonicalBatchTag !== null && ownTag === canonicalBatchTag)
            {
                continue;
            }
            material.setAdditionalDataField(CuratedStudyMaterialFields.BATCH_REVIEW_STATE, archivedStateName);
            material.setAdditionalDataField(CuratedStudyMaterialFields.SESSION_OUTCOME, autoReplacedName);
            mutatedMaterials.push(material);
        }

        if (mutatedMaterials.length === 0)
        {
            return;
        }

        await CuratedStudyController.#persistDeckAndDispatchMaterialChanges(deck, mutatedMaterials);
        console.warn(`[CuratedStudyController] Repaired ${mutatedMaterials.length} orphaned LIVE curated material(s) on deck ${deck.getId()}.`);
    }

    /**
     * Groups materials with their accompanying flashcards by topicIndex.
     * Returns an array sorted ascending by topicIndex. Each entry
     * carries the material, its cards (sorted by syllabusPositionInTopic),
     * and the topic metadata pulled from the material. Materials with
     * no topicIndex sort to the end.
     */
    static #groupByTopic(materials, cards)
    {
        const cardsByMaterialId = new Map();
        for (const card of cards)
        {
            const studyMaterialId = card.getAdditionalData()?.[CuratedFlashcardFields.STUDY_MATERIAL_ID];
            if (typeof studyMaterialId !== "string" || !studyMaterialId)
            {
                continue;
            }
            if (!cardsByMaterialId.has(studyMaterialId))
            {
                cardsByMaterialId.set(studyMaterialId, []);
            }
            cardsByMaterialId.get(studyMaterialId).push(card);
        }

        const topicGroups = materials.map((material) =>
        {
            const additionalData = material.getAdditionalData() || {};
            const groupedCards = (cardsByMaterialId.get(material.getId()) || []).slice();
            groupedCards.sort((firstCard, secondCard) =>
            {
                const firstPosition = firstCard.getAdditionalData()?.[CuratedFlashcardFields.SYLLABUS_POSITION_IN_TOPIC] ?? Infinity;
                const secondPosition = secondCard.getAdditionalData()?.[CuratedFlashcardFields.SYLLABUS_POSITION_IN_TOPIC] ?? Infinity;
                return firstPosition - secondPosition;
            });

            return {
                topicIndex:     additionalData[CuratedStudyMaterialFields.TOPIC_INDEX] ?? Infinity,
                topicName:      additionalData[CuratedStudyMaterialFields.TOPIC_NAME] || "",
                topicStrength:  additionalData[CuratedStudyMaterialFields.TOPIC_STRENGTH] || "WEAK",
                material:       material,
                cards:          groupedCards,
            };
        });

        topicGroups.sort((firstGroup, secondGroup) => firstGroup.topicIndex - secondGroup.topicIndex);
        return topicGroups;
    }

    /**
     * Applies a positive FSRS review to each source card referenced by
     * `mutatedMaterials`. Runs only on COMPLETED_ALL_EASY archive — the
     * user has demonstrated mastery of the topics by passing every
     * curated flashcard, so the underlying cards' FSRS stability and
     * Glicko rating should reflect that. Without this, the next
     * analysis pass would still see the original weak signal on these
     * cards and re-pick the same topics.
     *
     * Each `card.attempt(...)` chains through its own `card.save()` →
     * `deck.save(false)` → `SyncEvents.ENTITY_CHANGED`, so the
     * mutations are persisted and the sync push picks them up
     * individually. The redundant final deck save inside
     * `#persistDeckAndDispatchMaterialChanges` after this returns is
     * cheap because the in-memory state is already consistent.
     */
    static async #applyGradeBackToSourceCards(deck, mutatedMaterials)
    {
        if (!deck || !Array.isArray(mutatedMaterials) || mutatedMaterials.length === 0)
        {
            return;
        }

        // Union of every archived material's source-card-id list. A
        // single source card can drive multiple topics, so we dedupe
        // before the lookup.
        const sourceCardIds = new Set();
        for (const material of mutatedMaterials)
        {
            const idsForMaterial = material.getAdditionalData()?.[CuratedStudyMaterialFields.SOURCE_CARD_IDS];
            if (!Array.isArray(idsForMaterial))
            {
                continue;
            }
            for (const sourceId of idsForMaterial)
            {
                if (typeof sourceId === "string" && sourceId.length > 0)
                {
                    sourceCardIds.add(sourceId);
                }
            }
        }
        if (sourceCardIds.size === 0)
        {
            return;
        }

        // One pass over the deck builds an id→card index. AnalyzeDeckPerformance
        // scopes into descendants, so the grade-back walks the full
        // subtree to find every source card.
        const cardLookup = new Map();
        for (const card of deck.getCards(true))
        {
            cardLookup.set(card.getId(), card);
        }

        let gradeBackCount = 0;
        for (const sourceId of sourceCardIds)
        {
            const card = cardLookup.get(sourceId);
            if (!card)
            {
                continue;
            }
            // Defensive — source cards should always be non-curated by
            // construction (the analysis filters bCurated out) but the
            // check is cheap insurance against a stale dataset.
            if (card.getAdditionalData()?.[CuratedFlashcardFields.B_CURATED] === true)
            {
                continue;
            }
            try
            {
                await card.attempt(
                    CuratedStudyController.SOURCE_CARD_GRADE_BACK_RATING,
                    CuratedStudyController.SOURCE_CARD_GRADE_BACK_TIME_SECONDS,
                    true,
                );
                gradeBackCount += 1;
            }
            catch (gradeBackError)
            {
                console.warn(`[CuratedStudyController] Grade-back failed for source card ${sourceId}:`, gradeBackError);
            }
        }

        if (gradeBackCount > 0)
        {
            console.info(`[CuratedStudyController] Grade-back applied Easy review to ${gradeBackCount} source card(s) after COMPLETED_ALL_EASY.`);
        }
    }

    /**
     * Persists a batch mutation in a single IndexedDB write and fires
     * one SyncEvents.ENTITY_CHANGED per mutated material so the sync
     * push layer tags each one for upload. Calling material.save() in
     * a loop would re-serialise the entire deck N times — that's the
     * pattern this helper exists to avoid. The deck.save(false) call
     * already dispatches its own DECK-level ENTITY_CHANGED, so the
     * sync push picks up the deck's additionalData changes too
     * (lastCuratedBatchTag clearing, etc.).
     */
    static async #persistDeckAndDispatchMaterialChanges(deck, mutatedMaterials)
    {
        if (!deck)
        {
            return;
        }
        await deck.save(false);
        if (!Array.isArray(mutatedMaterials) || mutatedMaterials.length === 0)
        {
            return;
        }
        for (const material of mutatedMaterials)
        {
            window.dispatchEvent(new CustomEvent(SyncEvents.ENTITY_CHANGED,
            {
                detail:
                {
                    entityId:   material.getId(),
                    entityType: entityTypes.STUDY_MATERIAL,
                    data:       material.toJson(),
                }
            }));
        }
    }

    static #parseBatchTagToTimestamp(batchTag)
    {
        const parsed = Date.parse(batchTag);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    /**
     * Picks the outcome label for an archived batch. A batch can carry
     * mixed sessionOutcome values across its materials — typically when
     * a Continue branch left some materials as REPLACED_BY_REGEN and a
     * subsequent COMPLETED_ALL_EASY archive stamped the rest. We
     * surface the highest-priority "terminal" outcome so the user sees
     * the actual final state of the batch, not a half-finished label.
     *
     * Priority (highest first):
     *   COMPLETED_ALL_EASY  — user closed the loop on this batch
     *   ENDED_WITH_HARDS    — user explicitly bailed
     *   REPLACED_BY_REGEN   — manual or feedback regen replaced it
     *   AUTO_REPLACED       — agent auto-superseded an untouched batch
     */
    static #pickBatchOutcome(materials)
    {
        const outcomePriority = [
            "COMPLETED_ALL_EASY",
            "ENDED_WITH_HARDS",
            "REPLACED_BY_REGEN",
            "AUTO_REPLACED",
        ];
        const presentOutcomes = new Set();
        for (const material of materials)
        {
            const outcome = material.getAdditionalData()?.[CuratedStudyMaterialFields.SESSION_OUTCOME];
            if (typeof outcome === "string" && outcome.length > 0)
            {
                presentOutcomes.add(outcome);
            }
        }
        for (const candidate of outcomePriority)
        {
            if (presentOutcomes.has(candidate))
            {
                return candidate;
            }
        }
        return null;
    }

    /**
     * Picks the batchReviewState label for an archived batch. SUPERSEDED
     * wins over ARCHIVED — if any material is SUPERSEDED the batch was
     * auto-replaced, otherwise it's a normal archive.
     */
    static #pickBatchReviewState(materials)
    {
        const supersededName = CuratedStudyController.#stateName(curatedBatchReviewStates.SUPERSEDED);
        const archivedName   = CuratedStudyController.#stateName(curatedBatchReviewStates.ARCHIVED);

        for (const material of materials)
        {
            if (material.getAdditionalData()?.[CuratedStudyMaterialFields.BATCH_REVIEW_STATE] === supersededName)
            {
                return supersededName;
            }
        }
        return archivedName;
    }

    /**
     * Resolves an enumeration NUMERIC value back to its NAME (the form
     * stored on Mongo and round-tripped through sync). The generated
     * enum exports look like `{ LIVE: 0, ARCHIVED: 1, SUPERSEDED: 2 }`
     * — the name string is the value the persistence layer carries.
     */
    static #stateName(stateNumericValue)
    {
        for (const [stateName, stateNumber] of Object.entries(curatedBatchReviewStates))
        {
            if (stateNumber === stateNumericValue)
            {
                return stateName;
            }
        }
        return "LIVE";
    }

    static #gradeName(gradeNumericValue)
    {
        for (const [gradeName, gradeNumber] of Object.entries(curatedFlashcardGrade))
        {
            if (gradeNumber === gradeNumericValue)
            {
                return gradeName;
            }
        }
        return "UNGRADED";
    }

    static #outcomeName(outcomeNumericValue)
    {
        for (const [outcomeName, outcomeNumber] of Object.entries(curatedSessionOutcomes))
        {
            if (outcomeNumber === outcomeNumericValue)
            {
                return outcomeName;
            }
        }
        return "IN_PROGRESS";
    }
}

export default CuratedStudyController;
