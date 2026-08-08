"""
End-to-end verification harness for the LLM-output content guardrail.

Run from the Agent directory:
    .venv/Scripts/python.exe Verification/VerifyContentGuardrail.py    (Windows)
    .venv/bin/python Verification/VerifyContentGuardrail.py            (Linux)

Two tiers, so the default run needs no network, no database and no API key:

  1. ALWAYS -- the deterministic half. Word-boundary behaviour (the "shitake"
     class of false positive), the academic allowlist and its override flag,
     sentence and context extraction, JSON-aware segmentation, HTML-safe
     redaction, the streaming sentence hold-back including a term split across
     two chunks, the fail-open/fail-closed policies, and the enable and
     enforcement kill switches. The verification model is stubbed, so every
     assertion here is reproducible and offline.

  2. NETWORK (opt-in: VERIFY_CONTENT_GUARDRAIL_NETWORK=1) -- one real
     gemini-2.5-flash-lite adjudication over a genuinely abusive snippet and a
     quoted one, asserting the model separates them. Skipped by default so the
     harness stays runnable offline.
"""

import asyncio
import io
import json
import os
import sys
from pathlib import Path

# This harness lives in Agent/Verification/, so the Agent package root -- what
# its `from Globals...` imports resolve against -- is one level up.
AGENT_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENT_DIRECTORY))

# Generated text is full of characters a Windows console's default code page
# cannot encode. Force UTF-8 so an assertion failure prints its subject.
if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding = "utf-8", errors = "replace")

from Globals.Classes.Compliance.BannedTermLexicon import BannedTermLexicon
from Globals.Classes.Compliance.ContentGuardrail import ContentGuardrail
from Globals.Classes.Compliance.ContentGuardrailRedactor import ContentGuardrailRedactor
from Globals.Classes.Compliance.ContentGuardrailScanner import ContentGuardrailScanner
from Globals.Classes.Compliance.ContentGuardrailVerifier import ContentGuardrailVerifier
from Globals.Classes.Compliance.GuardedTextDocument import GuardedTextDocument
from Globals.Classes.Compliance.StreamingContentGuardrail import StreamingContentGuardrail
from Globals.Classes.Logging.LogTitles import LogTitles
from Globals.Classes.Logging.Logger import Logger
from Globals.Enumerations.ContentGuardrailOutcomes import ContentGuardrailOutcomes
from Globals.Enumerations.LogCategory import LogCategory
from Globals.Utility.StripJsonMarkdown import strip_json_markdown


passed_count = 0
failed_count = 0
skipped_count = 0


def assert_that(condition: bool, description: str) -> None:
    global passed_count, failed_count
    if condition:
        passed_count += 1
        print(f"  PASS  {description}")
    else:
        failed_count += 1
        print(f"  FAIL  {description}")


def skip(description: str) -> None:
    global skipped_count
    skipped_count += 1
    print(f"  SKIP  {description}")


def section(title: str) -> None:
    print(f"\n=== {title} ===")


# ---------------------------------------------------------------------------
# Stubs
# ---------------------------------------------------------------------------

class VerifierStub:
    """
    Replaces ContentGuardrailVerifier.verify so the deterministic tier never
    touches a model. `abusive_terms` are the terms it will call abusive; every
    other flagged term comes back acceptable.
    """

    def __init__(self, abusive_terms = (), b_fail = False):
        self.__abusive_terms = {term.lower() for term in abusive_terms}
        self.__b_fail = b_fail
        self.call_count = 0
        self.last_item_count = 0
        self.__original_verify = None

    def __enter__(self):
        self.__original_verify = ContentGuardrailVerifier.verify
        ContentGuardrailVerifier.verify = self.__verify
        return self

    def __exit__(self, exception_type, exception_value, traceback):
        ContentGuardrailVerifier.verify = self.__original_verify
        return False

    async def __verify(self, matches):
        # Bound as a plain function on the class, so `matches` arrives as the
        # first positional argument exactly as the real staticmethod sees it.
        self.call_count += 1
        self.last_item_count = len(matches)

        if self.__b_fail:
            return None

        verdicts = {}
        for match_index, match in enumerate(matches[:ContentGuardrailVerifier.MAXIMUM_ITEMS_PER_REQUEST]):
            b_abusive = match.get_term() in self.__abusive_terms
            verdicts[match_index] = {"bAbusive": b_abusive, "reason": "stub verdict"}

        return verdicts


class LoggerStub:
    """
    Captures Logger.warning calls instead of writing to logEvents, so the harness
    can assert on the recorded entry and does not need a database.
    """

    def __init__(self):
        self.entries = []
        self.__original_warning = None

    def __enter__(self):
        self.__original_warning = Logger.warning
        Logger.warning = self.__warning
        return self

    def __exit__(self, exception_type, exception_value, traceback):
        Logger.warning = self.__original_warning
        return False

    async def __warning(self, category, title, message, account_id = "", error_code = "", error_reason = "", additional_data = None):
        self.entries.append({
            "category": category,
            "title": title,
            "message": message,
            "accountId": account_id,
            "additionalData": additional_data or {},
        })


