const MarkingSchemeResolver = require("./MarkingSchemeResolver");
const MockTestEvaluationConstants = require("../../Constants/MockTestEvaluationConstants");
const { mockTestItemTypes } = require("../../Enumerations/MockTestItemTypes");

/**
 * Builds the Attempt.json payload the Agent's EvaluateMockTestAttempt
 * workflow reads from Persistence. Pre-resolves the marking rule for
 * every question so the Agent never has to reason about section /
 * per-type overrides — it just consumes the flat per-question rule and
 * the typeKey, scores accordingly, and writes back GradedAttempt.json.
 *
 * Also splits questions into offlineGradable and llmGradable buckets up
 * front so the endpoint can decide whether to spawn a server task at all
 * or grade everything inline (offline-only attempt → no LLM, no task).
 */
class EvaluationPayloadBuilder
{
    static build(mockTestJson, attemptJson, userEvaluationInstructions, options = {})
    {
        const enableLlmMcqFeedback = options && options.enableLlmMcqFeedback === true;
        const offlineGradableTypeKeys = new Set(MockTestEvaluationConstants.OFFLINE_GRADABLE_QUESTION_TYPES);
        const rawMarkingScheme = mockTestJson?.markingScheme || null;

        const flattenedQuestions = [];
        let currentSectionContext = null;
        let nextQuestionIndex = 0;

        for (const itemJson of (attemptJson.items || []))
        {
            if (!itemJson || typeof itemJson !== "object")
            {
                continue;
            }

            if (itemJson.type === mockTestItemTypes.SECTION)
            {
                currentSectionContext = {
                    id: itemJson.id || null,
                    label: itemJson.title || null
                };
                continue;
            }

            if (itemJson.type !== mockTestItemTypes.QUESTION)
            {
                continue;
            }

            const additionalData = itemJson.additionalData || {};
            const typeKey = MarkingSchemeResolver.resolveTypeKey(additionalData);

            if (!typeKey)
            {
                continue;
            }

            const markingRule = MarkingSchemeResolver.resolveRule(
                rawMarkingScheme,
                { ...additionalData, typeKey },
                currentSectionContext
            );

            const staticMarks = Number.isFinite(itemJson.marks) ? itemJson.marks : 0;
            const schemeCorrectMarks = Number.isFinite(markingRule.correctMarks) ? markingRule.correctMarks : 0;
            const questionMaxMarks = staticMarks > 1 ? staticMarks : (schemeCorrectMarks || staticMarks);

            flattenedQuestions.push({
                questionId: itemJson.id,
                index: nextQuestionIndex,
                type: additionalData.type,
                typeKey: typeKey,
                question: itemJson.question || "",
                expectedAnswer: itemJson.expectedAnswer ?? "",
                userAnswer: itemJson.answer ?? "",
                questionMaxMarks: questionMaxMarks,
                markingRule: markingRule,
                options: Array.isArray(additionalData.options) ? additionalData.options : null
            });

            nextQuestionIndex += 1;
        }

        const offlineGradable = flattenedQuestions.filter((row) => offlineGradableTypeKeys.has(row.typeKey));
        const llmGradable = flattenedQuestions.filter((row) => !offlineGradableTypeKeys.has(row.typeKey));

        const payload = {
            mockTestId: mockTestJson?.id || null,
            mockTestTitle: mockTestJson?.title || "Mock Test",
            attemptId: attemptJson?.id || null,
            examName: mockTestJson?.examName || "",
            subjectName: mockTestJson?.subjectName || "",
            userEvaluationInstructions: typeof userEvaluationInstructions === "string" ? userEvaluationInstructions : "",
            enableLlmMcqFeedback: enableLlmMcqFeedback,
            questions: flattenedQuestions
        };

        // When `enableLlmMcqFeedback` is on, the offline-only optimisation
        // is disabled: even an MCQ-only paper must go to the Agent so the
        // LLM can produce remarks. The endpoint reads `requiresAgentTask`
        // to decide between the inline offline path and the task-spawn
        // path.
        const requiresAgentTask = llmGradable.length > 0 || (enableLlmMcqFeedback && offlineGradable.length > 0);

        return {
            payload: payload,
            offlineGradableCount: offlineGradable.length,
            llmGradableCount: llmGradable.length,
            hasLlmGradable: llmGradable.length > 0,
            requiresAgentTask: requiresAgentTask
        };
    }
}

module.exports = EvaluationPayloadBuilder;
