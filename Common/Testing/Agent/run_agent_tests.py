# Deterministic unit tests for the Agent's pure utility functions.
# Run with the Agent virtualenv so numpy is available:
#   Agent/.venv/Scripts/python.exe Common/Testing/Agent/run_agent_tests.py
# Writes its result JSON to $RESULT_FILE (set by the orchestrator) or, when run
# standalone, to Common/Reports/.results/agent.json.

import math
import os
import sys
from pathlib import Path

# Make the Agent package importable (its modules use `from Globals...` imports).
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
AGENT_ROOT = REPOSITORY_ROOT / "Agent"
sys.path.insert(0, str(AGENT_ROOT))

from Globals.Utility.CosineSimilarity import cosine_similarity
from Globals.Utility.ExpandPageRanges import (
    expand_page_ranges, is_full_document, is_full_document_range
)
from Globals.Utility.StripJsonMarkdown import strip_json_markdown
from Globals.Utility.SanitizeHtmlResponse import sanitize_html_response
from Globals.Utility.SanitizeFilename import sanitize_filename
from Globals.Utility.JoinPath import join_path
from Globals.Utility.ArgumentParser import argument_parser
from Globals.Classes.Decorators.PageRange import PageRange
from Globals.Model.DeckLicense import DeckLicense

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _harness import Harness  # noqa: E402

CATALOGUED = [
    "cosine_similarity", "expand_page_ranges", "is_full_document",
    "is_full_document_range", "strip_json_markdown", "sanitize_html_response",
    "sanitize_filename", "join_path", "argument_parser",
    "DeckLicense.round_trip",
]

harness = Harness("Agent", "Utility Functions (Python)", CATALOGUED)


def approximately(actual, expected, tolerance=1e-9):
    assert abs(actual - expected) <= tolerance, f"expected ~{expected}, got {actual}"


# -- cosine_similarity --------------------------------------------------------

@harness.test("cosine_similarity: identical vectors -> 1.0", "cosine_similarity")
def _():
    approximately(cosine_similarity([1, 2, 3], [1, 2, 3]), 1.0)


@harness.test("cosine_similarity: opposite vectors -> -1.0", "cosine_similarity")
def _():
    approximately(cosine_similarity([1, 2, 3], [-1, -2, -3]), -1.0)


@harness.test("cosine_similarity: orthogonal vectors -> 0.0", "cosine_similarity")
def _():
    approximately(cosine_similarity([1, 0], [0, 1]), 0.0)


@harness.test("cosine_similarity: degenerate inputs -> 0.0 without throwing", "cosine_similarity")
def _():
    assert cosine_similarity(None, [1, 2]) == 0.0
    assert cosine_similarity([], []) == 0.0
    assert cosine_similarity([1, 2, 3], [1, 2]) == 0.0
    assert cosine_similarity([0, 0], [0, 0]) == 0.0


# -- expand_page_ranges -------------------------------------------------------

@harness.test("expand_page_ranges: empty list -> full document", "expand_page_ranges")
def _():
    assert expand_page_ranges([], 5) == [1, 2, 3, 4, 5]


@harness.test("expand_page_ranges: {0,0} sentinel -> full document", "expand_page_ranges")
def _():
    assert expand_page_ranges([PageRange(0, 0)], 3) == [1, 2, 3]


@harness.test("expand_page_ranges: overlapping ranges unioned and sorted", "expand_page_ranges")
def _():
    assert expand_page_ranges([PageRange(1, 3), PageRange(2, 4)], 10) == [1, 2, 3, 4]


@harness.test("expand_page_ranges: out-of-bounds end clamped to total", "expand_page_ranges")
def _():
    assert expand_page_ranges([PageRange(8, 99)], 10) == [8, 9, 10]


@harness.test("expand_page_ranges: total_pages <= 0 -> []", "expand_page_ranges")
def _():
    assert expand_page_ranges([PageRange(1, 5)], 0) == []


@harness.test("is_full_document / is_full_document_range recognize sentinels",
              "is_full_document")
def _():
    assert is_full_document([]) is True
    assert is_full_document([PageRange(0, 0)]) is True
    assert is_full_document([PageRange(1, 2)]) is False
    assert is_full_document_range(PageRange(0, 0)) is True
    assert is_full_document_range(PageRange(1, 1)) is False


@harness.test("is_full_document_range: standalone real range is not full", "is_full_document_range")
def _():
    assert is_full_document_range(PageRange(2, 9)) is False


# -- strip_json_markdown ------------------------------------------------------