class EnvironmentOverride:
    """Sets environment variables for the duration of a block, then restores."""

    def __init__(self, **variables):
        self.__variables = variables
        self.__previous_values = {}

    def __enter__(self):
        for name, value in self.__variables.items():
            self.__previous_values[name] = os.environ.get(name)
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        BannedTermLexicon.reset_cache()
        return self

    def __exit__(self, exception_type, exception_value, traceback):
        for name, previous_value in self.__previous_values.items():
            if previous_value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = previous_value
        BannedTermLexicon.reset_cache()
        return False


# ---------------------------------------------------------------------------
# 1. Word boundaries -- the "shitake" class
# ---------------------------------------------------------------------------

def verify_word_boundaries() -> None:
    section("Word boundaries (no substring false positives)")

    must_not_match = [
        ("shitake mushroom risotto", "shit does not match inside shitake"),
        ("Scunthorpe United played well", "cunt does not match inside Scunthorpe"),
        ("the analysis of the data", "anal does not match inside analysis"),
        ("pornography law under the IT Act", "porn does not match inside pornography"),
        ("Pakistan shares a border with India", "paki does not match inside Pakistan"),
        ("a mongoose fought the cobra", "mong does not match inside mongoose"),
        ("classic Greek literature", "ass does not match inside classic"),
        ("the raccoon washed its food", "coon does not match inside raccoon"),
        ("assessment of the assignment", "ass does not match inside assessment"),
        ("Mongolia and Manchuria", "mong does not match inside Mongolia"),
    ]

    for text, description in must_not_match:
        assert_that(not ContentGuardrailScanner.scan(text), description)

    must_match = [
        ("you stupid bitch", "bitch", "a bare slur matches"),
        ("that bitch's collar", "bitch", "a possessive apostrophe is a boundary"),
        ("BITCH in capitals", "bitch", "matching is case insensitive"),
        ("stop being a twat", "twat", "a second term matches"),
        ("S&M is referenced", "s&m", "an entry containing a symbol matches"),
    ]

    for text, expected_term, description in must_match:
        matches = ContentGuardrailScanner.scan(text)
        assert_that(len(matches) == 1 and matches[0].get_term() == expected_term, description)

    # Multi-word entries have to survive the line wrapping and hyphenation that
    # generated HTML introduces.
    for separator, description in [(" ", "space"), ("\n", "newline"), ("-", "hyphen")]:
        text = f"he gave a hand{separator}job reference"
        matches = ContentGuardrailScanner.scan(text)
        assert_that(len(matches) == 1, f"a multi-word entry matches across a {separator!r}")
        # The reported term is the list entry, not the incidental separator the
        # model emitted, so logs and grouping stay stable across line wraps.
        assert_that(
            matches and matches[0].get_term() == "hand job",
            f"a multi-word match across a {separator!r} reports the canonical entry "
            f"(got {matches[0].get_term()!r})" if matches else "(no match)",
        )

    # The original casing is preserved on the match, because the redactor slices
    # the original string with these offsets.
    matches = ContentGuardrailScanner.scan("He shouted BITCH loudly.")
    assert_that(
        matches and matches[0].get_matched_text() == "BITCH" and matches[0].get_term() == "bitch",
        "matched_text keeps the original case while term is normalised",
    )

    # The IGNORECASE fallback: U+0130 lowercases to two characters, so the fast
    # path is unsound and the scanner must still return usable offsets.
    text_with_expanding_character = "İ said he was a BITCH about it."
    matches = ContentGuardrailScanner.scan(text_with_expanding_character)
    assert_that(
        len(matches) == 1
        and text_with_expanding_character[matches[0].get_start_index():matches[0].get_end_index()] == "BITCH",
        "offsets stay valid when lowercasing would change the string length",
    )


# ---------------------------------------------------------------------------
# 2. The academic allowlist
# ---------------------------------------------------------------------------

def verify_academic_allowlist() -> None:
    section("Academic allowlist")

    academic_texts = [
        ("Sexual reproduction in humans involves gametes.", "sexual/sex cleared for biology"),
        ("The XX chromosome pair determines the sex of the offspring.", "xx cleared for genetics"),
        ("Rape is defined under Section 375 of the IPC.", "rape cleared for law"),
        ("The anus is the terminal opening of the digestive tract.", "anus cleared for anatomy"),
        ("Semen analysis measures sperm motility.", "semen cleared for medicine"),
        ("Corn smut is a fungal disease of maize.", "smut cleared for botany"),
        ("The great tit is a common European songbird.", "tit cleared for ornithology"),
        ("Scat analysis identifies mammal diets.", "scat cleared for ecology"),
        ("A big black hole forms after a supernova.", "big black cleared for astrophysics"),
        ("The girl on the left is the control subject.", "girl on cleared for ordinary prose"),
        ("Currency pegging stabilises the exchange rate.", "pegging cleared for economics"),
        ("The swastika is a sacred symbol in Hinduism.", "swastika cleared for religious studies"),
        ("Eunuchs held office in the Mughal court.", "eunuch cleared for history"),
        ("The pump sucks water into the chamber.", "suck cleared for physics"),
        ("Spastic paralysis is a symptom of cerebral palsy.", "spastic cleared for medicine"),
    ]

    for text, description in academic_texts:
        matches = ContentGuardrailScanner.scan(text)
        assert_that(not matches, f"{description}  ({[m.get_term() for match in matches]})")

    assert_that(
        BannedTermLexicon.get_allowlisted_term_count() > 0
        and BannedTermLexicon.get_active_term_count() > 0,
        f"lexicon split: {BannedTermLexicon.get_active_term_count()} active, "
        f"{BannedTermLexicon.get_allowlisted_term_count()} allowlisted",
    )

    # Every allowlist entry must exist verbatim upstream, or it silently does
    # nothing. This is the assertion that catches a typo or an upstream removal.
    upstream_terms = BannedTermLexicon._BannedTermLexicon__read_word_list()
    allowlisted_terms = BannedTermLexicon._BannedTermLexicon__read_allowlist()
    unmatched_terms = sorted(allowlisted_terms - upstream_terms)
    assert_that(not unmatched_terms, f"every allowlist entry exists in the upstream list  (stray: {unmatched_terms})")

    with EnvironmentOverride(CONTENT_GUARDRAIL_INCLUDE_CLINICAL_TERMS = "true"):
        assert_that(
            len(ContentGuardrailScanner.scan("Rape is defined under Section 375 of the IPC.")) == 1,
            "CONTENT_GUARDRAIL_INCLUDE_CLINICAL_TERMS=true folds the clinical terms back in",
        )

    assert_that(
        not ContentGuardrailScanner.scan("Rape is defined under Section 375 of the IPC."),
        "the allowlist is restored once the override is out of scope",
    )


