"""
Verification harness for how a content refinement reads the model's reply, and
for the two budgets that decide whether there is a usable reply at all.

Run from the Agent directory:
    .venv/Scripts/python.exe Verification/VerifyRefinementReplyParsing.py    (Windows)
    .venv/bin/python Verification/VerifyRefinementReplyParsing.py            (Linux)

WHY THIS EXISTS. Refinement failed intermittently in production with "The model
returned an unusable response shape" — a message that named the model as the
culprit for at least four unrelated causes: a reply cut off by the output-token
budget, a reply wrapped in a markdown fence, a reply with a sentence in front of
the JSON, and no reply at all (which the old helper turned into the STRING "{}"
and so into a shape complaint). None of them left any evidence: the endpoint
returned 502 and logged nothing, and the worker's stderr was discarded on
exactly that path.

So the checks here are about telling those cases APART, and they are source- and
unit-level on purpose — a model call cannot be part of a deterministic harness,
and the failure was never in the calling, it was in the reading.

One tier, no opt-in. Everything runs offline with no services.
"""

import sys
from pathlib import Path

# This harness lives in Agent/Verification/, so the Agent package root is one
# level up.
AGENT_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENT_DIRECTORY))

from Globals.Utility.JsonReplyReader import JsonReplyReader
from Globals.Utility.StripJsonMarkdown import strip_json_markdown
from Globals.Classes.Generic.TokenSafeContent import TokenSafeContent
from Workflows.RefineContent.RefineContent import ContentRefiner


WORKFLOW_PATH = AGENT_DIRECTORY / "Workflows" / "RefineContent" / "RefineContent.py"
PROVIDER_PATH = AGENT_DIRECTORY / "Globals" / "Classes" / "Automation" / "Providers" / "GoogleEnterpriseAiProvider.py"

passed_count = 0
failed_count = 0


def assert_that(b_condition: bool, description: str, detail: str = "") -> None:
    global passed_count, failed_count

    if b_condition:
        passed_count += 1
        print(f"  PASS  {description}")
    else:
        failed_count += 1
        print(f"  FAIL  {description}" + (f"\n        {detail}" if detail else ""))


def section(title: str) -> None:
    print(f"\n=== {title} ===")


def verify_reply_shapes() -> None:
    section("Every reply shape this workflow actually receives")

    usable_replies = [
        ("a bare object", '{"revisedHtml": "<p>hi</p>"}'),
        ("a json-fenced object", '```json\n{"revisedHtml": "<p>hi</p>"}\n```'),
        ("an unlabelled fence", '```\n{"revisedHtml": "x"}\n```'),
        # `jsonc`, `JSON` and `js` all appear in the wild and all used to survive
        # the hardcoded json/python pair only to fail inside json.loads.
        ("a jsonc label", '```jsonc\n{"revisedHtml": "x"}\n```'),
        ("an uppercase JSON label", '```JSON\n{"revisedHtml": "x"}\n```'),
        # Grounding relaxes structured-output adherence, so the model
        # intermittently introduces its answer before giving it.
        ("prose wrapped around the object", 'Here is the revision: {"revisedHtml": "x"} Let me know!'),
        # THE case split("```")[1] truncated: a lesson about programming quotes a
        # code block, so the payload contains a fence inside a string value.
        ("a fence inside a string value", '```json\n{"revisedHtml": "use ```py``` here"}\n```'),
        # HTML carries braces in inline styles, KaTeX and code samples, so a scan
        # to the last closing brace returns the wrong slice without string state.
        ("braces inside a string value", '{"revisedHtml": "<p style=\\"a:b\\">f(x) = {1,2}</p>"}'),
    ]

    for description, raw_reply in usable_replies:
        parsed = JsonReplyReader.read_object(raw_reply)
        assert_that(
            isinstance(parsed, dict) and isinstance(parsed.get("revisedHtml"), str),
            f"{description} is read",
            repr(parsed),
        )

    unusable_replies = [
        ("an empty reply", ""),
        ("whitespace only", "   \n  "),
        ("a non-string", None),
        # The signature of the failure this whole change is about.
        ("a reply truncated mid-object", '{"revisedHtml": "<p>half of a lesso'),
        ("a refusal in prose", "I'm sorry, I can't help with that."),
        ("an array where an object was required", "[1, 2, 3]"),
    ]

    for description, raw_reply in unusable_replies:
        assert_that(JsonReplyReader.read_object(raw_reply) is None, f"{description} is rejected")

    # A dict or nothing. The contract exists because the old helper's
    # dict | None | str("{}") union is precisely what made "no reply at all"
    # indistinguishable from "wrong shape".
    # The exact confusion the old helper caused: it returned the STRING "{}" for
    # an empty reply, callers tested isinstance(parsed, dict), and so "the model
    # said nothing" was reported as "the model returned an unusable shape".
    assert_that(
        not isinstance(JsonReplyReader.read_object(""), str) and strip_json_markdown("") == "{}",
        "an empty reply is never the STRING '{}' here, though the old helper still returns it",
    )
    assert_that(JsonReplyReader.read_list("[1,2,3]") == [1, 2, 3], "read_list returns a list")
    assert_that(JsonReplyReader.read_list('{"a":1}') is None, "read_list refuses an object")

    # The recovery an unterminated fence still gets: the fence reader declines to
    # guess, and the balanced-span reader independently finds a COMPLETE object.
    # That is a recovery, not a guess — a truncated object has no balanced span,
    # which the truncation case above proves.
    assert_that(
        JsonReplyReader.read_object('```json\n{"revisedHtml": "x"}') is not None,
        "an unterminated fence around a COMPLETE object is still recovered",
    )


