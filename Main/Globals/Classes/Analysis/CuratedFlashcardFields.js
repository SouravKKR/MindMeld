/**
 * Namespaced keys that the curated-study subsystem stores under each
 * curated `Card`'s `additionalData`. Centralised here so every read /
 * write site (generator, controller, session, archive, runtime guard)
 * refers to the canonical field names without sprinkling string literals
 * across the codebase. The values themselves are the literal property
 * names that Mongo and the sync layer see.
 *
 * `B_CURATED` is the single flag every card-loading site filters on to
 * keep curated cards out of FSRS / Spaced Repetition / Mastery.
 */
class CuratedFlashcardFields
{
    static B_CURATED = "bCurated";
    static STUDY_MATERIAL_ID = "studyMaterialId";
    static TOPIC_NAME = "topicName";
    static GENERATED_FOR_ANALYSIS_AT = "generatedForAnalysisAt";
    static LAST_CURATED_GRADE = "lastCuratedGrade";
    static LAST_CURATED_GRADED_AT = "lastCuratedGradedAt";
    static SYLLABUS_POSITION_IN_TOPIC = "syllabusPositionInTopic";

    /**
     * Returns every key this class owns. Useful for any future export
     * filter that needs to strip the curated card surface in one pass.
     */
    static getAllKeys()
    {
        return [
            CuratedFlashcardFields.B_CURATED,
            CuratedFlashcardFields.STUDY_MATERIAL_ID,
            CuratedFlashcardFields.TOPIC_NAME,
            CuratedFlashcardFields.GENERATED_FOR_ANALYSIS_AT,
            CuratedFlashcardFields.LAST_CURATED_GRADE,
            CuratedFlashcardFields.LAST_CURATED_GRADED_AT,
            CuratedFlashcardFields.SYLLABUS_POSITION_IN_TOPIC,
        ];
    }
}

export default CuratedFlashcardFields;