# ---------------------------------------------------------------------------
# 3. Sentence and context extraction
# ---------------------------------------------------------------------------

def verify_sentence_and_context() -> None:
    section("Sentence and context extraction")

    text = "Photosynthesis occurs in chloroplasts. The author called him a bitch in the letter. Respiration follows."
    match = ContentGuardrailScanner.scan(text)[0]
    sentence_start_index, sentence_end_index = match.get_sentence_span()
    assert_that(
        text[sentence_start_index:sentence_end_index] == "The author called him a bitch in the letter.",
        "the sentence span covers exactly the containing sentence",
    )

    decimal_text = "The value is 3.14 approximately and he is a twat regardless."
    match = ContentGuardrailScanner.scan(decimal_text)[0]
    sentence_start_index, _ = match.get_sentence_span()
    assert_that(sentence_start_index == 0, "a decimal point is not treated as a sentence boundary")

    html_text = "<p>Cells divide by mitosis.</p><p>He called it a bitch of a problem.</p><p>Next.</p>"
    match = ContentGuardrailScanner.scan(html_text)[0]
    sentence_start_index, sentence_end_index = match.get_sentence_span()
    assert_that(
        "<" not in html_text[sentence_start_index:sentence_end_index]
        and ">" not in html_text[sentence_start_index:sentence_end_index],
        "a sentence span never crosses an HTML tag boundary",
    )

    # 25 words either side, and no more.
    leading_words = " ".join(f"w{index}" for index in range(60))
    trailing_words = " ".join(f"x{index}" for index in range(60))
    windowed_text = f"{leading_words} bitch {trailing_words}"
    snippet = ContentGuardrailScanner.scan(windowed_text)[0].get_context_snippet()
    assert_that(snippet.startswith("w35 ") and snippet.endswith(" x24"), "the context window is 25 words each side")
    assert_that("bitch" in snippet, "the context window contains the flagged term")

    # Punctuation attached to the term survives, because the snippet is sliced
    # from the original rather than rebuilt by joining tokens.
    assert_that(
        ContentGuardrailScanner.scan("Bitch! That was the first word.")[0].get_context_snippet().startswith("Bitch!"),
        "the context snippet preserves the original punctuation",
    )

    # A single term appearing many times must produce one match each.
    repeated_text = " ".join(["He is a bitch."] * 5)
    assert_that(len(ContentGuardrailScanner.scan(repeated_text)) == 5, "every occurrence is reported, not just the first")


# ---------------------------------------------------------------------------
# 4. JSON-aware segmentation
# ---------------------------------------------------------------------------

