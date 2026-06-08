import { getRandomUuid } from "../../UtilityFunctions/GetRandomUuid.js";
import { mockTestItemTypes } from "../../Enumerations/MockTestItemTypes.js";
import { mockTestEvaluationStatuses } from "../../Enumerations/MockTestEvaluationStatuses.js";
import { questionTypes } from "../../Enumerations/QuestionTypes.js";
import MockTestEvaluationConstants from "../../Constants/MockTestEvaluationConstants.js";
import MockTestItemFactory from "./MockTestItemFactory.js";

class MockTestAttempt
{
    #id = "";
    #attemptDate = null;
    #items = [];
    #score = 0;
    #maxScore = 0;
    // Tracks where this attempt sits in the grading pipeline. PENDING when
    // the attempt is freshly created, GRADING while the Agent task is
    // running, COMPLETED once scores + remarks are applied, FAILED if the
    // task gave up. Drives the Answer Key page's rendering branch.
    #evaluationStatus = mockTestEvaluationStatuses.PENDING;
    // Optional free-form note from the candidate to influence the LLM's
    // grading style (e.g. "be lenient on units"). Stored on the attempt so
    // a re-evaluation can pre-populate the dialog with the last value used.
    // Empty string = no instructions provided.
    #evaluationInstructions = "";
    // When true, MCQ + MULTIPLE_CORRECT questions are still scored
    // deterministically (we trust the index match) but are ALSO sent to
    // the LLM so it can produce examiner remarks on the candidate's
    // selections. Off by default — keeps MCQ-only attempts on the free
    // offline fast path. The candidate opts in per-attempt via the
    // EvaluationInstructionsDialog checkbox.
    #enableLlmMcqFeedback = false;
    // Free-form bag for per-attempt metadata that does not warrant a
    // dedicated field. Offline-mode attempts stash uploaded scan file
    // paths here under `uploadedFiles: string[]` so the deferred OCR +
    // LLM evaluation pipeline can pick them up later.
    #additionalData = {};

    constructor(id, attemptDate = new Date(), items = [], score = 0, maxScore = 0, additionalData = {}, evaluationStatus = mockTestEvaluationStatuses.PENDING, evaluationInstructions = "", enableLlmMcqFeedback = false)
    {
        this.#id = id || getRandomUuid();
        this.#attemptDate = new Date(attemptDate);
        this.#items = items;
        this.#score = score;
        this.#maxScore = maxScore;
        this.#additionalData = additionalData || {};
        this.#evaluationStatus = Number.isFinite(evaluationStatus) ? evaluationStatus : mockTestEvaluationStatuses.PENDING;
        this.#evaluationInstructions = typeof evaluationInstructions === "string" ? evaluationInstructions : "";
        this.#enableLlmMcqFeedback = enableLlmMcqFeedback === true;
    }

