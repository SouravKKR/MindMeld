class AutoAnalysisDeckFields:
    """
    Namespaced keys that the auto-analysis subsystem stores under
    deck.additionalData. Mirrors the JS counterpart in
    Main/Globals/Classes/Analysis/AutoAnalysisDeckFields.js. The values
    are the literal property names that Mongo and the sync layer see.

    Previously these constants were inlined as class statics on
    AnalyzeDeckPerformance; they were extracted here so the curated
    pipeline (analysis, generation, controller) can share one source of
    truth.
    """

    AUTO_PERFORMANCE_ANALYSIS_ENABLED = "autoPerformanceAnalysisEnabled"
    AUTO_GENERATE_CURATED_STUDY_ENABLED = "autoGenerateCuratedStudyEnabled"
    LAST_ANALYZED_AT = "lastAnalyzedAt"
    LAST_ANALYSIS_TOPICS = "lastAnalysisTopics"
    LAST_CURATED_BATCH_TAG = "lastCuratedBatchTag"
    LAST_CURATED_BATCH_TOPICS = "lastCuratedBatchTopics"
    LAST_SKIPPED_DUE_TO_IN_PROGRESS_AT = "lastSkippedDueToInProgressAt"

    @staticmethod
    def get_all_keys():
        return [
            AutoAnalysisDeckFields.AUTO_PERFORMANCE_ANALYSIS_ENABLED,
            AutoAnalysisDeckFields.AUTO_GENERATE_CURATED_STUDY_ENABLED,
            AutoAnalysisDeckFields.LAST_ANALYZED_AT,
            AutoAnalysisDeckFields.LAST_ANALYSIS_TOPICS,
            AutoAnalysisDeckFields.LAST_CURATED_BATCH_TAG,
            AutoAnalysisDeckFields.LAST_CURATED_BATCH_TOPICS,
            AutoAnalysisDeckFields.LAST_SKIPPED_DUE_TO_IN_PROGRESS_AT,
        ]