def verify_json_segmentation() -> None:
    section("JSON-aware segmentation")

    payload = {"cards": [{"question": "What is a diode?", "answer": "A rectifier."}], "count": 1, "bReady": True}
    document = GuardedTextDocument.from_text(json.dumps(payload))
    assert_that(document.is_json(), "a JSON object is recognised as structured")
    assert_that(
        document.get_segments() == ["What is a diode?", "A rectifier."],
        f"only string values become segments  ({document.get_segments()})",
    )

    rebuilt = document.rebuild(["What is a diode?", "REPLACED"])
    assert_that(json.loads(rebuilt)["cards"][0]["answer"] == "REPLACED", "a rebuilt document places segments correctly")
    assert_that(json.loads(rebuilt)["count"] == 1, "non-string values survive the rebuild unchanged")

    unchanged = document.rebuild(document.get_segments())
    assert_that(unchanged == json.dumps(payload), "an untouched document is returned byte-for-byte")

    # Gemini fences JSON often enough that StripJsonMarkdown exists for it. An
    # unrecognised fence would leave `{"answer": "..."}` as one flat line, and
    # removing a sentence from that takes the braces with it.
    fenced_text = '```json\n{"answer": "He wrote a note. He called him a bitch. Then he left."}\n```'
    fenced_document = GuardedTextDocument.from_text(fenced_text)
    assert_that(fenced_document.is_json(), "a fenced JSON payload is recognised as structured")
    assert_that(
        fenced_document.get_segments() == ["He wrote a note. He called him a bitch. Then he left."],
        f"the fence is stripped before segmenting  ({fenced_document.get_segments()})",
    )
    fenced_rebuilt = fenced_document.rebuild(["Replaced."])
    assert_that(
        fenced_rebuilt.startswith("```json\n") and fenced_rebuilt.endswith("\n```"),
        f"the fence is restored on rebuild, closing marker still on its own line  ({fenced_rebuilt!r})",
    )
    assert_that(
        json.loads(fenced_rebuilt.split("\n", 1)[1].rsplit("```", 1)[0])["answer"] == "Replaced.",
        "the fenced body is still valid JSON after rebuild",
    )

    truncated_fence = '```json\n{"answer": "He is a bitch"}'
    assert_that(
        not GuardedTextDocument.from_text(truncated_fence).is_json(),
        "a fence with no closing marker is not guessed at",
    )

    plain_document = GuardedTextDocument.from_text("<p>Just HTML.</p>")
    assert_that(
        not plain_document.is_json() and plain_document.get_segments() == ["<p>Just HTML.</p>"],
        "non-JSON text is a single segment",
    )

    # Deep nesting must still round-trip in the right order.
    nested = {"a": {"b": ["one", {"c": "two"}]}, "d": "three"}
    nested_document = GuardedTextDocument.from_text(json.dumps(nested))
    assert_that(nested_document.get_segments() == ["one", "two", "three"], "nested strings are collected in source order")
    nested_rebuilt = json.loads(nested_document.rebuild(["ONE", "TWO", "THREE"]))
    assert_that(
        nested_rebuilt["a"]["b"][0] == "ONE" and nested_rebuilt["a"]["b"][1]["c"] == "TWO" and nested_rebuilt["d"] == "THREE",
        "nested strings are written back to the field they came from",
    )


# ---------------------------------------------------------------------------
# 5. Redaction
# ---------------------------------------------------------------------------

def verify_redaction() -> None:
    section("Redaction")

    text = "Photosynthesis occurs in chloroplasts. The author called him a bitch here. Respiration follows."
    redacted_text, b_removed = ContentGuardrailRedactor.remove(text, ContentGuardrailScanner.scan(text))
    assert_that(b_removed and "bitch" not in redacted_text, "the flagged term is gone")
    assert_that(
        "Photosynthesis occurs in chloroplasts." in redacted_text and "Respiration follows." in redacted_text,
        "the surrounding sentences survive",
    )

    html_text = "<p>Cells divide by mitosis.</p><p>He called it a bitch of a problem.</p><p>Next topic.</p>"
    redacted_html, _ = ContentGuardrailRedactor.remove(html_text, ContentGuardrailScanner.scan(html_text))
    assert_that("bitch" not in redacted_html, "the term is removed from HTML")
    assert_that(
        redacted_html.count("<p>") == redacted_html.count("</p>") == 3,
        f"HTML tags stay balanced after removal  ({redacted_html})",
    )

    multiple_text = "A bitch here. Something fine. A twat there. Also fine."
    redacted_multiple, _ = ContentGuardrailRedactor.remove(multiple_text, ContentGuardrailScanner.scan(multiple_text))
    assert_that(
        "bitch" not in redacted_multiple and "twat" not in redacted_multiple,
        "multiple matches are all removed",
    )
    assert_that(
        "Something fine." in redacted_multiple and "Also fine." in redacted_multiple,
        f"right-to-left application keeps the untouched sentences intact  ({redacted_multiple!r})",
    )

    # Two terms inside one sentence produce overlapping spans, which must merge
    # rather than delete the region twice.
    overlapping_text = "Before. That bitch of a twat said so. After."
    redacted_overlapping, _ = ContentGuardrailRedactor.remove(
        overlapping_text,
        ContentGuardrailScanner.scan(overlapping_text),
    )
    assert_that(
        "Before." in redacted_overlapping and "After." in redacted_overlapping
        and "bitch" not in redacted_overlapping and "twat" not in redacted_overlapping,
        f"overlapping spans merge cleanly  ({redacted_overlapping!r})",
    )

    assert_that(
        ContentGuardrailRedactor.remove("Nothing wrong here.", []) == ("Nothing wrong here.", False),
        "removing nothing returns the input and reports no change",
    )

    # Regression: an earlier whole-segment "tidy" pass reformatted text the
    # redaction never touched -- `int values[] = {1, 2, 3};` lost its `[]`,
    # `malloc()` lost its `()`, and indentation inside <pre> was collapsed.
    # Removing one sentence must not rewrite the rest of a study material.
    untouched_text = (
        "He is a bitch. Then: int values[] = {1, 2, 3}; and call malloc() now.\n"
        "    indented code line\n"
        "- [ ] a markdown task\n"
        "Two  spaces  between  these  words."
    )
    redacted_untouched, _ = ContentGuardrailRedactor.remove(untouched_text, ContentGuardrailScanner.scan(untouched_text))
    assert_that("bitch" not in redacted_untouched, "the flagged sentence is still removed")
    for preserved_fragment, description in [
        ("int values[] = {1, 2, 3};", "an empty array subscript survives"),
        ("malloc()", "an empty call parenthesis survives"),
        ("\n    indented code line", "leading indentation survives"),
        ("- [ ] a markdown task", "a markdown checkbox survives"),
        ("Two  spaces  between  these  words.", "existing double spaces elsewhere survive"),
    ]:
        assert_that(preserved_fragment in redacted_untouched, description)


