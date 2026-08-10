from Globals.Classes.Automation.Providers.GoogleEnterpriseAiProvider import GoogleEnterpriseAiProvider
from Globals.Classes.Automation.Providers.AnthropicProvider import AnthropicProvider


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

    # Adjudicates intent for the content guardrail: given a flagged word and the
    # 25 words either side of it, is the usage abusive or is it clinical, quoted
    # or otherwise fine? Deliberately the cheapest tier. This runs on top of a
    # call the user already paid for, every flagged response pays for it, and the
    # judgement is a narrow one a small model makes as well as a large one — the
    # hard part (deciding WHICH words to ask about) is the deterministic scan
    # that already happened. All items in a response are batched into one call,
    # so the added cost is one short flash-lite request, not one per match.
    CONTENT_GUARDRAIL_MODEL = ("gemini-2.5-flash-lite", GoogleEnterpriseAiProvider)

    # ── Paid-deck generation mode (admin-only) ─────────────────────────────────
    #
    # Content the platform SELLS is first-party commercial material, so the
    # stages where a wrong output is expensive in a way volume cannot offset are
    # held on the premium tier. That is now three stages, not six:
    #
    #   - Symbolic diagrams are code, not pixels: geometry, labels and symbolic
    #     notation are either exactly right or visibly wrong, and students
    #     memorise visuals.
    #   - Visual verification reads the RENDERED diagram back to judge whether
    #     the generated code actually drew what it claimed. Pairing it with the
    #     generator at the same tier is the point — a checker weaker than the
    #     thing it checks waves through the errors it cannot see.
    #   - Factual verification is the last check between a generated claim and a
    #     paying student.
    #
    # The other three paid-deck stages sit on the mid-tier workhorse. They are
    # structured-JSON work of the same shape the rest of the pipeline already
    # runs there (syllabus processing, study material, mock tests), and the
    # premium tier costs roughly five times as much per token for judgement that
    # is not visibly better on this class of task. Coverage summaries remain the
    # highest-stakes of the three — anything a summary fails to name gets
    # silently dropped downstream — so if deck quality regresses, that entry is
    # the first one to move back up, not the last.
    #
    # Everything else in the pipeline — chunk generation, flashcards, study
    # material, mock tests, raster illustrations — stays on its existing tier.
    # Reasoning effort is NOT part of the tuple; it is per-call metadata, and
    # only the symbolic-diagram path raises it (see
    # PaidDeckVisualGenerationSettings.SYMBOLIC_REASONING_EFFORT).
    #
    # ROUTE BOUNDARY — read before adding a caller to any PAID_DECK_* entry.
    #
    # These models may receive ONLY: syllabus topic names and the coverage
    # specifications derived from them, content this pipeline generated itself,
    # and rendered images of its own generated diagrams.
    #
    # They must NEVER receive user-uploaded document text — no extracted PDF
    # pages, no retrieved chunks, no question-paper text, no support attachment
    # contents. Two independent reasons:
    #
    #   1. Provider posture. Anthropic retains inputs for up to 30 days for
    #      abuse monitoring unless account-level ZDR is in force (see the DATA
    #      GOVERNANCE block on AnthropicProvider). That window means something
    #      very different for a learner's private textbook than for a public
    #      syllabus topic list.
    #   2. The independent-creation position. Content written by these entries is
    #      defensible because they demonstrably had no third-party document to
    #      work from. Routing uploaded text through any of them would defeat that
    #      argument regardless of which model served the call.
    #
    # Reason 2 is provider-agnostic, so the boundary binds every entry below —
    # including the ones that now route to Google rather than Anthropic. Do not
    # read a Gemini-tier entry as the relaxed one.
    #
    # The boundary holds structurally — PaidDeckGenerationGate refuses every
    # information-source type except CURRICULUM_OR_SYLLABUS, so nothing in the
    # generation source list of a paid-deck run is a document to pass along. A
    # caller that reaches these entries from outside paid-deck mode would break
    # that guarantee.
    #
    # THREE ROUTES BY WHICH A DOCUMENT MAY REACH A MODEL IN SERVICE OF SELLABLE
    # CONTENT, and none of them comes through here. Each has its own entry below:
    #
    #   REFINE_CONTENT_MODEL          — a reviewer correcting content against a
    #                                   document they declared a licence for.
    #   SOURCE_GROUNDED_VERIFICATION_MODEL — checking written content against
    #                                   such a document; raises flags, writes
    #                                   nothing.
    #   SOURCE_GROUNDED_CHUNK_MODEL   — WRITING a topic from such a document,
    #                                   where the declared licence records a
    #                                   right to create new material from it.
    #
    # In all three the document's licence is declared and the file itself is
    # retained as retrievable proof. That is a different and explicitly evidenced
    # basis from the independent-creation argument reason 2 rests on. Keeping
    # them on separate entries is what stops one being quietly used to justify
    # the other: nothing that reaches a PAID_DECK_* entry has ever seen a
    # third-party document, and that sentence must stay literally true.
    #
    # A deck may therefore contain topics of two kinds — some written from model
    # knowledge by the entries below, some written from a licensed document by
    # SOURCE_GROUNDED_CHUNK_MODEL. Which is which is recorded per topic in
    # SourceGroundedContent.json and reported separately in the audit trail. The
    # thing that must never exist is a topic whose basis nobody can name, and
    # that is what this separation buys.
    #
    # VerifySourceGroundedGeneration.py asserts the sentence above mechanically:
    # no file referencing a PAID_DECK_* entry may also reference the corpus or
    # the content-source payload. A comment saying "do not do X" is not a
    # control; a test that fails when someone does X is.
    PAID_DECK_COVERAGE_SUMMARY_MODEL = ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider)

    # Decides which topics need a visual nobody explicitly asked for. A bounded
    # per-topic judgement with a small output, which is what the mid-tier is for.
    # Its failure modes stay asymmetric and both bad — miss a needed diagram and
    # a visual subject ships as prose; invent unnecessary ones and the deck fills
    # with decorative figures that train the reader to skip figures entirely — so
    # watch this one if decks start looking over- or under-illustrated.
    PAID_DECK_VISUAL_NEED_MODEL = ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider)
    PAID_DECK_COVERAGE_RECONCILIATION_MODEL = ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider)

    # The three premium holdouts. See the tier rationale above before moving any
    # of these down — they are the generate/verify trio for content that ships to
    # a paying student, not a cost tier applied by habit.
    PAID_DECK_SYMBOLIC_VISUAL_MODEL = ("claude-opus-5", AnthropicProvider)
    PAID_DECK_FACTUAL_VERIFICATION_MODEL = ("claude-opus-5", AnthropicProvider)
    PAID_DECK_VISUAL_VERIFICATION_MODEL = ("claude-opus-5", AnthropicProvider)

    # Knowledge-first chunk generation (Phase 3) replaces retrieval, not the
    # generation tier — it produces the same per-topic chunk contract every
    # downstream worker already consumes, so it stays on the configured
    # mid-tier workhorse rather than the premium model.
    PAID_DECK_KNOWLEDGE_CHUNK_MODEL = ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider)

    # Post-generation content refinement: a subject expert correcting or
    # extending already-generated content, by instruction and optionally against
    # a reference source they have declared a licence for.
    #
    # Outside the PAID_DECK_* boundary ON PURPOSE — this is the one path that may
    # receive a user-supplied document, so it must not sit on an entry whose
    # contract says the opposite. See the boundary note above.
    #
    # Google rather than Anthropic for the same reason: the 30-day
    # abuse-monitoring retention window is a poor fit for a document a user
    # attached, even a permissively licensed one.
    REFINE_CONTENT_MODEL = ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider)

    # Source-grounded verification: checking already-generated paid-deck content
    # AGAINST a document an administrator has cleared and declared a licence for,
    # and proposing corrections where the two disagree.
    #
    # Outside the PAID_DECK_* boundary ON PURPOSE, and the reason is the whole
    # design of the feature rather than a detail of it. This call receives
    # third-party document text, so putting it on a PAID_DECK_* entry would make
    # the sentence at the end of the boundary note above false — and that
    # sentence is what the independent-creation position rests on.
    #
    # The separation is real, not cosmetic. This pass runs AFTER content exists
    # and can only RAISE FLAGS; it never writes a chunk. So a deck checked here
    # was still written by models that never saw a third-party document, and both
    # statements stay true at once — independently created, independently checked.
    #
    # Google rather than Anthropic for the same reason REFINE_CONTENT_MODEL is:
    # the 30-day abuse-monitoring retention window is a poor fit for a document
    # someone attached, even a permissively licensed one.
    SOURCE_GROUNDED_VERIFICATION_MODEL = ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider)

    # Source-grounded chunk generation: WRITING a topic's content from passages
    # of a document an administrator has declared a licence for, where that
    # licence records a right to create new material from it.
    #
    # Outside the PAID_DECK_* boundary ON PURPOSE. This is the third entry that
    # may receive third-party document text, and putting it on a PAID_DECK_*
    # entry would make the boundary sentence above false.
    #
    # WHAT IS DIFFERENT ABOUT THIS ONE, and why it is a separate entry rather
    # than a second caller of SOURCE_GROUNDED_VERIFICATION_MODEL: this one
    # produces sellable content, and its defence is NOT independent creation. A
    # topic written here is defended by the declared licence and the retained
    # document behind it — a different and explicitly evidenced basis, which is
    # exactly why it must not be merged with the entries whose contract is that
    # they never read a document.
    #
    # The two bases are recorded PER TOPIC, in SourceGroundedContent.json, and
    # the audit report keeps them apart. A deck may hold topics of both kinds;
    # what it must never hold is a topic whose basis nobody can name.
    #
    # Google rather than Anthropic for the same retention reason as the two
    # entries above.
    SOURCE_GROUNDED_CHUNK_MODEL = ("gemini-3.1-flash-lite", GoogleEnterpriseAiProvider)
