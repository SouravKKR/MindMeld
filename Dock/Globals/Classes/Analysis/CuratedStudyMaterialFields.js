/**
 * Namespaced keys that the curated-study subsystem stores under each
 * curated `StudyMaterial`'s `additionalData`. Mirrors the canonical
 * definition in Main/Globals/Classes/Analysis/CuratedStudyMaterialFields.js.
 * Dock keeps a local copy so server-side query engines never sprinkle
 * string literals when filtering by curated state. The values themselves
 * are the literal property names that Mongo and the sync layer see.
 */
class CuratedStudyMaterialFields
{
    static B_CURATED = "bCurated";
    static TOPIC_NAME = "topicName";
    static TOPIC_STRENGTH = "topicStrength";
    static GENERATED_FOR_ANALYSIS_AT = "generatedForAnalysisAt";
    static BATCH_REVIEW_STATE = "batchReviewState";
    static TOPIC_INDEX = "topicIndex";
    static READ_STATE = "readState";
    static READ_AT = "readAt";
    static SESSION_OUTCOME = "sessionOutcome";

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
