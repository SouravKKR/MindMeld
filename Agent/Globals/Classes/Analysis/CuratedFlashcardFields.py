class CuratedFlashcardFields:
    """
    Namespaced keys that the curated-study subsystem stores under each
    curated Card's additionalData. Mirrors the JS counterpart in
    Main/Globals/Classes/Analysis/CuratedFlashcardFields.js. The values
    are the literal property names that Mongo and the sync layer see.

    B_CURATED is the single flag every card-loading site filters on to
    keep curated cards out of FSRS / Spaced Repetition / Mastery.
    """

    B_CURATED = "bCurated"
    STUDY_MATERIAL_ID = "studyMaterialId"
    TOPIC_NAME = "topicName"
    GENERATED_FOR_ANALYSIS_AT = "generatedForAnalysisAt"
    LAST_CURATED_GRADE = "lastCuratedGrade"
    LAST_CURATED_GRADED_AT = "lastCuratedGradedAt"
    SYLLABUS_POSITION_IN_TOPIC = "syllabusPositionInTopic"

    @staticmethod
    def get_all_keys():
        return [
            CuratedFlashcardFields.B_CURATED,
            CuratedFlashcardFields.STUDY_MATERIAL_ID,
            CuratedFlashcardFields.TOPIC_NAME,
            CuratedFlashcardFields.GENERATED_FOR_ANALYSIS_AT,
            CuratedFlashcardFields.LAST_CURATED_GRADE,
            CuratedFlashcardFields.LAST_CURATED_GRADED_AT,
            CuratedFlashcardFields.SYLLABUS_POSITION_IN_TOPIC,
        ]