# ---------------------------------------------------------------------------
# 6. The orchestrated pipeline
# ---------------------------------------------------------------------------

def verify_pipeline() -> None:
    section("Orchestrated pipeline")

    abusive_text = "Mitosis is cell division. The author called him a bitch. Meiosis is different."

    with VerifierStub(abusive_terms = ["bitch"]), LoggerStub() as logger_stub:
        asyncio.run(ContentGuardrail.sanitize_text(
            abusive_text,
            model = "gemini-2.5-flash-lite",
            account_id = "user-123",
            source_label = "unitTest",
        ))
        assert_that(len(logger_stub.entries) == 1, f"one log entry per flagged response  ({len(logger_stub.entries)})")

        entry = logger_stub.entries[0] if logger_stub.entries else {"additionalData": {}}
        additional_data = entry["additionalData"]
        assert_that(entry.get("title") == LogTitles.CONTENT_GUARDRAIL, "the entry is titled CONTENT_GUARDRAIL")
        assert_that(entry.get("category") == LogCategory.AI_REQUEST, "the entry is categorised AI_REQUEST")
        assert_that(entry.get("accountId") == "user-123", "the account is attributed on the entry")
        assert_that(additional_data.get("outcome") == int(ContentGuardrailOutcomes.REDACTED), "the outcome is REDACTED")
        assert_that(additional_data.get("outcomeName") == "REDACTED", "the outcome name is recorded for readability")
        assert_that(additional_data.get("flaggedTerms") == ["bitch"], "the flagged term is recorded")
        assert_that(additional_data.get("model") == "gemini-2.5-flash-lite", "the model is recorded")
        assert_that(additional_data.get("sourceLabel") == "unitTest", "the source label is recorded")
        assert_that(additional_data.get("removedSegmentCount") == 1, "the removed segment count is recorded")
        assert_that(bool(additional_data.get("snippets")), "the offending snippet is recorded for review")

    # A flagged-then-cleared response is still logged: that is the signal that
    # tells you whether the allowlist needs another entry.
    with VerifierStub(abusive_terms = []), LoggerStub() as logger_stub:
        asyncio.run(ContentGuardrail.sanitize_text(abusive_text, model = "gemini-2.5-flash-lite"))
        assert_that(
            len(logger_stub.entries) == 1
            and logger_stub.entries[0]["additionalData"].get("outcomeName") == "CLEARED",
            "a flagged-but-cleared response is logged as CLEARED",
        )

    with VerifierStub(abusive_terms = ["bitch"]), LoggerStub() as logger_stub:
        asyncio.run(ContentGuardrail.sanitize_text("Mitosis is cell division.", model = "gemini-2.5-flash-lite"))
        assert_that(not logger_stub.entries, "a clean response produces no log entry at all")

    with VerifierStub(abusive_terms = ["bitch"]) as stub:
        result = asyncio.run(ContentGuardrail.sanitize_text(abusive_text, model = "gemini-2.5-flash-lite"))
        assert_that("bitch" not in result, "an abusive verdict removes the sentence")
        assert_that("Mitosis is cell division." in result, "the rest of the text survives")
        assert_that(stub.call_count == 1, "adjudication is one call")

    with VerifierStub(abusive_terms = []) as stub:
        result = asyncio.run(ContentGuardrail.sanitize_text(abusive_text, model = "gemini-2.5-flash-lite"))
        assert_that(result == abusive_text, "an acceptable verdict leaves the text byte-for-byte unchanged")

    clean_text = "Mitosis is cell division. Meiosis is different."
    with VerifierStub(abusive_terms = ["bitch"]) as stub:
        result = asyncio.run(ContentGuardrail.sanitize_text(clean_text, model = "gemini-2.5-flash-lite"))
        assert_that(result == clean_text and stub.call_count == 0, "clean text never reaches the verification model")

    # Several occurrences in one response are batched into a single call.
    many_text = " ".join([f"Sentence {index} calls him a bitch." for index in range(6)])
    with VerifierStub(abusive_terms = ["bitch"]) as stub:
        result = asyncio.run(ContentGuardrail.sanitize_text(many_text, model = "gemini-2.5-flash-lite"))
        assert_that(stub.call_count == 1 and stub.last_item_count == 6, "six occurrences are adjudicated in one call")
        assert_that("bitch" not in result, "every occurrence is removed")

    # JSON responses redact inside the field, and stay parseable.
    json_payload = json.dumps({
        "question": "What did the author write?",
        "answer": "He wrote a note. He called him a bitch. Then he left.",
    })
    with VerifierStub(abusive_terms = ["bitch"]):
        result = asyncio.run(ContentGuardrail.sanitize_text(json_payload, model = "gemini-2.5-flash-lite"))
        try:
            parsed = json.loads(result)
            assert_that("bitch" not in parsed["answer"], "the term is removed from the JSON field")
            assert_that(parsed["question"] == "What did the author write?", "the untouched field is unchanged")
            assert_that("He wrote a note." in parsed["answer"], "the rest of the field survives")
        except Exception as parse_error:
            assert_that(False, f"the redacted JSON response still parses  ({parse_error})")

    # The same, fenced. Before fences were handled this collapsed the whole
    # payload to "```json\n\n```" and took the generation down with it.
    fenced_payload = '```json\n{"answer": "He wrote a note. He called him a bitch. Then he left."}\n```'
    with VerifierStub(abusive_terms = ["bitch"]):
        result = asyncio.run(ContentGuardrail.sanitize_text(fenced_payload, model = "gemini-2.5-flash-lite"))
        parsed = strip_json_markdown(result)
        assert_that(isinstance(parsed, dict), f"a fenced JSON response survives redaction  ({result!r})")
        if isinstance(parsed, dict):
            assert_that("bitch" not in parsed.get("answer", ""), "the term is removed from the fenced field")
            assert_that("He wrote a note." in parsed.get("answer", ""), "the rest of the fenced field survives")

    # Verification failure: fail open by default, fail closed on request.
    with VerifierStub(b_fail = True):
        result = asyncio.run(ContentGuardrail.sanitize_text(abusive_text, model = "gemini-2.5-flash-lite"))
        assert_that(result == abusive_text, "a failed adjudication keeps the text (fail open)")

        with EnvironmentOverride(CONTENT_GUARDRAIL_FAIL_CLOSED = "true"):
            result = asyncio.run(ContentGuardrail.sanitize_text(abusive_text, model = "gemini-2.5-flash-lite"))
            assert_that("bitch" not in result, "CONTENT_GUARDRAIL_FAIL_CLOSED=true removes it instead")

    # Kill switches.
    with VerifierStub(abusive_terms = ["bitch"]) as stub:
        with EnvironmentOverride(CONTENT_GUARDRAIL_ENABLED = "false"):
            result = asyncio.run(ContentGuardrail.sanitize_text(abusive_text, model = "gemini-2.5-flash-lite"))
            assert_that(result == abusive_text and stub.call_count == 0, "CONTENT_GUARDRAIL_ENABLED=false disables everything")

        with EnvironmentOverride(CONTENT_GUARDRAIL_ENFORCEMENT_ENABLED = "false"):
            result = asyncio.run(ContentGuardrail.sanitize_text(abusive_text, model = "gemini-2.5-flash-lite"))
            assert_that(result == abusive_text, "enforcement off leaves the text alone")
            assert_that(stub.call_count > 0, "enforcement off still scans and adjudicates, so the hit rate is logged")

    # A request with no model is not an LLM call -- it is a student's own
    # uploaded document coming back from DocumentProcessingProvider.
    with VerifierStub(abusive_terms = ["bitch"]) as stub:
        result = asyncio.run(ContentGuardrail.sanitize_text(abusive_text, model = None))
        assert_that(result == abusive_text and stub.call_count == 0, "text from a model-less request is never rewritten")

    # More matches than one adjudication request carries. The overflow is
    # recorded rather than silently dropped, and only the adjudicated items are
    # sent to the model.
    overflow_count = ContentGuardrailVerifier.MAXIMUM_ITEMS_PER_REQUEST + 5
    overflow_text = " ".join([f"Sentence {index} calls him a bitch." for index in range(overflow_count)])

    # The cap lives inside the real verifier, so it is exercised by stubbing the
    # layer BELOW it -- the method that actually builds the model request -- and
    # calling the genuine ContentGuardrailVerifier.verify.
    captured_request_sizes = []
    original_request_verdicts = ContentGuardrailVerifier._ContentGuardrailVerifier__request_verdicts

    async def capture_request_size(matches):
        captured_request_sizes.append(len(matches))
        return json.dumps({"verdicts": [{"index": index + 1, "bAbusive": True, "reason": "stub"} for index in range(len(matches))]})

    ContentGuardrailVerifier._ContentGuardrailVerifier__request_verdicts = capture_request_size
    try:
        overflow_matches = ContentGuardrailScanner.scan(overflow_text)
        verdicts = asyncio.run(ContentGuardrailVerifier.verify(overflow_matches))
        assert_that(len(overflow_matches) == overflow_count, f"the scan found all {overflow_count} occurrences")
        assert_that(
            captured_request_sizes == [ContentGuardrailVerifier.MAXIMUM_ITEMS_PER_REQUEST],
            f"the adjudication request is capped at {ContentGuardrailVerifier.MAXIMUM_ITEMS_PER_REQUEST} items "
            f"({captured_request_sizes})",
        )
        assert_that(
            verdicts is not None and len(verdicts) == ContentGuardrailVerifier.MAXIMUM_ITEMS_PER_REQUEST,
            "only the adjudicated items come back with a verdict",
        )
    finally:
        ContentGuardrailVerifier._ContentGuardrailVerifier__request_verdicts = original_request_verdicts

    with VerifierStub(abusive_terms = ["bitch"]) as stub, LoggerStub() as logger_stub:
        asyncio.run(ContentGuardrail.sanitize_text(overflow_text, model = "gemini-2.5-flash-lite"))
        assert_that(
            logger_stub.entries
            and logger_stub.entries[0]["additionalData"].get("outcomeName") == "OVERFLOW_REDACTED",
            "exceeding the cap is recorded as OVERFLOW_REDACTED rather than passing silently",
        )
        assert_that(
            logger_stub.entries
            and logger_stub.entries[0]["additionalData"].get("flaggedTermCount") == overflow_count,
            "the log records the true flagged count, including the items past the cap",
        )


