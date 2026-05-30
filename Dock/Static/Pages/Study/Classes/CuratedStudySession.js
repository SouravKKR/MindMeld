import CuratedFlashcardFields from "../../../Globals/Classes/Analysis/CuratedFlashcardFields.js";
import CuratedStudyCompletionDialog from "../Components/CuratedStudyCompletionDialog.js";
import CuratedStudyController from "../../../Globals/Classes/CuratedStudy/CuratedStudyController.js";
import CuratedStudyProgressOverlay from "../Components/CuratedStudyProgressOverlay.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import StudySession from "./StudySession.js";
import { curatedFlashcardGrade } from "../../../Globals/Enumerations/CuratedFlashcardGrade.js";
import { curatedSessionOutcomes } from "../../../Globals/Enumerations/CuratedSessionOutcomes.js";


/**
 * CuratedStudySession
 *
 * Per-topic interleaved knowledge-consolidation session. Walks the
 * LIVE batch's topics in topicIndex order; for each topic, the user
 * reads the simpler-language material, clicks "I've read this", then
 * answers a small set of flashcards as Easy or Hard. After the last
 * topic's last card, the session branches:
 *
 *   - **All easy**     → congrats screen → archive batch as
 *                        COMPLETED_ALL_EASY → fire-and-forget queue a
 *                        same-topics regen → return to deck.
 *   - **Mixed**        → continue-or-end dialog. Continue regenerates
 *                        ONLY the topics that had hard cards (same
 *                        batch tag) and resumes the loop. End archives
 *                        the batch as ENDED_WITH_HARDS and returns.
 *
 * State is computed from persisted data on every render — readState on
 * the material, lastCuratedGrade on each card — so closing the app
 * mid-session and reopening it resumes from the same step. The
 * controller's computeFlowState owns the cursor logic; this class is a
 * thin renderer.
 */
class CuratedStudySession extends StudySession
{
    #batchTag = null;
    #regenerating = false;

    constructor(studyPage, deck = null, options = {})
    {
        super(studyPage, deck);

        // Store the requested batchTag for start() to validate. We do
        // NOT call PageNavigator.back() from the constructor — the page
        // is mid-mount (PageNavigator pushes + initialises before
        // appendChild), so navigating away here would leave an orphaned
        // page element in the DOM. Validation is deferred to start(),
        // which runs from connectedCallback after the page is fully
        // attached.
        const batchTag = options?.batchTag;
        if (typeof batchTag === "string" && batchTag.length > 0)
        {
            this.#batchTag = batchTag;
        }
        else
        {
            console.error("[CuratedStudySession] Constructed without a batchTag — start() will bail.");
        }
    }

