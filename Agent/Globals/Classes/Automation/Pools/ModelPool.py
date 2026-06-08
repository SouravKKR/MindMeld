from Globals.Classes.Automation.Providers.GeminiProvider import GeminiProvider


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

    SYLLABUS_PROCESSING_MODEL                   = ("gemini-3.1-flash-lite", GeminiProvider)
    RELEVANT_DOMAINS_SELECTOR_MODEL             = ("gemini-3.1-flash-lite", GeminiProvider)

    MAP_TOPICS_BIENCODER_MODEL                  = "nomic-ai/nomic-embed-text-v1"
    MAP_TOPICS_CROSSENCODER_MODEL               = "cross-encoder/ms-marco-MiniLM-L-6-v2"

    EXAM_QUESTION_TYPE_DETERMINER_MODEL         = ("gemini-3.1-flash-lite", GeminiProvider)

    # Flashcard generation model map keyed by (difficulty, question_type).
    FLASHCARD_MODEL_MAP = {
        ("VERY_EASY", "MULTIPLE_CHOICE"):                  ("gemini-2.5-flash-lite", GeminiProvider),
        ("VERY_EASY", "MULTIPLE_CORRECT"):                 ("gemini-2.5-flash-lite", GeminiProvider),
        ("VERY_EASY", "OBJECTIVE_SINGLE_WORD_OR_PHRASE"):  ("gemini-2.5-flash-lite", GeminiProvider),
        ("VERY_EASY", "SHORT_SUBJECTIVE"):                 ("gemini-2.5-flash-lite", GeminiProvider),
        ("VERY_EASY", "MEDIUM_SUBJECTIVE"):                ("gemini-2.5-flash-lite", GeminiProvider),
        ("VERY_EASY", "LONG_SUBJECTIVE"):                  ("gemini-2.5-flash-lite", GeminiProvider),
        ("VERY_EASY", "VERY_LONG_SUBJECTIVE"):             ("gemini-2.5-flash-lite", GeminiProvider),

        ("EASY", "MULTIPLE_CHOICE"):                       ("gemini-2.5-flash-lite", GeminiProvider),
        ("EASY", "MULTIPLE_CORRECT"):                      ("gemini-2.5-flash-lite", GeminiProvider),
        ("EASY", "OBJECTIVE_SINGLE_WORD_OR_PHRASE"):       ("gemini-2.5-flash-lite", GeminiProvider),
        ("EASY", "SHORT_SUBJECTIVE"):                      ("gemini-2.5-flash-lite", GeminiProvider),
        ("EASY", "MEDIUM_SUBJECTIVE"):                     ("gemini-2.5-flash-lite", GeminiProvider),
        ("EASY", "LONG_SUBJECTIVE"):                       ("gemini-2.5-flash-lite", GeminiProvider),
        ("EASY", "VERY_LONG_SUBJECTIVE"):                  ("gemini-2.5-flash-lite", GeminiProvider),

        ("MEDIUM", "MULTIPLE_CHOICE"):                     ("gemini-2.5-flash-lite", GeminiProvider),
        ("MEDIUM", "MULTIPLE_CORRECT"):                    ("gemini-2.5-flash-lite", GeminiProvider),
        ("MEDIUM", "OBJECTIVE_SINGLE_WORD_OR_PHRASE"):     ("gemini-2.5-flash-lite", GeminiProvider),
        ("MEDIUM", "SHORT_SUBJECTIVE"):                    ("gemini-2.5-flash-lite", GeminiProvider),
        ("MEDIUM", "MEDIUM_SUBJECTIVE"):                   ("gemini-2.5-flash-lite", GeminiProvider),
        ("MEDIUM", "LONG_SUBJECTIVE"):                     ("gemini-3.1-flash-lite", GeminiProvider),
        ("MEDIUM", "VERY_LONG_SUBJECTIVE"):                ("gemini-3.1-flash-lite", GeminiProvider),

        ("HARD", "MULTIPLE_CHOICE"):                       ("gemini-3.1-flash-lite", GeminiProvider),
        ("HARD", "MULTIPLE_CORRECT"):                      ("gemini-3.1-flash-lite", GeminiProvider),
        ("HARD", "OBJECTIVE_SINGLE_WORD_OR_PHRASE"):       ("gemini-3.1-flash-lite", GeminiProvider),
        ("HARD", "SHORT_SUBJECTIVE"):                      ("gemini-3.1-flash-lite", GeminiProvider),
        ("HARD", "MEDIUM_SUBJECTIVE"):                     ("gemini-3.1-flash-lite", GeminiProvider),
        ("HARD", "LONG_SUBJECTIVE"):                       ("gemini-3.1-flash-lite", GeminiProvider),
        ("HARD", "VERY_LONG_SUBJECTIVE"):                  ("gemini-3.1-flash-lite", GeminiProvider),

        ("VERY_HARD", "MULTIPLE_CHOICE"):                  ("gemini-3.1-pro-preview", GeminiProvider),
        ("VERY_HARD", "MULTIPLE_CORRECT"):                 ("gemini-3.1-pro-preview", GeminiProvider),
        ("VERY_HARD", "OBJECTIVE_SINGLE_WORD_OR_PHRASE"):  ("gemini-3.1-pro-preview", GeminiProvider),
        ("VERY_HARD", "SHORT_SUBJECTIVE"):                 ("gemini-3.1-pro-preview", GeminiProvider),
        ("VERY_HARD", "MEDIUM_SUBJECTIVE"):                ("gemini-3.1-pro-preview", GeminiProvider),
        ("VERY_HARD", "LONG_SUBJECTIVE"):                  ("gemini-3.1-pro-preview", GeminiProvider),
        ("VERY_HARD", "VERY_LONG_SUBJECTIVE"):             ("gemini-3.1-pro-preview", GeminiProvider),
    }

    FLASHCARD_AUTO_MODEL                        = ("gemini-3.1-flash-lite", GeminiProvider)

    STUDY_MATERIAL_COMPLEXITY_DETERMINER_MODEL  = ("gemini-3.1-flash-lite", GeminiProvider)
    STUDY_MATERIAL_MODEL                        = ("gemini-3.1-flash-lite", GeminiProvider)
    STUDY_MATERIAL_COMPLEX_MODEL                = ("gemini-3.1-pro-preview", GeminiProvider)

    # Mock test question generation model map keyed by (difficulty, question_type).
    MOCK_TEST_MODEL_MAP = {
        ("VERY_EASY", "MULTIPLE_CHOICE"):                  ("gemini-2.5-flash-lite", GeminiProvider),
        ("VERY_EASY", "MULTIPLE_CORRECT"):                 ("gemini-2.5-flash-lite", GeminiProvider),
        ("VERY_EASY", "OBJECTIVE_SINGLE_WORD_OR_PHRASE"):  ("gemini-2.5-flash-lite", GeminiProvider),
        ("VERY_EASY", "SHORT_SUBJECTIVE"):                 ("gemini-2.5-flash-lite", GeminiProvider),
        ("VERY_EASY", "MEDIUM_SUBJECTIVE"):                ("gemini-2.5-flash-lite", GeminiProvider),
        ("VERY_EASY", "LONG_SUBJECTIVE"):                  ("gemini-2.5-flash-lite", GeminiProvider),
        ("VERY_EASY", "VERY_LONG_SUBJECTIVE"):             ("gemini-2.5-flash-lite", GeminiProvider),

        ("EASY", "MULTIPLE_CHOICE"):                       ("gemini-2.5-flash-lite", GeminiProvider),
        ("EASY", "MULTIPLE_CORRECT"):                      ("gemini-2.5-flash-lite", GeminiProvider),
        ("EASY", "OBJECTIVE_SINGLE_WORD_OR_PHRASE"):       ("gemini-2.5-flash-lite", GeminiProvider),
        ("EASY", "SHORT_SUBJECTIVE"):                      ("gemini-2.5-flash-lite", GeminiProvider),
        ("EASY", "MEDIUM_SUBJECTIVE"):                     ("gemini-2.5-flash-lite", GeminiProvider),
        ("EASY", "LONG_SUBJECTIVE"):                       ("gemini-2.5-flash-lite", GeminiProvider),
        ("EASY", "VERY_LONG_SUBJECTIVE"):                  ("gemini-2.5-flash-lite", GeminiProvider),

        ("MEDIUM", "MULTIPLE_CHOICE"):                     ("gemini-2.5-flash-lite", GeminiProvider),
        ("MEDIUM", "MULTIPLE_CORRECT"):                    ("gemini-2.5-flash-lite", GeminiProvider),
        ("MEDIUM", "OBJECTIVE_SINGLE_WORD_OR_PHRASE"):     ("gemini-2.5-flash-lite", GeminiProvider),
        ("MEDIUM", "SHORT_SUBJECTIVE"):                    ("gemini-2.5-flash-lite", GeminiProvider),
        ("MEDIUM", "MEDIUM_SUBJECTIVE"):                   ("gemini-2.5-flash-lite", GeminiProvider),
        ("MEDIUM", "LONG_SUBJECTIVE"):                     ("gemini-3.1-flash-lite", GeminiProvider),
        ("MEDIUM", "VERY_LONG_SUBJECTIVE"):                ("gemini-3.1-flash-lite", GeminiProvider),

        ("HARD", "MULTIPLE_CHOICE"):                       ("gemini-3.1-flash-lite", GeminiProvider),
        ("HARD", "MULTIPLE_CORRECT"):                      ("gemini-3.1-flash-lite", GeminiProvider),
        ("HARD", "OBJECTIVE_SINGLE_WORD_OR_PHRASE"):       ("gemini-3.1-flash-lite", GeminiProvider),
        ("HARD", "SHORT_SUBJECTIVE"):                      ("gemini-3.1-flash-lite", GeminiProvider),
        ("HARD", "MEDIUM_SUBJECTIVE"):                     ("gemini-3.1-flash-lite", GeminiProvider),
        ("HARD", "LONG_SUBJECTIVE"):                       ("gemini-3.1-flash-lite", GeminiProvider),
        ("HARD", "VERY_LONG_SUBJECTIVE"):                  ("gemini-3.1-flash-lite", GeminiProvider),

        ("VERY_HARD", "MULTIPLE_CHOICE"):                  ("gemini-3.1-pro-preview", GeminiProvider),
        ("VERY_HARD", "MULTIPLE_CORRECT"):                 ("gemini-3.1-pro-preview", GeminiProvider),
        ("VERY_HARD", "OBJECTIVE_SINGLE_WORD_OR_PHRASE"):  ("gemini-3.1-pro-preview", GeminiProvider),
        ("VERY_HARD", "SHORT_SUBJECTIVE"):                 ("gemini-3.1-pro-preview", GeminiProvider),
        ("VERY_HARD", "MEDIUM_SUBJECTIVE"):                ("gemini-3.1-pro-preview", GeminiProvider),
        ("VERY_HARD", "LONG_SUBJECTIVE"):                  ("gemini-3.1-pro-preview", GeminiProvider),
        ("VERY_HARD", "VERY_LONG_SUBJECTIVE"):             ("gemini-3.1-pro-preview", GeminiProvider),
    }

    MOCK_TEST_AUTO_MODEL                        = ("gemini-3.1-flash-lite", GeminiProvider)

    # Cheap, fast model used to grade subjective mock-test answers in batches.
    # Grading is a comparatively shallow task — the LLM is given the expected
    # answer + marking rule and just needs to award a score and optionally
    # write a short remark. flash-lite holds up here and keeps per-batch cost
    # low enough that the (future) credit deduction won't sting.
    MOCK_TEST_GRADING_MODEL = ("gemini-2.5-flash-lite", GeminiProvider)

    IMAGE_VALIDATION_MODEL                      = ("gemini-2.5-flash-lite", GeminiProvider)
    IMAGE_VERIFICATION_MODEL                    = ("gemini-3.1-flash-lite", GeminiProvider)
