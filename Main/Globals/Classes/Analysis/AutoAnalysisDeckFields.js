/**
 * Namespaced keys that the auto-analysis subsystem stores under
 * `deck.additionalData`. Centralised here so the read sites (dispatcher,
 * editor, export filter, modal) never sprinkle string literals around the
 * codebase. The values themselves are the literal property names that
 * Mongo and the sync layer see.
 */
class AutoAnalysisDeckFields
{
    static AUTO_PERFORMANCE_ANALYSIS_ENABLED       = "autoPerformanceAnalysisEnabled";
    static AUTO_GENERATE_CURATED_STUDY_ENABLED     = "autoGenerateCuratedStudyEnabled";
    static LAST_ANALYZED_AT                        = "lastAnalyzedAt";
    static LAST_ANALYSIS_TOPICS                    = "lastAnalysisTopics";
    static CURATED_STUDY_MATERIAL_IDS              = "curatedStudyMaterialIds";
    static ARCHIVED_CURATED_STUDY_MATERIAL_IDS     = "archivedCuratedStudyMaterialIds";
    static PENDING_BATCH_REVIEW_MATERIAL_IDS       = "pendingBatchReviewMaterialIds";

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
            AutoAnalysisDeckFields.CURATED_STUDY_MATERIAL_IDS,
            AutoAnalysisDeckFields.ARCHIVED_CURATED_STUDY_MATERIAL_IDS,
            AutoAnalysisDeckFields.PENDING_BATCH_REVIEW_MATERIAL_IDS,
        ];
    }
}

export default AutoAnalysisDeckFields;