def verify_shared_helper_untouched() -> None:
    section("The shared helper was not redefined underneath 25 other files")

    # strip_json_markdown is parsed through by paid-deck generation, paid-deck
    # verification, mock tests, syllabus processing and the content guardrail.
    # Changing its contract to fix ONE workflow would trade a known bug for an
    # unknown number of them, so the new reader sits alongside it.
    assert_that(strip_json_markdown('{"a": 1}') == {"a": 1}, "strip_json_markdown still parses a bare object")
    assert_that(strip_json_markdown("") == "{}", "...and still returns its historical '{}' for an empty reply")
    assert_that(strip_json_markdown("not json at all") is None, "...and still returns None for unparsable input")


def verify_reply_reading_is_shared() -> None:
    section("The validator and the caller cannot disagree")

    source = WORKFLOW_PATH.read_text(encoding = "utf-8")

    # One parse, two callers. Written twice, the validator would eventually
    # accept something the code after the call rejected, and the retry budget
    # would be spent proving it.
    assert_that(source.count("def __read_revision_payload") == 1, "the reply is parsed in exactly one place")
    assert_that(
        source.count("cls.__read_revision_payload(") >= 2,
        "...and both the validator and the post-call path go through it",
    )

    # AutomationCaller only consults `retries` when a validator is supplied.
    # Passing None made `retries = 2` dead code and turned one bad reply into a
    # user-visible 502.
    assert_that(
        "caller.call(request, cls.__is_usable_reply" in source,
        "the call supplies a validator, so its retry count is live",
    )
    assert_that(
        "caller.call(request, None" not in source,
        "...and no longer passes None while asking for retries",
    )

    assert_that(
        "strip_json_markdown" not in source,
        "the workflow no longer reads replies through the weaker shared helper",
    )