# ---------------------------------------------------------------------------
# 7. Streaming
# ---------------------------------------------------------------------------

def verify_streaming() -> None:
    section("Streaming sentence hold-back")

    async def drive_stream(chunks, abusive_terms):
        with VerifierStub(abusive_terms = abusive_terms):
            guardrail = StreamingContentGuardrail(model = "gemini-2.5-flash-lite")
            emitted = []
            for chunk in chunks:
                emitted.extend(await guardrail.accept(chunk))
            emitted.extend(await guardrail.flush())
            return emitted

    clean_chunks = ["The mitochon", "drion is the powerhouse. ", "Meiosis produces gametes. ", "That is all."]
    emitted = asyncio.run(drive_stream(clean_chunks, []))
    assert_that(
        "".join(emitted) == "".join(clean_chunks),
        f"a clean stream reassembles byte-for-byte  ({''.join(emitted)!r})",
    )

    # The decisive case: the term is split across a chunk boundary, so a naive
    # per-chunk scan would never see it.
    split_chunks = ["Cells divide. He called him a bit", "ch in the letter. ", "Then he left. " + "word " * 30]
    emitted = asyncio.run(drive_stream(split_chunks, ["bitch"]))
    joined = "".join(emitted)
    assert_that("bitch" not in joined, f"a term split across two chunks is still caught  ({joined!r})")
    assert_that("Cells divide." in joined, "text before the flagged sentence still reaches the browser")
    assert_that("Then he left." in joined, "text after the flagged sentence still reaches the browser")

    # Nothing offensive may be emitted even before the verdict arrives, so no
    # individual fragment can ever contain the term.
    assert_that(all("bitch" not in fragment for fragment in emitted), "no emitted fragment ever contains the term")

    # A cleared verdict must release the sentence intact.
    emitted = asyncio.run(drive_stream(split_chunks, []))
    assert_that("bitch" in "".join(emitted), "a cleared verdict releases the sentence unchanged")

    # A response with no sentence terminator must not buffer forever.
    long_chunk = "x" * (StreamingContentGuardrail.MAXIMUM_PENDING_CHARACTERS + 50)
    emitted = asyncio.run(drive_stream([long_chunk], []))
    assert_that("".join(emitted) == long_chunk, "a terminator-less run is force-flushed rather than held")

    # An empty stream must not emit anything at all.
    emitted = asyncio.run(drive_stream([], []))
    assert_that(emitted == [], "an empty stream emits nothing")

    # Regression: a multi-word term matches across a line wrap, but "\n" also
    # ends a sentence. Releasing at the newline used to split "hand\njob" into
    # two halves that each looked innocent, and the term sailed through.
    newline_split_chunks = [
        "He gave a hand\n",
        "job reference to the student. ",
        "Then the meeting ended. " + "filler word here. " * 6,
    ]
    emitted = asyncio.run(drive_stream(newline_split_chunks, ["hand job"]))
    joined = "".join(emitted)
    assert_that("hand\njob" not in joined, f"a multi-word term split by a newline is caught  ({joined!r})")
    assert_that("Then the meeting ended." in joined, "the rest of the stream still flows after the removal")

    # Regression: the force-flush used to cut at an arbitrary character, so a
    # term straddling the 2000-character mark was split and escaped.
    boundary_chunks = [("x " * 999) + "bit", "ch and then a good deal more text follows here. " + "filler word. " * 8]
    emitted = asyncio.run(drive_stream(boundary_chunks, ["bitch"]))
    assert_that("bitch" not in "".join(emitted), "a term straddling the force-flush point is caught")

    # Regression: after a flagged sentence the stream used to stop releasing
    # anything at all until flush(), because the trailing-word tally was measured
    # from the last sentence boundary (which moves) instead of the last match.
    stall_chunks = ["He is a bitch. "] + [
        f"Sentence number {index} is perfectly fine and clean here. " for index in range(12)
    ]

    async def drive_counting_releases(chunks, abusive_terms):
        with VerifierStub(abusive_terms = abusive_terms):
            guardrail = StreamingContentGuardrail(model = "gemini-2.5-flash-lite")
            release_count = 0
            for chunk in chunks:
                if await guardrail.accept(chunk):
                    release_count += 1
            await guardrail.flush()
            return release_count

    release_count = asyncio.run(drive_counting_releases(stall_chunks, ["bitch"]))
    assert_that(
        release_count >= 2,
        f"the stream keeps releasing after a flagged sentence rather than stalling until flush  ({release_count} release(s))",
    )


