const MarkingSchemeResolver = require("./MarkingSchemeResolver");
const { mockTestItemTypes } = require("../../Enumerations/MockTestItemTypes");

/**
 * Builds the TranscriptionRequest.json payload the Agent's
 * TranscribeMockTestAttempt workflow reads from Persistence for an OFFLINE
 * mock-test attempt. Flattens the mock test's blueprint into the list of
 * questions the vision model needs to map a scanned answer sheet against.
 *
 * The `questionNumber` is the 1-based running position of each QUESTION item
 * across the whole paper (sections do NOT reset it) — this is exactly the
 * number the candidate sees on-screen and is told to write on the left of each
 * answer block, so the model can map a handwritten "3." back to its question.
 * It mirrors EvaluationPayloadBuilder's running index so transcription and
 * grading agree on which question is which.
 */
class TranscriptionRequestBuilder
{
    static build(mockTestJson, attemptId, scanFileNames)
    {
        const flattenedQuestions = [];
        let nextQuestionIndex = 0;

        for (const itemJson of (mockTestJson?.items || []))
        {
            if (!itemJson || typeof itemJson !== "object")
            {
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

            flattenedQuestions.push({
                questionId: itemJson.id,
                questionNumber: String(nextQuestionIndex + 1),
                typeKey: typeKey,
                question: itemJson.question || "",
                options: Array.isArray(additionalData.options) ? additionalData.options : null
            });

            nextQuestionIndex += 1;
        }

        const payload = {
            mockTestId: mockTestJson?.id || null,
            mockTestTitle: mockTestJson?.title || "Mock Test",
            attemptId: attemptId || null,
            examName: mockTestJson?.examName || "",
            subjectName: mockTestJson?.subjectName || "",
            questions: flattenedQuestions,
            scanFiles: Array.isArray(scanFileNames) ? scanFileNames : []
        };

        return {
            payload: payload,
            questionCount: flattenedQuestions.length
        };
    }
}

module.exports = TranscriptionRequestBuilder;
