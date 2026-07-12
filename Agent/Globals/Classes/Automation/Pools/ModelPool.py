from Globals.Classes.Automation.Providers.GoogleEnterpriseAiProvider import GoogleEnterpriseAiProvider


class ModelPool:
    # Routing strategy (three-tier, updated 2026-05-20):
    #   gemini-2.5-flash-lite          → easy-tier classification + generation:
    #                                     VERY_EASY (all types), EASY (all types),
    #                                     and MEDIUM up to MEDIUM_SUBJECTIVE.
    #                                     Highest batch-quota headroom, lowest
    #                                     cost — sufficient for routine
    #                                     question generation where reasoning
    #                                     depth isn't the bottleneck.
    #   gemini-3.1-flash-lite  → mid-tier workhorse: MEDIUM long /
    #                                     very-long subjective, all HARD cells
    #                                     (including HARD long / very-long
    #                                     subjective which were previously on
    #                                     pro — empirically flash-lite holds up
    #                                     here and pro's batch quota is the
    #                                     scarcest resource we have).
    #   gemini-3.1-pro-preview         → reserved exclusively for VERY_HARD
    #                                     cells across all question types, plus
    #                                     a small set of non-grid models that
    #                                     are inherently reasoning-heavy
    #                                     (syllabus processing, complex study
    #                                     material).
    #
    # gemini-3-flash-preview was the previous workhorse but its batch token
    # bucket caps at 3M and was saturating during full mock-test generation.
    # Routing was shifted off it on 2026-05-18 after the Tier-1 dashboard
    # showed it at 99% utilization while Flash Lite sat at 29%.

    SYLLABUS_PROCESSING_MODEL                   = ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider)
    RELEVANT_DOMAINS_SELECTOR_MODEL             = ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider)

    MAP_TOPICS_BIENCODER_MODEL                  = "nomic-ai/nomic-embed-text-v1"
    MAP_TOPICS_CROSSENCODER_MODEL               = "cross-encoder/ms-marco-MiniLM-L-6-v2"

    EXAM_QUESTION_TYPE_DETERMINER_MODEL         = ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider)

    # Flashcard generation model map keyed by (difficulty, question_type).
    FLASHCARD_MODEL_MAP = {
        ("VERY_EASY", "MULTIPLE_CHOICE"):                  ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("VERY_EASY", "MULTIPLE_CORRECT"):                 ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("VERY_EASY", "OBJECTIVE_SINGLE_WORD_OR_PHRASE"):  ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("VERY_EASY", "SHORT_SUBJECTIVE"):                 ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("VERY_EASY", "MEDIUM_SUBJECTIVE"):                ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("VERY_EASY", "LONG_SUBJECTIVE"):                  ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("VERY_EASY", "VERY_LONG_SUBJECTIVE"):             ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),

        ("EASY", "MULTIPLE_CHOICE"):                       ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("EASY", "MULTIPLE_CORRECT"):                      ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("EASY", "OBJECTIVE_SINGLE_WORD_OR_PHRASE"):       ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("EASY", "SHORT_SUBJECTIVE"):                      ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("EASY", "MEDIUM_SUBJECTIVE"):                     ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("EASY", "LONG_SUBJECTIVE"):                       ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("EASY", "VERY_LONG_SUBJECTIVE"):                  ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),

        ("MEDIUM", "MULTIPLE_CHOICE"):                     ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("MEDIUM", "MULTIPLE_CORRECT"):                    ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("MEDIUM", "OBJECTIVE_SINGLE_WORD_OR_PHRASE"):     ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("MEDIUM", "SHORT_SUBJECTIVE"):                    ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("MEDIUM", "MEDIUM_SUBJECTIVE"):                   ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("MEDIUM", "LONG_SUBJECTIVE"):                     ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider),
        ("MEDIUM", "VERY_LONG_SUBJECTIVE"):                ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider),

        ("HARD", "MULTIPLE_CHOICE"):                       ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider),
        ("HARD", "MULTIPLE_CORRECT"):                      ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider),
        ("HARD", "OBJECTIVE_SINGLE_WORD_OR_PHRASE"):       ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider),
        ("HARD", "SHORT_SUBJECTIVE"):                      ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider),
        ("HARD", "MEDIUM_SUBJECTIVE"):                     ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider),
        ("HARD", "LONG_SUBJECTIVE"):                       ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider),
        ("HARD", "VERY_LONG_SUBJECTIVE"):                  ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider),

        ("VERY_HARD", "MULTIPLE_CHOICE"):                  ("gemini-3.1-pro-preview", GoogleEnterpriseAiProvider),
        ("VERY_HARD", "MULTIPLE_CORRECT"):                 ("gemini-3.1-pro-preview", GoogleEnterpriseAiProvider),
        ("VERY_HARD", "OBJECTIVE_SINGLE_WORD_OR_PHRASE"):  ("gemini-3.1-pro-preview", GoogleEnterpriseAiProvider),
        ("VERY_HARD", "SHORT_SUBJECTIVE"):                 ("gemini-3.1-pro-preview", GoogleEnterpriseAiProvider),
        ("VERY_HARD", "MEDIUM_SUBJECTIVE"):                ("gemini-3.1-pro-preview", GoogleEnterpriseAiProvider),
        ("VERY_HARD", "LONG_SUBJECTIVE"):                  ("gemini-3.1-pro-preview", GoogleEnterpriseAiProvider),
        ("VERY_HARD", "VERY_LONG_SUBJECTIVE"):             ("gemini-3.1-pro-preview", GoogleEnterpriseAiProvider),
    }

    FLASHCARD_AUTO_MODEL                        = ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider)

    STUDY_MATERIAL_COMPLEXITY_DETERMINER_MODEL  = ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider)
    STUDY_MATERIAL_MODEL                        = ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider)
    STUDY_MATERIAL_COMPLEX_MODEL                = ("gemini-3.1-pro-preview", GoogleEnterpriseAiProvider)

    # Mock test question generation model map keyed by (difficulty, question_type).
    MOCK_TEST_MODEL_MAP = {
        ("VERY_EASY", "MULTIPLE_CHOICE"):                  ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("VERY_EASY", "MULTIPLE_CORRECT"):                 ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("VERY_EASY", "OBJECTIVE_SINGLE_WORD_OR_PHRASE"):  ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("VERY_EASY", "SHORT_SUBJECTIVE"):                 ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("VERY_EASY", "MEDIUM_SUBJECTIVE"):                ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("VERY_EASY", "LONG_SUBJECTIVE"):                  ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("VERY_EASY", "VERY_LONG_SUBJECTIVE"):             ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),

        ("EASY", "MULTIPLE_CHOICE"):                       ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("EASY", "MULTIPLE_CORRECT"):                      ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("EASY", "OBJECTIVE_SINGLE_WORD_OR_PHRASE"):       ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("EASY", "SHORT_SUBJECTIVE"):                      ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("EASY", "MEDIUM_SUBJECTIVE"):                     ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("EASY", "LONG_SUBJECTIVE"):                       ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("EASY", "VERY_LONG_SUBJECTIVE"):                  ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),

        ("MEDIUM", "MULTIPLE_CHOICE"):                     ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("MEDIUM", "MULTIPLE_CORRECT"):                    ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("MEDIUM", "OBJECTIVE_SINGLE_WORD_OR_PHRASE"):     ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("MEDIUM", "SHORT_SUBJECTIVE"):                    ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("MEDIUM", "MEDIUM_SUBJECTIVE"):                   ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider),
        ("MEDIUM", "LONG_SUBJECTIVE"):                     ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider),
        ("MEDIUM", "VERY_LONG_SUBJECTIVE"):                ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider),

        ("HARD", "MULTIPLE_CHOICE"):                       ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider),
        ("HARD", "MULTIPLE_CORRECT"):                      ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider),
        ("HARD", "OBJECTIVE_SINGLE_WORD_OR_PHRASE"):       ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider),
        ("HARD", "SHORT_SUBJECTIVE"):                      ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider),
        ("HARD", "MEDIUM_SUBJECTIVE"):                     ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider),
        ("HARD", "LONG_SUBJECTIVE"):                       ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider),
        ("HARD", "VERY_LONG_SUBJECTIVE"):                  ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider),

        ("VERY_HARD", "MULTIPLE_CHOICE"):                  ("gemini-3.1-pro-preview", GoogleEnterpriseAiProvider),
        ("VERY_HARD", "MULTIPLE_CORRECT"):                 ("gemini-3.1-pro-preview", GoogleEnterpriseAiProvider),
        ("VERY_HARD", "OBJECTIVE_SINGLE_WORD_OR_PHRASE"):  ("gemini-3.1-pro-preview", GoogleEnterpriseAiProvider),
        ("VERY_HARD", "SHORT_SUBJECTIVE"):                 ("gemini-3.1-pro-preview", GoogleEnterpriseAiProvider),
        ("VERY_HARD", "MEDIUM_SUBJECTIVE"):                ("gemini-3.1-pro-preview", GoogleEnterpriseAiProvider),
        ("VERY_HARD", "LONG_SUBJECTIVE"):                  ("gemini-3.1-pro-preview", GoogleEnterpriseAiProvider),
        ("VERY_HARD", "VERY_LONG_SUBJECTIVE"):             ("gemini-3.1-pro-preview", GoogleEnterpriseAiProvider),
    }

    MOCK_TEST_AUTO_MODEL                        = ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider)

    # Cheap, fast model used to grade subjective mock-test answers in batches.
    # Grading is a comparatively shallow task — the LLM is given the expected
    # answer + marking rule and just needs to award a score and optionally
    # write a short remark. flash-lite holds up here and keeps per-batch cost
    # low enough that the (future) credit deduction won't sting.
    MOCK_TEST_GRADING_MODEL = ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider)

    # Vision model that reads a student's scanned, handwritten answer sheet for
    # an OFFLINE mock-test attempt and transcribes each answer into per-question
    # HTML, mapping answers to questions by the question number the student
    # writes on the left of each block. Transcription (reading handwriting,
    # honouring layout, preserving lists/numbering) is a materially harder
    # multimodal task than the text-only grading pass, so this uses the fuller
    # flash model rather than flash-lite — a misread here silently corrupts the
    # candidate's answer before it is ever graded.
    MOCK_TEST_TRANSCRIPTION_MODEL = ("gemini-2.5-flash", GoogleEnterpriseAiProvider)

    IMAGE_VALIDATION_MODEL = ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider)
    IMAGE_VERIFICATION_MODEL = ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider)