# ---------------------------------------------------------------------------
# 8. Cost and throughput
# ---------------------------------------------------------------------------

def verify_concurrency_isolation() -> None:
    section("Concurrency isolation")

    from Globals.Constants.ApiConcurrencyLimits import ApiConcurrencyLimits
    from Globals.Classes.Automation.Pools.ModelPool import ModelPool

    guardrail_model_name = ModelPool.CONTENT_GUARDRAIL_MODEL[0]

    # The whole point: the guardrail must not queue in the pool that the stream
    # it is inspecting is already holding a slot in. RedisSemaphore's acquire
    # loop polls forever with no timeout, so sharing the bucket is a deadlock,
    # not just a slowdown.
    assert_that(
        ContentGuardrailVerifier.CONCURRENCY_BUCKET != guardrail_model_name,
        f"the guardrail's semaphore bucket is not the model's own  "
        f"({ContentGuardrailVerifier.CONCURRENCY_BUCKET!r} vs {guardrail_model_name!r})",
    )
    assert_that(
        ContentGuardrailVerifier.CONCURRENCY_BUCKET in ApiConcurrencyLimits.MAX_CONCURRENT_BY_BUCKET,
        "the guardrail bucket has an explicit limit rather than silently taking the default",
    )

    # And the override actually reaches the outgoing request. The real provider
    # cannot be constructed without credentials, so the ModelPool entry is
    # pointed at a stand-in and everything above it runs for real.
    from Globals.Classes.Automation.AutomationCaller import AutomationCaller

    captured_metadata = {}

    class ProviderStub:
        async def execute(self, request):
            return None

    async def capture_call(self, request, validator, retries = 3):
        for content in request.get_inputs():
            captured_metadata.update(content.get_metadata() or {})
        return None

    original_model_entry = ModelPool.CONTENT_GUARDRAIL_MODEL
    original_call = AutomationCaller.call
    try:
        ModelPool.CONTENT_GUARDRAIL_MODEL = (guardrail_model_name, ProviderStub)
        AutomationCaller.call = capture_call
        asyncio.run(ContentGuardrailVerifier.verify(ContentGuardrailScanner.scan("He is a bitch.")))
    finally:
        ModelPool.CONTENT_GUARDRAIL_MODEL = original_model_entry
        AutomationCaller.call = original_call

    assert_that(
        captured_metadata.get("concurrency_bucket") == ContentGuardrailVerifier.CONCURRENCY_BUCKET,
        f"the bucket override is set on the outgoing request  ({captured_metadata})",
    )


