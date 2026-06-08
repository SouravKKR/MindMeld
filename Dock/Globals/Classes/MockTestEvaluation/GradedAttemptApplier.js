const { mockTestItemTypes } = require("../../Enumerations/MockTestItemTypes");
const { mockTestEvaluationStatuses } = require("../../Enumerations/MockTestEvaluationStatuses");

/**
 * Applies the Agent's GradedAttempt.json output (or a server-side offline
 * grading result that uses the same shape) back to the mock test's JSON
 * representation. Mutates the attempt in-place:
 *
 *   - Sets per-question `score` and `remarks`
 *   - Computes and sets the attempt-level `score` and `maxScore`
 *   - Flips `evaluationStatus` to COMPLETED (or FAILED on `failed=true`)
 *   - Touches the lifecycle so the next sync pulls the updated record
 *
 * Returns the mutated mockTestJson so callers can persist it back.
 */
class GradedAttemptApplier
{
    static apply(mockTestJson, attemptId, gradedDocument, { failed = false } = {})
    {
        if (!mockTestJson || !attemptId || !gradedDocument)
        {
            return mockTestJson;
        }

        const history = Array.isArray(mockTestJson.history) ? mockTestJson.history : [];
        const attempt = history.find((attemptJson) => attemptJson && attemptJson.id === attemptId);

        if (!attempt)
        {
            return mockTestJson;
        }

        const gradedByQuestionId = new Map();
        const gradedByIndex = new Map();
        for (const gradedEntry of (gradedDocument.questions || []))
        {
            if (gradedEntry?.questionId)
            {
                gradedByQuestionId.set(gradedEntry.questionId, gradedEntry);
            }
            if (Number.isFinite(gradedEntry?.index))
            {
                gradedByIndex.set(gradedEntry.index, gradedEntry);
            }
        }

        let runningQuestionIndex = 0;
        let totalScore = 0;
        let totalMaxScore = 0;

        for (const itemJson of (attempt.items || []))
        {
            if (!itemJson || itemJson.type !== mockTestItemTypes.QUESTION)
            {
                continue;
            }

            const graded = gradedByQuestionId.get(itemJson.id) ?? gradedByIndex.get(runningQuestionIndex);

            if (graded)
            {
                itemJson.score = Number.isFinite(graded.score) ? graded.score : 0;
                itemJson.remarks = typeof graded.remarks === "string" ? graded.remarks : "";
            }
            else
            {
                itemJson.score = 0;
                itemJson.remarks = "";
            }

            totalScore += Number.isFinite(itemJson.score) ? itemJson.score : 0;
            totalMaxScore += Number.isFinite(itemJson.marks) ? itemJson.marks : 0;
            runningQuestionIndex += 1;
        }

        attempt.score = Number.isFinite(gradedDocument.totalScore) ? gradedDocument.totalScore : totalScore;
        attempt.maxScore = Number.isFinite(gradedDocument.maxScore) ? gradedDocument.maxScore : totalMaxScore;

        // Stamp the failed-cell summary onto the attempt so the Answer
        // Key page can flag partial failures to the candidate instead
        // of pretending everything completed cleanly. A non-zero
        // failedQuestionCount means some questions silently fell back
        // to unattempted scoring because the LLM call broke — the
        // candidate didn't score 0, the grader did.
        const summary = (gradedDocument && typeof gradedDocument.summary === "object") ? gradedDocument.summary : {};
        const failedQuestionCount = Number.isFinite(summary.failed_question_count) ? summary.failed_question_count : 0;
        const failedCellsCount = Number.isFinite(summary.failed_cells_count) ? summary.failed_cells_count : 0;
        const previousAdditional = (attempt.additionalData && typeof attempt.additionalData === "object") ? attempt.additionalData : {};
        attempt.additionalData = {
            ...previousAdditional,
            evaluationFailedQuestionCount: failedQuestionCount,
            evaluationFailedCellsCount: failedCellsCount,
        };

        attempt.evaluationStatus = failed ? mockTestEvaluationStatuses.FAILED : mockTestEvaluationStatuses.COMPLETED;

        if (mockTestJson.lifecycle)
        {
            mockTestJson.lifecycle.lastModified = new Date().toISOString();
        }

        return mockTestJson;
    }
}

module.exports = GradedAttemptApplier;
