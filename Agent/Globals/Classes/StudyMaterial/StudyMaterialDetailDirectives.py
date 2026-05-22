from Globals.Enumerations.StudyMaterialDetailLevels import StudyMaterialDetailLevels


class StudyMaterialDetailDirectives:
    """
    Lookup table mapping a StudyMaterialDetailLevels enum value to the
    natural-language directive injected into the study-material generation
    prompt. The directives are deliberately specific so the LLM treats each
    tier as a different deliverable rather than a vague "depth knob".
    """

    SUMMARY_DIRECTIVE = (
        "Produce a crisp, quick-revision-style summary for use right before an exam. "
        "Strongly prefer bulleted lists, numbered lists, well-formatted tables, key "
        "definitions, and formulas. Do NOT write large paragraphs; short-to-medium "
        "paragraphs are acceptable only when bullets/tables genuinely won't carry the "
        "idea. Match the visual quality of the existing study materials (clean "
        "point-form structure, illustrations/diagrams where they aid recall). Skip "
        "background, derivations, and prose explanations of details a student would "
        "already know."
    )

    STANDARD_DIRECTIVE = (
        "Produce a balanced explanation suitable for a student preparing for an exam. "
        "Include core theory, worked examples, and clear definitions. Aim for "
        "sufficiency over completeness — enough depth to study from, without the "
        "exhaustive coverage of a comprehensive treatment."
    )

    COMPREHENSIVE_DIRECTIVE = (
        "Produce an in-depth treatment with full background, advanced examples, edge "
        "cases, derivations where relevant, and cross-references between related "
        "concepts. The reader should come away with a deep understanding suitable "
        "for the most demanding written exams."
    )

    __DIRECTIVE_BY_LEVEL = {
        StudyMaterialDetailLevels.SUMMARY: SUMMARY_DIRECTIVE,
        StudyMaterialDetailLevels.STANDARD: STANDARD_DIRECTIVE,
        StudyMaterialDetailLevels.COMPREHENSIVE: COMPREHENSIVE_DIRECTIVE,
    }

    @classmethod
    def get_directive(cls, detail_level: int) -> str:
        try:
            return cls.__DIRECTIVE_BY_LEVEL[StudyMaterialDetailLevels(detail_level)]
        except (ValueError, KeyError):
            return cls.STANDARD_DIRECTIVE