    getId() { return this.#id; }
    getAttemptDate() { return this.#attemptDate; }
    getItems() { return this.#items; }
    getScore() { return this.#score; }
    getMaxScore() { return this.#maxScore; }
    getAdditionalData() { return this.#additionalData; }
    getEvaluationStatus() { return this.#evaluationStatus; }
    getEvaluationInstructions() { return this.#evaluationInstructions; }
    getEnableLlmMcqFeedback() { return this.#enableLlmMcqFeedback; }

    setItems(items) { this.#items = items; }
    setScore(score) { this.#score = score; }
    setMaxScore(maxScore) { this.#maxScore = maxScore; }
    setAdditionalData(additionalData) { this.#additionalData = additionalData || {}; }
    setEvaluationStatus(status) { this.#evaluationStatus = status; }
    setEvaluationInstructions(value) { this.#evaluationInstructions = typeof value === "string" ? value : ""; }
    setEnableLlmMcqFeedback(value) { this.#enableLlmMcqFeedback = value === true; }

    /**
     * Grades every question in the attempt that can be scored
     * deterministically — MCQ and MULTIPLE_CORRECT — using the mock test's
     * marking scheme. Subjective and single-word questions are left for the
     * Agent's LLM-grading workflow. Returns a small report describing what
     * was graded inline vs what still needs the LLM, so the caller can
     * decide whether to spawn a server task.
     *
     * The method is idempotent — running it again overwrites prior scores
     * with fresh values. Remarks are explicitly cleared on offline-graded
     * questions because the Answer Key page treats non-empty remarks as
     * "the LLM had something to say."
     */
    evaluate(mockTest)
    {
        const offlineGradableTypeKeys = new Set(MockTestEvaluationConstants.OFFLINE_GRADABLE_QUESTION_TYPES);
        const llmGradableQuestions = [];

        let currentSectionItem = null;
        let totalAwarded = 0;

        for (const item of this.#items)
        {
            if (item?.getType?.() === mockTestItemTypes.SECTION)
            {
                currentSectionItem = item;
                continue;
            }

            if (item?.getType?.() !== mockTestItemTypes.QUESTION)
            {
                continue;
            }

            const questionItem = item;
            const additionalData = questionItem.getAdditionalData?.() || {};
            const typeKey = MockTestAttempt.#resolveQuestionTypeKey(additionalData);

            if (!typeKey)
            {
                continue;
            }

            const sectionContext = currentSectionItem
                ? { id: currentSectionItem.getId?.(), label: currentSectionItem.getTitle?.() }
                : null;
            const markingRule = mockTest.resolveMarkingRuleForQuestion(
                { additionalData: { ...additionalData, typeKey } },
                sectionContext
            );

            if (!offlineGradableTypeKeys.has(typeKey))
            {
                llmGradableQuestions.push({ questionItem, typeKey, markingRule, sectionContext });
                continue;
            }

            const awardedScore = MockTestAttempt.#scoreOptionBasedQuestion(typeKey, questionItem, markingRule);
            questionItem.setScore(awardedScore);
            questionItem.setRemarks("");
            totalAwarded += awardedScore;
        }

        const allGradedOffline = llmGradableQuestions.length === 0;

        if (allGradedOffline)
        {
            this.#score = totalAwarded;
        }

        return { allGradedOffline, llmGradableQuestions, offlineAwardedSubtotal: totalAwarded };
    }

    static #resolveQuestionTypeKey(additionalData)
    {
        if (typeof additionalData.typeKey === "string" && additionalData.typeKey.length > 0)
        {
            return additionalData.typeKey;
        }
        if (Number.isFinite(additionalData.type))
        {
            for (const candidateKey of Object.keys(questionTypes))
            {
                if (questionTypes[candidateKey] === additionalData.type)
                {
                    return candidateKey;
                }
            }
        }
        return null;
    }

    static #scoreOptionBasedQuestion(typeKey, questionItem, markingRule)
    {
        const userAnswerRaw = questionItem.getAnswer?.() ?? "";
        const expectedAnswerRaw = questionItem.getExpectedAnswer?.() ?? "";

        const userSelectedIndices = MockTestAttempt.#parseIndexSet(userAnswerRaw);
        const expectedIndices = MockTestAttempt.#parseIndexSet(expectedAnswerRaw);

        if (userSelectedIndices.size === 0)
        {
            return Number.isFinite(markingRule.unattemptedMarks) ? markingRule.unattemptedMarks : 0;
        }

        if (typeKey === "MULTIPLE_CHOICE")
        {
            const onlyExpected = userSelectedIndices.size === 1
                && expectedIndices.size === 1
                && MockTestAttempt.#firstOf(userSelectedIndices) === MockTestAttempt.#firstOf(expectedIndices);
            return onlyExpected ? markingRule.correctMarks : markingRule.wrongMarks;
        }

        const anyIncorrectSelected = [...userSelectedIndices].some((selectedIndex) => !expectedIndices.has(selectedIndex));
        const anyCorrectSelected = [...userSelectedIndices].some((selectedIndex) => expectedIndices.has(selectedIndex));
        const allCorrectSelected = [...expectedIndices].every((expectedIndex) => userSelectedIndices.has(expectedIndex));

        if (anyIncorrectSelected)
        {
            return markingRule.wrongMarks;
        }

        if (allCorrectSelected)
        {
            return markingRule.correctMarks;
        }

        if (anyCorrectSelected && Number.isFinite(markingRule.partialMarks) && markingRule.partialMarks !== 0)
        {
            const correctSelectedCount = [...userSelectedIndices].filter((selectedIndex) => expectedIndices.has(selectedIndex)).length;
            return markingRule.partialMarks * correctSelectedCount;
        }

        return markingRule.wrongMarks;
    }

    static #parseIndexSet(rawValue)
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

    static #firstOf(set)
    {
        for (const value of set)
        {
            return value;
        }
        return null;
    }

    toJson()
    {
        return {
            id: this.#id,
            attemptDate: this.#attemptDate.toISOString(),
            items: this.#items.map(item => item.toJson()),
            score: this.#score,
            maxScore: this.#maxScore,
            evaluationStatus: this.#evaluationStatus,
            evaluationInstructions: this.#evaluationInstructions,
            enableLlmMcqFeedback: this.#enableLlmMcqFeedback,
            additionalData: this.#additionalData
        };
    }

    static fromJson(json)
    {
        const items = (json.items || []).map(itemJson => MockTestItemFactory.fromJson(itemJson));
        return new MockTestAttempt(
            json.id,
            json.attemptDate,
            items,
            json.score,
            json.maxScore,
            json.additionalData || {},
            Number.isFinite(json.evaluationStatus) ? json.evaluationStatus : mockTestEvaluationStatuses.PENDING,
            typeof json.evaluationInstructions === "string" ? json.evaluationInstructions : "",
            json.enableLlmMcqFeedback === true
        );
    }
}

export default MockTestAttempt;
