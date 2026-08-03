import os
import re
import sys


class SourceSimilarityScorer:
    """
    Measures how much of a generated document is verbatim-shared with the source
    chunks it was grounded on.

    LOG ONLY. Nothing in this class rejects, regenerates or edits a generation.
    It exists so that verbatim drift becomes observable — before this there was
    no signal at all that a generation had come back substantially copied, and
    no way to calibrate a threshold from real output. Enforcement is a separate,
    later decision that should be made from the scores this produces.

    The masking is the important part
    ---------------------------------
    A naive shingle comparison would count formulae, chemical equations, units,
    numeric values and terms of art as "copied" — but those have no alternative
    correct expression, so reproducing them exactly is required, not a problem.
    Scoring them would create pressure to paraphrase exactly the content that
    must never be paraphrased, so every such span is masked out BEFORE
    shingling. What remains is prose: the explanation, framing and ordering,
    which is the only layer where verbatim overlap is meaningful.

    A high score means "the explanatory prose closely tracks the source", which
    is worth a human look. It does not by itself mean anything is wrong.
    """

    # Shingle width in words. Long enough that ordinary shared phrasing
    # ("is defined as the", "in the case of") does not register, short enough to
    # catch a lifted sentence.
    SHINGLE_WORD_COUNT = 12

    # Below this many prose words the score is statistically meaningless — a
    # short section can legitimately share most of its few shingles.
    MINIMUM_PROSE_WORDS_FOR_SCORE = 60

    # Spans reproduced verbatim by design. Stripped before shingling.
    __INVARIANT_SPAN_PATTERNS = (
        re.compile(r"<pre\b.*?</pre>", re.DOTALL | re.IGNORECASE),
        re.compile(r"<code\b.*?</code>", re.DOTALL | re.IGNORECASE),
        re.compile(r"<table\b.*?</table>", re.DOTALL | re.IGNORECASE),
        re.compile(r"<span\s+class=[\"']math[\"'].*?</span>", re.DOTALL | re.IGNORECASE),
        re.compile(r"\\\[.*?\\\]", re.DOTALL),
        re.compile(r"\\\(.*?\\\)", re.DOTALL),
        re.compile(r"\$\$.*?\$\$", re.DOTALL),
    )

    __HTML_TAG_PATTERN = re.compile(r"<[^>]+>")

    # Any token carrying a digit, a math/scientific operator, a Unicode
    # sub/superscript, or a Greek letter is treated as invariant notation.
    __NOTATION_TOKEN_PATTERN = re.compile(
        r"\S*["
        r"0-9"
        r"°±×÷·"
        r"₀-ₜ"
        r"⁰-ⁿ"
        r"Α-ω"
        r"←-⇿"
        r"∀-⋿"
        r"]\S*"
    )

    __WHITESPACE_PATTERN = re.compile(r"\s+")

    @staticmethod
    def mask_invariant_spans(text: str) -> str:
        """
        Removes everything that must legitimately be reproduced verbatim,
        leaving only prose. Returns lowercase, whitespace-normalised text.
        """
        if not text:
            return ""

        masked_text = text
        for invariant_pattern in SourceSimilarityScorer.__INVARIANT_SPAN_PATTERNS:
            masked_text = invariant_pattern.sub(" ", masked_text)

        masked_text = SourceSimilarityScorer.__HTML_TAG_PATTERN.sub(" ", masked_text)
        masked_text = SourceSimilarityScorer.__NOTATION_TOKEN_PATTERN.sub(" ", masked_text)

        # Punctuation is dropped so a rephrase cannot dodge detection purely by
        # repunctuating a lifted sentence.
        masked_text = re.sub(r"[^\w\s]", " ", masked_text)
        masked_text = SourceSimilarityScorer.__WHITESPACE_PATTERN.sub(" ", masked_text)

        return masked_text.strip().lower()

    @staticmethod
    def __build_shingles(prose_text: str) -> set[str]:
        words = prose_text.split()
        if len(words) < SourceSimilarityScorer.SHINGLE_WORD_COUNT:
            return set()

        shingle_width = SourceSimilarityScorer.SHINGLE_WORD_COUNT
        return {
            " ".join(words[start_index:start_index + shingle_width])
            for start_index in range(len(words) - shingle_width + 1)
        }

    @staticmethod
    def score(generated_text: str, source_chunks: list[str]) -> dict:
        """
        Returns the containment of the generated prose within the source prose —
        the fraction of the generated document's shingles that also appear in
        the source.

        Containment is used rather than Jaccard deliberately: the source corpus
        is usually far larger than one generated section, and Jaccard would be
        driven down by that size difference regardless of how much was copied.

        Returns a dict with the score and the counts behind it. `scored` is
        False when there was too little prose to judge, in which case the score
        should be ignored rather than treated as zero.
        """
        generated_prose = SourceSimilarityScorer.mask_invariant_spans(generated_text)
        generated_word_count = len(generated_prose.split())

        if generated_word_count < SourceSimilarityScorer.MINIMUM_PROSE_WORDS_FOR_SCORE:
            return {
                "scored": False,
                "reason": "insufficient prose after masking",
                "containment": 0.0,
                "generatedProseWords": generated_word_count,
                "generatedShingles": 0,
                "sharedShingles": 0,
            }

        generated_shingles = SourceSimilarityScorer.__build_shingles(generated_prose)
        if not generated_shingles:
            return {
                "scored": False,
                "reason": "no shingles built",
                "containment": 0.0,
                "generatedProseWords": generated_word_count,
                "generatedShingles": 0,
                "sharedShingles": 0,
            }

        source_prose = SourceSimilarityScorer.mask_invariant_spans("\n".join(source_chunks or []))
        source_shingles = SourceSimilarityScorer.__build_shingles(source_prose)

        shared_shingles = generated_shingles & source_shingles
        containment = len(shared_shingles) / len(generated_shingles)

        return {
            "scored": True,
            "reason": None,
            "containment": round(containment, 4),
            "generatedProseWords": generated_word_count,
            "generatedShingles": len(generated_shingles),
            "sharedShingles": len(shared_shingles),
        }

    # ── Enforcement (opt-in) ──────────────────────────────────────────────────
    #
    # Enforcement is OFF unless SOURCE_SIMILARITY_ENFORCEMENT_ENABLED is truthy.
    # That default is deliberate and should not be flipped casually: a threshold
    # chosen without evidence either fires constantly (and pressures the model
    # to paraphrase content that must stay exact) or never fires at all. Run
    # with scoring on, collect real containment values from production
    # generations, then set the threshold from that distribution.
    #
    # The default threshold below is a starting point for that calibration, NOT
    # a validated value.
    DEFAULT_CONTAINMENT_THRESHOLD = 0.25

    # Longest run of consecutive shared words tolerated between a generated
    # question and the seed it was rephrased from. Mirrors the six-word rule
    # stated in the rephrase prompt so the instruction is measurable.
    DEFAULT_MAX_SHARED_WORD_RUN = 6

    @staticmethod
    def is_enforcement_enabled() -> bool:
        return (os.getenv("SOURCE_SIMILARITY_ENFORCEMENT_ENABLED") or "").strip().lower() in ("1", "true", "yes")

    @staticmethod
    def get_containment_threshold() -> float:
        raw_threshold = os.getenv("SOURCE_SIMILARITY_CONTAINMENT_THRESHOLD")
        if not raw_threshold:
            return SourceSimilarityScorer.DEFAULT_CONTAINMENT_THRESHOLD
        try:
            return max(0.0, min(1.0, float(raw_threshold)))
        except ValueError:
            return SourceSimilarityScorer.DEFAULT_CONTAINMENT_THRESHOLD

    @staticmethod
    def evaluate_gate(label: str, generated_text: str, source_chunks: list[str]) -> dict:
        """
        Scores the generation and reports whether it WOULD be rejected.

        Returns a dict with `bBreachesThreshold` (did the score exceed the
        threshold) and `bShouldReject` (should the caller actually act on it —
        only ever True when enforcement is explicitly enabled). Callers must
        branch on `bShouldReject`, never on `bBreachesThreshold`, so that
        turning enforcement off genuinely disables it.

        Always logs, so the observe-only mode still produces the calibration
        data that enabling enforcement depends on.
        """
        score_result = SourceSimilarityScorer.log_score(label, generated_text, source_chunks)

        b_enforcement_enabled = SourceSimilarityScorer.is_enforcement_enabled()
        threshold = SourceSimilarityScorer.get_containment_threshold()

        b_breaches_threshold = bool(score_result.get("scored")) and score_result.get("containment", 0.0) >= threshold

        if b_breaches_threshold:
            print(
                f"[SourceSimilarityScorer] [SIMILARITY_BREACH] {label} "
                f"containment={score_result['containment']:.4f} >= threshold={threshold:.4f} "
                f"enforcement={'ON' if b_enforcement_enabled else 'OFF (observe only)'}",
                file=sys.stderr, flush=True,
            )

        return {
            **score_result,
            "threshold": threshold,
            "enforcementEnabled": b_enforcement_enabled,
            "bBreachesThreshold": b_breaches_threshold,
            "bShouldReject": b_breaches_threshold and b_enforcement_enabled,
        }

    @staticmethod
    def longest_shared_word_run(generated_text: str, source_text: str) -> int:
        """
        Longest run of consecutive words shared between two passages, after
        masking invariant spans.

        This is the primitive behind the rephrase rule: a rephrased exam
        question that still shares a long run with its seed was edited, not
        re-authored. Notation and numerals are masked first, so retaining a
        formula or a quantity — which is required for correctness — never
        counts as a shared run.
        """
        generated_words = SourceSimilarityScorer.mask_invariant_spans(generated_text).split()
        source_words = SourceSimilarityScorer.mask_invariant_spans(source_text).split()

        if not generated_words or not source_words:
            return 0

        source_word_count = len(source_words)
        previous_row = [0] * (source_word_count + 1)
        longest_run = 0

        for generated_word in generated_words:
            current_row = [0] * (source_word_count + 1)
            for source_index in range(1, source_word_count + 1):
                if generated_word == source_words[source_index - 1]:
                    current_row[source_index] = previous_row[source_index - 1] + 1
                    if current_row[source_index] > longest_run:
                        longest_run = current_row[source_index]
            previous_row = current_row

        return longest_run

    @staticmethod
    def log_seed_overlap(label: str, generated_question: str, seed_question: str) -> int:
        """
        Logs the longest shared word run between a rephrased question and its
        seed. Observe-only, like the containment score — it makes the prompt's
        six-word rule visible rather than merely asserted.
        """
        try:
            longest_run = SourceSimilarityScorer.longest_shared_word_run(generated_question, seed_question)
            if longest_run >= SourceSimilarityScorer.DEFAULT_MAX_SHARED_WORD_RUN:
                print(
                    f"[SourceSimilarityScorer] [SEED_OVERLAP] {label} "
                    f"longest_shared_run={longest_run} (limit {SourceSimilarityScorer.DEFAULT_MAX_SHARED_WORD_RUN}) — "
                    f"question may be an edit of its seed rather than a rephrasing",
                    file=sys.stderr, flush=True,
                )
            return longest_run
        except Exception as overlap_error:
            print(f"[SourceSimilarityScorer] Seed-overlap check failed for {label} (continuing): {overlap_error}", file=sys.stderr, flush=True)
            return 0

    @staticmethod
    def count_quoted_blocks(generated_html: str) -> int:
        """
        Counts <blockquote> elements. Pairs with the prompt's quoted-block cap so
        that instruction is measurable rather than merely stated.
        """
        if not generated_html:
            return 0
        return len(re.findall(r"<blockquote\b", generated_html, re.IGNORECASE))

    @staticmethod
    def log_score(label: str, generated_text: str, source_chunks: list[str]) -> dict:
        """
        Scores and emits one line to stderr. Never raises — a scoring fault must
        never fail the generation it is only observing.
        """
        try:
            score_result = SourceSimilarityScorer.score(generated_text, source_chunks)
            quoted_block_count = SourceSimilarityScorer.count_quoted_blocks(generated_text)

            if not score_result["scored"]:
                print(
                    f"[SourceSimilarityScorer] [SIMILARITY] {label} not scored "
                    f"({score_result['reason']}, prose_words={score_result['generatedProseWords']}, "
                    f"blockquotes={quoted_block_count})",
                    file=sys.stderr, flush=True,
                )
                return score_result

            print(
                f"[SourceSimilarityScorer] [SIMILARITY] {label} "
                f"containment={score_result['containment']:.4f} "
                f"shared={score_result['sharedShingles']}/{score_result['generatedShingles']} "
                f"prose_words={score_result['generatedProseWords']} "
                f"blockquotes={quoted_block_count}",
                file=sys.stderr, flush=True,
            )
            return score_result
        except Exception as scoring_error:
            print(f"[SourceSimilarityScorer] Scoring failed for {label} (continuing): {scoring_error}", file=sys.stderr, flush=True)
            return {
                "scored": False,
                "reason": f"error: {scoring_error}",
                "containment": 0.0,
                "generatedProseWords": 0,
                "generatedShingles": 0,
                "sharedShingles": 0,
            }
