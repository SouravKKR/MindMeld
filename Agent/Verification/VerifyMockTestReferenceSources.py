"""
Verification harness for mock-test reference papers and the web-precedence rule.

Run from the Agent directory:
    .venv/Scripts/python.exe Verification/VerifyMockTestReferenceSources.py    (Windows)
    .venv/bin/python Verification/VerifyMockTestReferenceSources.py            (Linux)

TWO THINGS ARE BEING PROTECTED HERE.

1. THE GROUNDING METADATA KEY. GenerateMockTests asked for provider grounding
   with metadata={"google_search": True} at both call sites, and
   GoogleEnterpriseAiProvider only ever reads "enable_search". The result was
   that the blueprint and instruction calls ran ungrounded for their whole life
   while both prompts told the model to use its search-grounded knowledge —
   a defect invisible from the outside, because an ungrounded answer to those
   prompts still looks like an answer. This asserts the key is the one the
   provider actually reads, and that the dead one is gone.

2. THE WEB IS A FALLBACK, NOT A SUPPLEMENT. A user who uploaded a paper has said
   what these tests should look like. Searching the open web for someone else's
   would dilute that with material they did not choose and cannot vouch for. This
   asserts every web leg is closed when a reference paper is present.

One tier, no opt-in. Static analysis plus pure logic; no services, no provider.
"""

import re
import sys
from pathlib import Path

AGENT_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENT_DIRECTORY))

from Globals.Classes.Task.AutoGeneration.MockTestGenerationSettings import MockTestGenerationSettings
from Globals.Classes.Decorators.ExtractableInformationSource import ExtractableInformationSource
from Globals.Enumerations.InformationSourceTypes import InformationSourceTypes
from Globals.Model.InformationSource import InformationSource
from Workflows.GenerateMockTests.GenerateMockTests import GenerateMockTests


WORKFLOW_PATH = AGENT_DIRECTORY / "Workflows" / "GenerateMockTests" / "GenerateMockTests.py"
PROVIDER_PATH = AGENT_DIRECTORY / "Globals" / "Classes" / "Automation" / "Providers" / "GoogleEnterpriseAiProvider.py"
MAP_TOPICS_PATH = AGENT_DIRECTORY / "Workflows" / "MapTopicsWithContent" / "MapTopicsWithContent.py"

passed_count = 0
failed_count = 0


def assert_that(condition: bool, description: str) -> None:
    global passed_count, failed_count
    if condition:
        passed_count += 1
        print(f"  PASS  {description}")
    else:
        failed_count += 1
        print(f"  FAIL  {description}")


def section(title: str) -> None:
    print(f"\n=== {title} ===")


def build_source(source_type, name="paper.pdf", content_hash="hash-1"):
    return ExtractableInformationSource(
        information_source = InformationSource(
            source_type = source_type,
            name = name,
            hash = content_hash,
            directory_path = "/InformationSources/user-1",
        ),
        page_ranges = [],
    )


def build_workflow(information_sources=None, reference_sources=None, content_sources=None, exam_name="JEE Main"):
    settings = MockTestGenerationSettings()
    settings.set_information_sources(information_sources or [])
    settings.set_reference_sources(reference_sources or [])

    payload = settings.to_json()
    payload["examName"] = exam_name
    payload["subjectName"] = "Physics"

    if content_sources is not None:
        payload["contentSources"] = content_sources

    return GenerateMockTests(payload)


def verify_grounding_metadata_key() -> None:
    section("Provider grounding asks for the key the provider actually reads")

    workflow_source = WORKFLOW_PATH.read_text(encoding="utf-8")
    provider_source = PROVIDER_PATH.read_text(encoding="utf-8")

    # Matched on the QUOTED KEY, not the bare name, so the comment explaining why
    # the old key was wrong — which necessarily names it — cannot trip this. Same
    # discipline as the ModelPool boundary regex.
    assert_that(
        '"google_search"' not in workflow_source,
        "the dead \"google_search\" metadata key is gone from GenerateMockTests",
    )

    assert_that(
        '"enable_search"' in workflow_source,
        "the workflow asks for grounding with \"enable_search\"",
    )

    assert_that(
        'metadata.get("enable_search"' in provider_source,
        "\"enable_search\" is the key the provider reads — the two ends agree",
    )

    # Both call sites must route through the one helper, or a future edit fixes
    # the gating in one place and leaves the other grounded when it should not be.
    assert_that(
        workflow_source.count("metadata=self.__build_search_metadata()") == 2,
        "both grounded call sites go through the single gating helper",
    )


def verify_reference_paper_detection() -> None:
    section("A reference paper is recognised wherever it was supplied")

    question_paper = build_source(InformationSourceTypes.QUESTION_PAPER)
    provided_document = build_source(InformationSourceTypes.PROVIDED_DOCUMENTS, name="textbook.pdf")

    cases = [
        ("no sources at all", build_workflow(), False),
        ("a question paper in the general list", build_workflow(information_sources=[question_paper]), True),
        ("a question paper in the mock-test reference list", build_workflow(reference_sources=[question_paper]), True),
        ("an ordinary document is NOT a reference paper", build_workflow(information_sources=[provided_document]), False),
        (
            "a licensed content source counts as one (the paid-deck route)",
            build_workflow(content_sources=[{"informationSourceId": "src-1", "name": "PYQ.pdf"}]),
            True,
        ),
    ]

    for label, workflow, expected in cases:
        actual = workflow._GenerateMockTests__has_reference_paper_source()
        assert_that(actual == expected, f"{label} -> reference paper present = {expected}")


