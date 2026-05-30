/**
 * Namespaced keys that the auto-analysis subsystem stores under
 * `deck.additionalData`. Centralised here so the read sites (dispatcher,
 * editor, export filter, modal) never sprinkle string literals around the
 * codebase. The values themselves are the literal property names that
 * Mongo and the sync layer see.
 *
 * Per-curated-material metadata (batch state, topic name, etc.) used to
 * live as three deck-side ID arrays on this class — see git history.
 * That state now travels with the StudyMaterial itself; see
 * `CuratedStudyMaterialFields` for the current namespace.
 */
class AutoAnalysisDeckFields
{
    static AUTO_PERFORMANCE_ANALYSIS_ENABLED       = "autoPerformanceAnalysisEnabled";
    static AUTO_GENERATE_CURATED_STUDY_ENABLED     = "autoGenerateCuratedStudyEnabled";
    static LAST_ANALYZED_AT                        = "lastAnalyzedAt";
    static LAST_ANALYSIS_TOPICS                    = "lastAnalysisTopics";
    static LAST_CURATED_BATCH_TAG                  = "lastCuratedBatchTag";
    static LAST_CURATED_BATCH_TOPICS               = "lastCuratedBatchTopics";
    static LAST_SKIPPED_DUE_TO_IN_PROGRESS_AT      = "lastSkippedDueToInProgressAt";

    /**
     * Returns every key this class owns. Used by the export filter so a
     * single iteration strips the entire surface when the user un-checks
     * "Retain Auto-Analysis Settings" on export.
     */
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

export default AutoAnalysisDeckFields;