@harness.test("strip_json_markdown: ```json fence is unwrapped and parsed", "strip_json_markdown")
def _():
    parsed = strip_json_markdown('```json\n{"a": 1, "b": [2, 3]}\n```')
    assert parsed == {"a": 1, "b": [2, 3]}, parsed


@harness.test("strip_json_markdown: bare JSON object parses", "strip_json_markdown")
def _():
    assert strip_json_markdown('{"x": true}') == {"x": True}


@harness.test("strip_json_markdown: empty input returns '{}' string", "strip_json_markdown")
def _():
    assert strip_json_markdown("") == "{}"


@harness.test("strip_json_markdown: invalid JSON returns None", "strip_json_markdown")
def _():
    assert strip_json_markdown("not json at all {") is None


# -- sanitize_html_response ---------------------------------------------------

@harness.test("sanitize_html_response: {'html': ...} wrapper unwrapped", "sanitize_html_response")
def _():
    assert sanitize_html_response('{"html": "<p>Hi</p>"}') == "<p>Hi</p>"


@harness.test("sanitize_html_response: ```html fence unwrapped", "sanitize_html_response")
def _():
    assert sanitize_html_response("```html\n<div>X</div>\n```") == "<div>X</div>"


@harness.test("sanitize_html_response: plain HTML passes through", "sanitize_html_response")
def _():
    assert sanitize_html_response("<h1>Title</h1>") == "<h1>Title</h1>"


@harness.test("sanitize_html_response: empty input returns ''", "sanitize_html_response")
def _():
    assert sanitize_html_response("") == ""


# -- sanitize_filename --------------------------------------------------------

@harness.test("sanitize_filename: reserved characters replaced with _", "sanitize_filename")
def _():
    assert sanitize_filename('a<b>c:d"e/f\\g|h?i*j') == "a_b_c_d_e_f_g_h_i_j"


@harness.test("sanitize_filename: surrounding whitespace trimmed", "sanitize_filename")
def _():
    assert sanitize_filename("  report.pdf  ") == "report.pdf"


# -- join_path ----------------------------------------------------------------

@harness.test("join_path: parts joined with separator", "join_path")
def _():
    assert join_path("/", "a", "b", "c") == "a/b/c"


@harness.test("join_path: empty parts dropped and separators collapsed", "join_path")
def _():
    assert join_path("/", "a/", "", "/b/") == "a/b"


@harness.test("join_path: backslashes normalized to separator", "join_path")
def _():
    assert join_path("/", "a\\b", "c") == "a/b/c"


# -- argument_parser ----------------------------------------------------------

@harness.test("argument_parser: bare flags become True, key=value pairs are captured", "argument_parser")
def _():
    assert argument_parser(["--debug", "--mode=fast"]) == {"--debug": True, "--mode": "fast"}
    assert argument_parser(["--timeout=30"]) == {"--timeout": "30"}


@harness.test("argument_parser: empty input -> empty dict", "argument_parser")
def _():
    assert argument_parser([]) == {}


@harness.test("argument_parser: only the first '=' splits the key (value before any further '=')", "argument_parser")
def _():
    # "key=val=ue" splits to ["key", "val", "ue"]; the value taken is index 1.
    assert argument_parser(["key=val=ue"]) == {"key": "val"}


# -- DeckLicense model round-trip ---------------------------------------------

@harness.test("DeckLicense.from_json/to_json: round-trip preserves identity + version fields", "DeckLicense.round_trip")
def _():
    license = DeckLicense.from_json({"id": "lic-1", "userId": "u1", "deckId": "d1", "status": 1, "keyVersion": 3})
    restored = DeckLicense.from_json(license.to_json())
    assert restored.get_id() == "lic-1"
    assert restored.get_user_id() == "u1"
    assert restored.get_deck_id() == "d1"
    assert restored.get_status() == license.get_status()
    assert restored.get_key_version() == 3


@harness.test("DeckLicense.from_json: a null expiry maps to the FOREVER sentinel and survives a round-trip", "DeckLicense.round_trip")
def _():
    license = DeckLicense.from_json({"id": "lic-2", "userId": "u1", "deckId": "d1", "status": 1, "expiresAt": None})
    assert license.get_expires_at() == DeckLicense.FOREVER
    restored = DeckLicense.from_json(license.to_json())
    assert restored.get_expires_at() == DeckLicense.FOREVER


if __name__ == "__main__":
    default_result = REPOSITORY_ROOT / "Common" / "Reports" / ".results" / "agent.json"
    harness.run_and_write(os.environ.get("RESULT_FILE", str(default_result)))