def verify_budgets() -> None:
    section("The two budgets that decide whether a reply can be complete")

    # Nothing in this chain used to set an output budget, so the call ran on the
    # model default while the prompt demanded the FULL passage back — which is
    # where an intermittent truncation of a long lesson comes from.
    source = WORKFLOW_PATH.read_text(encoding = "utf-8")
    assert_that('"max_output_tokens"' in source, "an explicit output budget is set for the call")

    small_passage_budget = max(
        ContentRefiner.MINIMUM_OUTPUT_TOKEN_BUDGET,
        10 * ContentRefiner.OUTPUT_BUDGET_PASSAGE_MULTIPLIER + ContentRefiner.OUTPUT_BUDGET_HEADROOM_TOKENS,
    )
    large_passage_budget = max(
        ContentRefiner.MINIMUM_OUTPUT_TOKEN_BUDGET,
        11000 * ContentRefiner.OUTPUT_BUDGET_PASSAGE_MULTIPLIER + ContentRefiner.OUTPUT_BUDGET_HEADROOM_TOKENS,
    )

    assert_that(small_passage_budget == ContentRefiner.MINIMUM_OUTPUT_TOKEN_BUDGET, "a tiny passage still gets the floor budget")
    assert_that(large_passage_budget > 11000, "a long passage gets a budget bigger than the passage itself")
    assert_that(
        large_passage_budget >= 11000 * 2,
        "...at least twice it, because the reply echoes the passage AND adds a summary",
    )

    # REFUSED, not truncated: the prompt orders the model to return the whole
    # passage, so a capped input produces a revision with the back half silently
    # deleted — presented for approval through the gate that exists to stop
    # exactly that.
    assert_that(
        "cap_content_for_prompt" not in source,
        "an over-long passage is never truncated to fit",
    )
    assert_that(
        "MAXIMUM_PASSAGE_TOKEN_ESTIMATE" in source and "too long to refine in one pass" in source,
        "...it is refused, with a message that says why",
    )

    over_long_passage = "word " * (ContentRefiner.MAXIMUM_PASSAGE_TOKEN_ESTIMATE * 2)
    assert_that(
        TokenSafeContent.estimate_token_count(over_long_passage) > ContentRefiner.MAXIMUM_PASSAGE_TOKEN_ESTIMATE,
        "the refusal threshold is reachable by a real passage",
    )


def verify_truncation_guard() -> None:
    section("Truncation is detected rather than reported as a bad shape")

    source = PROVIDER_PATH.read_text(encoding = "utf-8")

    assert_that("__raise_if_truncated" in source, "the Google provider checks the finish reason")
    assert_that(
        'TRUNCATED_FINISH_REASON_NAME = "MAX_TOKENS"' in source,
        "...against MAX_TOKENS, compared by name so an SDK enum move cannot silently disable it",
    )
    assert_that(
        source.index("__raise_if_truncated(response") < source.index("outputs = []"),
        "...before anything reads the text, so a truncated reply never reaches a parser",
    )
    assert_that(
        "output-token budget" in source,
        "...and says what actually happened rather than blaming the reply's shape",
    )

    # Deliberately narrow. Raising on the safety family would change the failure
    # behaviour of every workflow on this provider for a symptom none reported —
    # a blocked candidate already arrives as empty outputs, which callers handle.
    assert_that(
        "RECITATION" not in source and "SAFETY" not in source,
        "only MAX_TOKENS raises; the safety family is left alone",
    )

    # response.text is a property that RAISES when the response carries no usable
    # parts, so the guarded read has to be used on both paths, not just one.
    assert_that(
        "if response.text:" not in source,
        "the response text is never read unguarded",
    )


def verify_failure_leaves_evidence() -> None:
    section("A failure now leaves evidence")

    source = WORKFLOW_PATH.read_text(encoding = "utf-8")

    assert_that("__log_unusable_reply" in source, "the worker logs an unusable reply")
    assert_that("LOGGED_REPLY_PREFIX_LENGTH" in source, "...bounded to a prefix, because these lines are persisted")

    # The passage, the reviewer's instruction and any attached reference document
    # are reported as LENGTHS and never as content. The reference document in
    # particular is third-party material under a declared licence whose retention
    # and legal-hold machinery a copy in the log store would defeat.
    assert_that(
        "_log(f\"Reply unusable" in source or "Reply unusable" in source,
        "...naming the reply's length and its first characters",
    )
    assert_that(
        "reference_source_text[:" not in source,
        "the attached reference document is never logged, not even a prefix",
    )


def main() -> int:
    print("Verifying refinement reply parsing...\n")

    verify_reply_shapes()
    verify_shared_helper_untouched()
    verify_reply_reading_is_shared()
    verify_budgets()
    verify_truncation_guard()
    verify_failure_leaves_evidence()

    print(f"\nPassed: {passed_count}   Failed: {failed_count}")
    return 0 if failed_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