def verify_cost_profile() -> None:
    section("Cost profile")

    import time

    clean_document = "The mitochondrion is the powerhouse of the cell. " * 1200
    start_time = time.perf_counter()
    for _repetition in range(20):
        ContentGuardrailScanner.scan(clean_document)
    elapsed_milliseconds = (time.perf_counter() - start_time) / 20 * 1000

    # Ten milliseconds is a deliberately loose ceiling -- the measured figure is
    # around two on a developer machine. It exists to catch a regression that
    # reintroduces per-character Python work or drops the trie, not to pin a
    # number to any particular CPU.
    assert_that(
        elapsed_milliseconds < 10.0,
        f"a clean {len(clean_document) // 1024} KB response scans in {elapsed_milliseconds:.2f} ms (ceiling 10 ms)",
    )

    assert_that(
        BannedTermLexicon.get_lowercase_pattern() is BannedTermLexicon.get_lowercase_pattern(),
        "the compiled pattern is memoised, not rebuilt per call",
    )


# ---------------------------------------------------------------------------
# 9. Live adjudication (opt-in)
# ---------------------------------------------------------------------------

def verify_live_adjudication() -> None:
    section("Live adjudication (network)")

    if (os.getenv("VERIFY_CONTENT_GUARDRAIL_NETWORK") or "").strip().lower() not in ("1", "true", "yes"):
        skip("set VERIFY_CONTENT_GUARDRAIL_NETWORK=1 to run one real gemini-2.5-flash-lite adjudication")
        return

    from Globals.Utility.EnvironmentLoader import EnvironmentLoader
    EnvironmentLoader.load()

    abusive_text = (
        "The tutor lost his temper during the session. He told the student she was a stupid bitch "
        "and that she would never pass the examination. The institute later apologised."
    )
    quoted_text = (
        "In the 1971 judgment the court recorded the exact words used by the accused, who had called "
        "the complainant a bitch, and held that such language constituted verbal abuse under the statute."
    )

    abusive_matches = ContentGuardrailScanner.scan(abusive_text)
    quoted_matches = ContentGuardrailScanner.scan(quoted_text)
    assert_that(len(abusive_matches) == 1 and len(quoted_matches) == 1, "both live fixtures flag exactly one term")

    verdicts = asyncio.run(ContentGuardrailVerifier.verify(abusive_matches + quoted_matches))

    if verdicts is None:
        assert_that(False, "the live adjudication returned no verdicts")
        return

    assert_that(len(verdicts) == 2, f"the model returned a verdict for both items  ({verdicts})")
    assert_that(verdicts.get(0, {}).get("bAbusive") is True, f"the abusive usage is judged abusive  ({verdicts.get(0)})")
    assert_that(verdicts.get(1, {}).get("bAbusive") is False, f"the quoted usage is judged acceptable  ({verdicts.get(1)})")


# ---------------------------------------------------------------------------

def main() -> int:
    print("Content guardrail verification")
    print(f"Agent directory: {AGENT_DIRECTORY}")

    verify_word_boundaries()
    verify_academic_allowlist()
    verify_sentence_and_context()
    verify_json_segmentation()
    verify_redaction()

    # Captures the guardrail's own log writes for the rest of the run. Without
    # it Logger falls back to standard output (correctly -- there is no database
    # here) and buries the assertions under real log lines.
    with LoggerStub():
        verify_pipeline()
        verify_streaming()

    verify_concurrency_isolation()
    verify_cost_profile()
    verify_live_adjudication()

    print(f"\n{passed_count} passed, {failed_count} failed, {skipped_count} skipped")

    return 1 if failed_count else 0


if __name__ == "__main__":
    sys.exit(main())
