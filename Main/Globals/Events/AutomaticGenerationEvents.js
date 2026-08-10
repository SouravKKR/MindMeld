class AutomaticGenerationEvents
{
    static ON_INFORMATION_SOURCE_UPLOADED = "ON_INFORMATION_SOURCE_UPLOADED";
    // Fired by InformationSourceCard once an upload's server-side OCR has finished
    // (task COMPLETED). Carries the server-resolved InformationSource. The selector
    // waits for this — not the raw xhr "load" — before making the source usable, so
    // a source whose OCR is still running can't be fed into a generation.
    static ON_INFORMATION_SOURCE_READY = "ON_INFORMATION_SOURCE_READY";
    static ON_SOURCES_CHANGED = "ON_SOURCES_CHANGED";
    static ON_INFORMATION_SOURCES_CHANGED = "ON_INFORMATION_SOURCES_CHANGED";
    static ON_IMAGE_SOURCES_CHANGED = "ON_IMAGE_SOURCES_CHANGED";
    static ON_SUBJECT_NAME_CHANGED = "ON_SUBJECT_NAME_CHANGED";
    static ON_EXAM_NAME_CHANGED = "ON_EXAM_NAME_CHANGED";
    static ON_ENHANCE_IMAGES_CHANGED = "ON_ENHANCE_IMAGES_CHANGED";
    static ON_INHERIT_IMAGE_CURRICULUM_CHANGED = "ON_INHERIT_IMAGE_CURRICULUM_CHANGED";
    static ON_DESCRIPTION_CHANGED = "ON_DESCRIPTION_CHANGED";
    static ON_EXISTING_INFORMATION_SOURCE_SELECTED = "ON_EXISTING_INFORMATION_SOURCE_SELECTED";
    static ON_TEMPLATED_FIELD_CHANGED              = "ON_TEMPLATED_FIELD_CHANGED";
    static ON_CAPTURE_IMAGES_CHANGED               = "ON_CAPTURE_IMAGES_CHANGED";
    static ON_GENERATION_MODE_CHANGED              = "ON_GENERATION_MODE_CHANGED";
    // Raised by MockTestSectionStructureFields whenever a section is added,
    // removed or edited. MockTestGenerationFields listens so it can hide the
    // paper-level question-type weightage once sections exist — with sections
    // configured, those two controls would be two answers to one question.
    static ON_SECTION_STRUCTURE_CHANGED = "ON_SECTION_STRUCTURE_CHANGED";
}

export default AutomaticGenerationEvents;