    start()
    {
        if (typeof this.#batchTag !== "string" || this.#batchTag.length === 0)
        {
            DialogBox.alert("Curated study", "No curated batch was selected. Open Curated Study from the deck again.");
            PageNavigator.back();
            return;
        }

        // Validate the LIVE batch matches the requested tag. If the
        // entry dialog opened with a stale handle (sync arrived between
        // picker and session), bail back to the previous page so the
        // user isn't stuck on an empty screen.
        const liveBatchInfo = CuratedStudyController.getLiveBatchInfo(this._deck);
        if (!liveBatchInfo || liveBatchInfo.tag !== this.#batchTag)
        {
            DialogBox.alert("Curated study", "The curated batch you were viewing has been replaced. Re-open Curated Study from the deck to see the new batch.");
            PageNavigator.back();
            return;
        }

        this.#renderCurrentStep();
    }

    /**
     * Called by PageNavigator when the user returns to the page after
     * navigating to a sub-page. Re-reads from the deck so a sync that
     * arrived while we were elsewhere is reflected in the rendered phase.
     */
    onResumed()
    {
        this.#renderCurrentStep();
    }

    #renderCurrentStep()
    {
        const liveBatchInfo = CuratedStudyController.getLiveBatchInfo(this._deck);

        if (!liveBatchInfo || liveBatchInfo.tag !== this.#batchTag)
        {
            // The batch we were studying just vanished — could be a
            // mid-session sync archival from another device, or the
            // controller's archive call after a terminal grade. Either
            // way, walk back so the user lands on the entry surface.
            PageNavigator.back();
            return;
        }

        const flowState = CuratedStudyController.computeFlowState(liveBatchInfo);

        if (flowState.phase === "material")
        {
            this.#renderMaterialPhase(liveBatchInfo, flowState);
            return;
        }
        if (flowState.phase === "flashcards")
        {
            this.#renderFlashcardPhase(liveBatchInfo, flowState);
            return;
        }
        this.#handleCompletionPhase(liveBatchInfo, flowState);
    }

    #renderMaterialPhase(liveBatchInfo, flowState)
    {
        this.#applyVisibility({ material: true, flashcards: false });
        this.#renderTopicBadge(liveBatchInfo, flowState, null);

        const contentSection = this._studyPage.querySelector(".study-material-content-section");
        if (!contentSection)
        {
            return;
        }
        contentSection.innerHTML = flowState.currentMaterial.getContent?.() || "";
        this._studyPage.renderLatex?.();

        const readButton = this._studyPage.querySelector(".curated-i-have-read-this-button");
        if (!readButton)
        {
            return;
        }

        // Clone-and-replace clears any previous listener so the same
        // button doesn't accumulate handlers across re-renders.
        // IMPORTANT: cloneNode(true) copies the `disabled` attribute,
        // and the previous render's click handler sets disabled=true
        // before re-rendering — so without resetting, every subsequent
        // material phase would mount a button that's already disabled.
        const freshButton = readButton.cloneNode(true);
        freshButton.disabled = false;
        readButton.parentNode.replaceChild(freshButton, readButton);

        freshButton.addEventListener("click", async () =>
        {
            freshButton.disabled = true;
            await CuratedStudyController.markMaterialRead(flowState.currentMaterial);
            this.#renderCurrentStep();
        });
    }

    #renderFlashcardPhase(liveBatchInfo, flowState)
    {
        this.#applyVisibility({ material: false, flashcards: true });

        const card = flowState.currentCard;
        this._current = card;

        const questionSection     = this._studyPage.querySelector(".question-section");
        const answerSection       = this._studyPage.querySelector(".answer-section");
        const showAnswerButton    = this._studyPage.querySelector(".show-answer-button");
        const curatedScoreSection = this._studyPage.querySelector(".curated-score-section");

        if (!questionSection || !answerSection || !showAnswerButton || !curatedScoreSection)
        {
            return;
        }

        const topicCardCount = flowState.currentTopicGroup?.cards?.length ?? 0;
        const cardPositionInTopic = (card.getAdditionalData()?.[CuratedFlashcardFields.SYLLABUS_POSITION_IN_TOPIC] ?? 0) + 1;
        this.#renderTopicBadge(liveBatchInfo, flowState, `Card ${cardPositionInTopic} of ${topicCardCount}`);

        questionSection.innerHTML = card.getQuestion?.() || "";
        answerSection.innerHTML = "";

        // Reveal-and-grade flow: show-answer reveals the answer block
        // and unhides Easy/Hard. The standard FSRS user-score-section
        // was removed in #setupUi for this session, so the only score
        // surface is .curated-score-section.
        showAnswerButton.style.display = "block";
        showAnswerButton.hidden = false;
        curatedScoreSection.hidden = true;

        // cloneNode(true) carries the disabled attribute over from
        // whatever state the previous render left the button in. We
        // explicitly reset disabled=false so a button that was
        // greyed-out at the end of the prior card doesn't show up
        // un-clickable here.
        const freshShowAnswerButton = showAnswerButton.cloneNode(true);
        freshShowAnswerButton.disabled = false;
        showAnswerButton.parentNode.replaceChild(freshShowAnswerButton, showAnswerButton);

        freshShowAnswerButton.addEventListener("click", () =>
        {
            answerSection.innerHTML = card.getAnswer?.() || "";
            this._studyPage.renderLatex?.();
            freshShowAnswerButton.style.display = "none";
            freshShowAnswerButton.hidden = true;
            curatedScoreSection.hidden = false;
        });

        const easyButton = curatedScoreSection.querySelector(".curated-easy-button");
        const hardButton = curatedScoreSection.querySelector(".curated-hard-button");
        if (!easyButton || !hardButton)
        {
            return;
        }

        const freshEasyButton = easyButton.cloneNode(true);
        freshEasyButton.disabled = false;
        easyButton.parentNode.replaceChild(freshEasyButton, easyButton);
        const freshHardButton = hardButton.cloneNode(true);
        freshHardButton.disabled = false;
        hardButton.parentNode.replaceChild(freshHardButton, hardButton);

        const easyName = this.#gradeName(curatedFlashcardGrade.EASY);
        const hardName = this.#gradeName(curatedFlashcardGrade.HARD);

        const gradeAndAdvance = async (gradeName) =>
        {
            freshEasyButton.disabled = true;
            freshHardButton.disabled = true;
            await CuratedStudyController.gradeCard(card, gradeName);
            this.#renderCurrentStep();
        };

        freshEasyButton.addEventListener("click", () => gradeAndAdvance(easyName));
        freshHardButton.addEventListener("click", () => gradeAndAdvance(hardName));
    }

    async #handleCompletionPhase(liveBatchInfo, flowState)
    {
        // Avoid re-firing the completion handler if a regen is already
        // in flight (the overlay would otherwise pile on a second dialog
        // when the re-render fires after sync completes).
        if (this.#regenerating)
        {
            return;
        }

        this.#applyVisibility({ material: false, flashcards: false });
        const badge = this._studyPage.querySelector(".curated-topic-progress-badge");
        if (badge)
        {
            badge.hidden = true;
            badge.textContent = "";
        }

        if (flowState.allEasy)
        {
            await this.#handleAllEasyOutcome(liveBatchInfo);
            return;
        }
        await this.#handleMixedOutcome(liveBatchInfo);
    }

    async #handleAllEasyOutcome(liveBatchInfo)
    {
        await CuratedStudyCompletionDialog.showAllEasy();

        const sameTopicsList = liveBatchInfo.topicGroups.map((topicGroup) =>
        {
            return {
                name: topicGroup.topicName,
                strength: topicGroup.topicStrength,
                topicIndex: topicGroup.topicIndex,
                hardCards: [],
            };
        });

        await CuratedStudyController.archiveBatch(
            this._deck,
            this.#batchTag,
            curatedSessionOutcomes.COMPLETED_ALL_EASY,
        );

        // Fire-and-forget the same-topics regen so the next time the
        // user opens Curated Study, a fresh batch on the same topics
        // is waiting. We do not block on it — the user just saw a
        // congrats screen and making them wait again here would feel
        // weird.
        CuratedStudyController.queueSameTopicsRegen(this._deck, sameTopicsList).catch((regenerationError) =>
        {
            console.warn("[CuratedStudySession] Failed to queue follow-up regen:", regenerationError);
        });

        PageNavigator.back();
    }

    async #handleMixedOutcome(liveBatchInfo)
    {
        const hardTopicGroups = CuratedStudyController.getHardTopicGroups(liveBatchInfo);
        const userChoice = await CuratedStudyCompletionDialog.showMixedResults(hardTopicGroups);

        if (userChoice === "end")
        {
            await CuratedStudyController.archiveBatch(
                this._deck,
                this.#batchTag,
                curatedSessionOutcomes.ENDED_WITH_HARDS,
            );
            PageNavigator.back();
            return;
        }

        await this.#runContinueBranch(hardTopicGroups);
    }

    async #runContinueBranch(hardTopicGroups)
    {
        if (!hardTopicGroups || hardTopicGroups.length === 0)
        {
            PageNavigator.back();
            return;
        }

        const hardName = this.#gradeName(curatedFlashcardGrade.HARD);

        // Build the regenerateTopics payload: for each hard topic,
        // gather every card the user graded HARD and pass them as
        // {question, answer} pairs so the LLM can address the actual
        // confusion when authoring the replacement material.
        const regenerateTopics = hardTopicGroups.map((topicGroup) =>
        {
            const hardCardEntries = topicGroup.cards
                .filter((card) => card.getAdditionalData()?.[CuratedFlashcardFields.LAST_CURATED_GRADE] === hardName)
                .map((card) => ({
                    question: card.getQuestion?.() || "",
                    answer:   card.getAnswer?.() || "",
                }));

            return {
                name:       topicGroup.topicName,
                strength:   topicGroup.topicStrength,
                topicIndex: topicGroup.topicIndex,
                hardCards:  hardCardEntries,
            };
        });

        // Archive ONLY the hard-topic materials in the current batch.
        // Other topics stay LIVE under the same batch tag so the new
        // round can resume without re-doing the topics the user
        // already passed.
        await CuratedStudyController.archivePartialBatchTopics(
            this._deck,
            this.#batchTag,
            hardTopicGroups.map((topicGroup) => topicGroup.topicIndex),
            curatedSessionOutcomes.REPLACED_BY_REGEN,
        );

        this.#regenerating = true;

        const overlay = CuratedStudyProgressOverlay.show({
            title: "Refining the topics you struggled with…",
            statusText: "Queueing the regeneration",
            // When the regen succeeds we'll re-render below. If the
            // user bails or the regen errors, the error-Close drops
            // them back to the previous page so they aren't stranded
            // on a hidden study-page surface (every phase section is
            // already hidden when we reach this code path).
            bNavigateBackOnErrorClose: true,
        });

        try
        {
            const regenResult = await CuratedStudyController.queueSameTopicsRegen(this._deck, regenerateTopics, {
                onStatusChange: (statusEvent) => overlay.updateStatus(statusEvent),
            });
            overlay.close();

            // If the server already had an analysis running and rejected
            // the force-regen with a 409, joining that unrelated task
            // does NOT produce the new materials this branch needs.
            // Surface the situation to the user and bail back to the
            // previous page — they can retry once the other run lands.
            if (regenResult?.reason === "force_blocked_by_active_task")
            {
                DialogBox.alert(
                    "Regeneration delayed",
                    "Another analysis was already running for this deck, so your refinement could not start immediately. Re-open Curated Study in a minute or two to retry."
                );
                this.#regenerating = false;
                PageNavigator.back();
                return;
            }
        }
        catch (regenerationError)
        {
            overlay.showError("Regeneration failed", regenerationError?.message || String(regenerationError));
            this.#regenerating = false;
            return;
        }

        this.#regenerating = false;
        // Sync has already landed the new materials (queueSameTopicsRegen
        // sets bTriggerSync=true). Re-render — computeFlowState will
        // pick up the new material/cards for the regenerated topics.
        this.#renderCurrentStep();
    }

    #renderTopicBadge(liveBatchInfo, flowState, extraText)
    {
        const badge = this._studyPage.querySelector(".curated-topic-progress-badge");
        if (!badge)
        {
            return;
        }
        const totalTopics = liveBatchInfo.topicGroups.length;
        const currentTopicNumber = Math.max(1, Math.min(totalTopics, (flowState.currentTopicIndex ?? 0) + 1));
        const topicName = flowState.currentTopicGroup?.topicName || "";
        const trailingText = extraText ? ` · ${extraText}` : "";
        badge.hidden = false;
        badge.textContent = `Topic ${currentTopicNumber} of ${totalTopics} — ${topicName}${trailingText}`;
    }

    #applyVisibility({ material, flashcards })
    {
        const studyMaterialContentSection = this._studyPage.querySelector(".study-material-content-section");
        const questionSection             = this._studyPage.querySelector(".question-section");
        const answerSection               = this._studyPage.querySelector(".answer-section");
        const resizeHandle                = this._studyPage.querySelector(".resize-handle");
        const showAnswerButton            = this._studyPage.querySelector(".show-answer-button");
        const curatedScoreSection         = this._studyPage.querySelector(".curated-score-section");
        const iHaveReadThisButton         = this._studyPage.querySelector(".curated-i-have-read-this-button");
        const previousNextContainer       = this._studyPage.querySelector(".previous-next-button-container");

        if (studyMaterialContentSection)
        {
            studyMaterialContentSection.style.display = material ? "" : "none";
        }
        if (questionSection)
        {
            questionSection.style.display = flashcards ? "" : "none";
        }
        if (answerSection)
        {
            answerSection.style.display = flashcards ? "" : "none";
        }
        if (resizeHandle)
        {
            resizeHandle.style.display = flashcards ? "" : "none";
        }
        if (showAnswerButton)
        {
            // Show-answer is only meaningful in the flashcards phase; the
            // flashcard renderer further toggles it after the reveal.
            showAnswerButton.style.display = flashcards ? "" : "none";
        }
        if (curatedScoreSection)
        {
            // Hidden until the user clicks show-answer; flashcard renderer
            // unhides it after the reveal.
            curatedScoreSection.hidden = true;
        }
        if (iHaveReadThisButton)
        {
            iHaveReadThisButton.hidden = !material;
        }
        if (previousNextContainer)
        {
            // CuratedStudySession is strictly forward-walking — no
            // freelance prev/next navigation. Hide the container so it
            // doesn't accidentally surface in either phase.
            previousNextContainer.style.display = "none";
        }
    }

    #gradeName(gradeNumericValue)
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
}

export default CuratedStudySession;
