const EvaluationPayloadBuilder = require("./EvaluationPayloadBuilder");
const OfflineQuestionGrader = require("./OfflineQuestionGrader");

/**
 * Server-side offline grader. Used when the attempt contains only
 * deterministically-gradable question types (MCQ + MULTIPLE_CORRECT) so
 * we never need to spawn an Agent task: the Dock builds a graded-attempt
 * document in the same shape EvaluateMockTestAttempt.py would have
 * produced, and feeds it directly into GradedAttemptApplier.
 *
 * Produces the document — does NOT mutate the mockTest. The caller
 * is responsible for invoking GradedAttemptApplier.apply afterwards.
 */
class OfflineAttemptGrader
{
    static gradeAttempt(mockTestJson, attemptJson)
    {
        const buildResult = EvaluationPayloadBuilder.build(mockTestJson, attemptJson, "");

        let totalScore = 0;
        let totalMaxScore = 0;
        const gradedQuestions = [];

        for (const questionRow of buildResult.payload.questions)
        {
            const awardedScore = OfflineQuestionGrader.scoreOptionBased(
                questionRow.typeKey,
                questionRow.userAnswer,
                questionRow.expectedAnswer,
                questionRow.markingRule
            );

            totalScore += awardedScore;
            totalMaxScore += Number.isFinite(questionRow.questionMaxMarks) ? questionRow.questionMaxMarks : 0;

            gradedQuestions.push({
                questionId: questionRow.questionId,
                index: questionRow.index,
                score: awardedScore,
                remarks: "",
                gradingSource: "offline"
            });
        }

        return {
            mockTestId: mockTestJson?.id || null,
            attemptId: attemptJson?.id || null,
            generatedAt: new Date().toISOString(),
            totalScore: totalScore,
            maxScore: totalMaxScore,
            questions: gradedQuestions,
            summary: {
                offline_graded_count: gradedQuestions.length,
                auto_full_via_normalized_equal: 0,
                auto_full_via_semantic: 0,
                sent_to_llm_count: 0
            }
        };
    }
}

module.exports = OfflineAttemptGrader;