def verify_web_is_suppressed_when_a_paper_is_supplied() -> None:
    section("Every web leg closes when a reference paper is present")

    workflow_source = WORKFLOW_PATH.read_text(encoding="utf-8")

    with_paper = build_workflow(reference_sources=[build_source(InformationSourceTypes.QUESTION_PAPER)])
    without_paper = build_workflow()

    with_paper._GenerateMockTests__b_has_reference_paper = True
    without_paper._GenerateMockTests__b_has_reference_paper = False

    assert_that(
        with_paper._GenerateMockTests__build_search_metadata() == {},
        "grounding is OFF for the blueprint and instruction calls when a paper was supplied",
    )

    assert_that(
        without_paper._GenerateMockTests__build_search_metadata() == {"enable_search": True},
        "grounding is ON when nothing was supplied — the web is the fallback, not the default",
    )

    # The blueprint's PDF search is the most expensive web leg and the one most
    # likely to be reinstated by accident, so its guard is asserted in source.
    assert_that(
        "if not self.__b_has_reference_paper and self.__exam_name" in workflow_source,
        "the blueprint's reference procurement is guarded on the same flag, not only on the exam name",
    )

    assert_that(
        "if question_paper_pdfs:" in workflow_source
        and "skipping the web PYQ harvest" in workflow_source,
        "the PYQ web harvest is skipped outright when an uploaded paper produced seeds",
    )

    assert_that(
        "question_paper_pdfs: list[bytes] = []" in workflow_source,
        "question_paper_pdfs is bound before the try block, so the harvest guard cannot raise on a read failure",
    )


def verify_per_topic_web_fallback() -> None:
    section("Retrieval consults the web only for topics the documents did not cover")

    map_topics_source = MAP_TOPICS_PATH.read_text(encoding="utf-8")

    assert_that(
        "b_documents_covered_topic = primary_chunk_count > 0" in map_topics_source,
        "coverage is decided per topic, from whether that topic got document chunks",
    )

    assert_that(
        "if enabled_web_source_types and not b_documents_covered_topic:" in map_topics_source,
        "web chunks are merged only into topics the documents said nothing about",
    )

    # Description-only mode produces no primary chunks anywhere and relies on the
    # empty-chunk topic file still being written. Tightening this guard would
    # silently kill that whole mode, so it is asserted to stay as it is.
    assert_that(
        "if not content_chunks and not enabled_web_source_types:" in map_topics_source,
        "the topic-file guard still keys on enabled web sources, so description-only mode keeps working",
    )

    assert_that(
        "uncovered_leaves = [" in map_topics_source
        and "__dispatch_web_fetches(main_task_id, uncovered_leaves" in map_topics_source,
        "web pages are FETCHED only for uncovered topics — the pages are not scraped and then discarded",
    )


def verify_reference_sources_are_a_separate_member() -> None:
    section("Reference papers survive an edit to the general source list")

    settings = MockTestGenerationSettings()

    assert_that(
        hasattr(settings, "get_reference_sources") and hasattr(settings, "set_reference_sources"),
        "MockTestGenerationSettings carries referenceSources of its own",
    )

    # This is the regression the separate member exists to prevent:
    # AutomaticGenerationPage mirrors the general list into every secondary
    # settings object with a whole-array replace, so anything stored in
    # informationSources by the mock-test picker would be wiped by the user's
    # next edit above it.
    reference_paper = build_source(InformationSourceTypes.QUESTION_PAPER, name="PYQ 2024.pdf")
    settings.set_reference_sources([reference_paper])
    settings.set_information_sources([build_source(InformationSourceTypes.PROVIDED_DOCUMENTS, name="textbook.pdf")])

    assert_that(
        len(settings.get_reference_sources()) == 1,
        "mirroring the general information sources does not clear the reference papers",
    )

    round_tripped = MockTestGenerationSettings.from_json(settings.to_json())

    assert_that(
        len(round_tripped.get_reference_sources() or []) == 1,
        "reference papers survive the to_json/from_json round trip the task payload makes",
    )

    # A payload saved before this member existed must still parse.
    legacy_payload = settings.to_json()
    legacy_payload.pop("referenceSources", None)
    legacy_settings = MockTestGenerationSettings.from_json(legacy_payload)

    assert_that(
        (legacy_settings.get_reference_sources() or []) == [],
        "a payload predating referenceSources parses to an empty list rather than failing",
    )


def verify_union_and_deduplication() -> None:
    section("Both lists are read, and the same paper in both is read once")

    workflow_source = WORKFLOW_PATH.read_text(encoding="utf-8")

    shared_paper = build_source(InformationSourceTypes.QUESTION_PAPER, name="PYQ.pdf", content_hash="same-hash")
    workflow = build_workflow(information_sources=[shared_paper], reference_sources=[shared_paper])

    combined = workflow._GenerateMockTests__collect_source_extractables()

    assert_that(len(combined) == 2, "the union keeps both entries — deduplication happens where it matters")

    assert_that(
        "seen_content_hashes" in workflow_source,
        "the PDF reader deduplicates on the content hash, so a paper in both lists is not extracted twice",
    )

    assert_that(
        "url not in specific_urls" in workflow_source,
        "a pinned URL appearing in both lists is fetched once",
    )


def main() -> int:
    print(f"Verifying mock-test reference sources and web precedence (Agent at {AGENT_DIRECTORY})")

    verify_grounding_metadata_key()
    verify_reference_paper_detection()
    verify_web_is_suppressed_when_a_paper_is_supplied()
    verify_per_topic_web_fallback()
    verify_reference_sources_are_a_separate_member()
    verify_union_and_deduplication()

    section("Summary")
    print(f"  passed: {passed_count}")
    print(f"  failed: {failed_count}")

    return 1 if failed_count else 0


if __name__ == "__main__":
    sys.exit(main())
