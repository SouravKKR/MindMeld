/**
 * Namespaced keys that the auto-analysis subsystem stores under
 * `deck.additionalData`. Mirrors the canonical definition in
 * Main/Globals/Classes/Analysis/AutoAnalysisDeckFields.js. Dock keeps a
 * local copy so server-side query engines never sprinkle string
 * literals when filtering by analysis state. The values themselves are
 * the literal property names that Mongo and the sync layer see.
 */
class AutoAnalysisDeckFields
{
    static AUTO_PERFORMANCE_ANALYSIS_ENABLED = "autoPerformanceAnalysisEnabled";
    static AUTO_GENERATE_CURATED_STUDY_ENABLED = "autoGenerateCuratedStudyEnabled";
    static LAST_ANALYZED_AT = "lastAnalyzedAt";
    static LAST_ANALYSIS_TOPICS = "lastAnalysisTopics";
    static LAST_CURATED_BATCH_TAG = "lastCuratedBatchTag";
    static LAST_CURATED_BATCH_TOPICS = "lastCuratedBatchTopics";
    static LAST_SKIPPED_DUE_TO_IN_PROGRESS_AT = "lastSkippedDueToInProgressAt";

    static getAllKeys()
    {
        return [
            AutoAnalysisDeckFields.AUTO_PERFORMANCE_ANALYSIS_ENABLED,
            AutoAnalysisDeckFields.AUTO_GENERATE_CURATED_STUDY_ENABLED,
            AutoAnalysisDeckFields.LAST_ANALYZED_AT,
            AutoAnalysisDeckFields.LAST_ANALYSIS_TOPICS,
            AutoAnalysisDeckFields.LAST_CURATED_BATCH_TAG,
            AutoAnalysisDeckFields.LAST_CURATED_BATCH_TOPICS,
            AutoAnalysisDeckFields.LAST_SKIPPED_DUE_TO_IN_PROGRESS_AT,
        ];
    }
}

module.exports = AutoAnalysisDeckFields;
