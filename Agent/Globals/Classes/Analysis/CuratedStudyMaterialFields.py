class CuratedStudyMaterialFields:
    """
    Namespaced keys that the auto-analysis subsystem stores under each
    curated StudyMaterial's additionalData. Mirrors the JS counterpart in
    Main/Globals/Classes/Analysis/CuratedStudyMaterialFields.js. The
    values are the literal property names that Mongo and the sync layer
    see.
    """

    B_CURATED                 = "bCurated"
    TOPIC_NAME                = "topicName"
    TOPIC_STRENGTH            = "topicStrength"
    GENERATED_FOR_ANALYSIS_AT = "generatedForAnalysisAt"
    BATCH_REVIEW_STATE        = "batchReviewState"
    TOPIC_INDEX               = "topicIndex"
    READ_STATE                = "readState"
    READ_AT                   = "readAt"
    SESSION_OUTCOME           = "sessionOutcome"

    @staticmethod
    def get_all_keys():
        return [
            CuratedStudyMaterialFields.B_CURATED,
            CuratedStudyMaterialFields.TOPIC_NAME,
            CuratedStudyMaterialFields.TOPIC_STRENGTH,
            CuratedStudyMaterialFields.GENERATED_FOR_ANALYSIS_AT,
            CuratedStudyMaterialFields.BATCH_REVIEW_STATE,
            CuratedStudyMaterialFields.TOPIC_INDEX,
            CuratedStudyMaterialFields.READ_STATE,
            CuratedStudyMaterialFields.READ_AT,
            CuratedStudyMaterialFields.SESSION_OUTCOME,
        ]
