/**
 * Namespaced keys that the auto-analysis subsystem stores under each
 * curated `StudyMaterial`'s `additionalData`. Centralised here so every
 * read / write site (generator, dispatcher, browser, batch-review modal,
 * clear-analysis-data path) refers to the canonical field names without
 * sprinkling string literals across the codebase. The values themselves
 * are the literal property names that Mongo and the sync layer see.
 */
class CuratedStudyMaterialFields
{
    static B_CURATED                  = "bCurated";
    static TOPIC_NAME                 = "topicName";
    static TOPIC_STRENGTH             = "topicStrength";
    static GENERATED_FOR_ANALYSIS_AT  = "generatedForAnalysisAt";
    static BATCH_REVIEW_STATE         = "batchReviewState";
    static TOPIC_INDEX                = "topicIndex";
    static READ_STATE                 = "readState";
    static READ_AT                    = "readAt";
    static SESSION_OUTCOME            = "sessionOutcome";

    /**
     * Returns every key this class owns. Useful for any future export
     * filter that needs to strip the curated surface in one pass.
     */
    static getAllKeys()
    {
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
        ];
    }
}

export default CuratedStudyMaterialFields;
