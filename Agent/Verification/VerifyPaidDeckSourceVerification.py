"""
Verification harness for the source-grounded paid-deck verification pass.

Run from the Agent directory:
    .venv/Scripts/python.exe Verification/VerifyPaidDeckSourceVerification.py    (Windows)
    .venv/bin/python Verification/VerifyPaidDeckSourceVerification.py            (Linux)

THE FIRST CHECK IS THE IMPORTANT ONE. ModelPool carries a ROUTE BOUNDARY whose
closing sentence is that nothing reaching a PAID_DECK_* entry has ever seen a
third-party document — and that sentence is what the independent-creation
position for paid-deck content rests on. This workflow is the first code in the
repository that reads an administrator's uploaded document in service of a paid
deck, so it is also the first thing that could make that sentence false. It runs
on SOURCE_GROUNDED_VERIFICATION_MODEL, deliberately outside the boundary, and a
source-level guard here asserts it stays that way. A comment saying "do not do
X" is not a control; a test that fails when someone does X is.

The rest is ordinary: prompt placeholders resolve, flags normalise the way the
publish gate and the review dialog expect, and the retrieval selects passages
that actually relate to the item.

One tier, no opt-in. Everything here runs offline with no services.
"""

import ast
import re
import sys
from pathlib import Path

# This harness lives in Agent/Verification/, so the Agent package root is one
# level up.
AGENT_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENT_DIRECTORY))

from Globals.Classes.Automation.Pools.ModelPool import ModelPool
from Globals.Classes.Automation.Pools.PromptPool import PromptPool
from Globals.Enumerations.WebFetchReasons import WebFetchReasons
from Workflows.PaidDeckSourceVerification.AdminSourceCorpus import AdminSourceCorpus
from Workflows.PaidDeckSourceVerification.PaidDeckSourceVerification import PaidDeckSourceVerification


WORKFLOW_PATH = AGENT_DIRECTORY / "Workflows" / "PaidDeckSourceVerification" / "PaidDeckSourceVerification.py"
CORPUS_PATH = AGENT_DIRECTORY / "Workflows" / "PaidDeckSourceVerification" / "AdminSourceCorpus.py"

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


def verify_route_boundary() -> None:
    section("The admin's documents never reach a PAID_DECK_* model entry")

    workflow_source = WORKFLOW_PATH.read_text(encoding="utf-8")
    corpus_source = CORPUS_PATH.read_text(encoding="utf-8")

    # Matched on the ATTRIBUTE ACCESS rather than the bare name, so the
    # boundary note's own prose — which necessarily says "PAID_DECK_*" while
    # explaining the rule — cannot satisfy or trip this.
    paid_deck_model_pattern = re.compile(r"ModelPool\.PAID_DECK_\w+")

    workflow_offenders = paid_deck_model_pattern.findall(workflow_source)
    corpus_offenders = paid_deck_model_pattern.findall(corpus_source)

    assert_that(
        len(workflow_offenders) == 0,
        "the workflow references no PAID_DECK_* model"
        + ("" if not workflow_offenders else f" -- found: {', '.join(sorted(set(workflow_offenders)))}"),
    )

    assert_that(
        len(corpus_offenders) == 0,
        "the corpus builder references no PAID_DECK_* model",
    )

    model_references = re.findall(r"ModelPool\.(\w+)", workflow_source)

    assert_that(
        set(model_references) == {"SOURCE_GROUNDED_VERIFICATION_MODEL"},
        f"the workflow uses exactly one model entry, the outside-boundary one (found: {sorted(set(model_references))})",
    )

    assert_that(
        model_references.count("SOURCE_GROUNDED_VERIFICATION_MODEL") == 1,
        "there is exactly ONE line to audit — the model is read in one place and passed around",
    )

    model_string, provider_class = ModelPool.SOURCE_GROUNDED_VERIFICATION_MODEL

    assert_that(
        provider_class.__name__ == "GoogleEnterpriseAiProvider",
        f"the entry routes to Google, not Anthropic (got {provider_class.__name__}) -- the 30-day "
        "abuse-monitoring window is a poor fit for a document someone attached",
    )

    assert_that(
        isinstance(model_string, str) and len(model_string) > 0,
        "the entry names a model",
    )

    # The generation stages must be untouched by this feature. If a verification
    # source ever reached one of them, the audit trail's central claim — that
    # the pipeline had no third-party document to work from — would be false
    # while still being printed.
    generation_stage_files = [
        AGENT_DIRECTORY / "Workflows" / "MapTopicsWithContent" / "KnowledgeChunkGenerator.py",
        AGENT_DIRECTORY / "Workflows" / "ProcessSyllabus" / "CoverageSummaryGenerator.py",
        AGENT_DIRECTORY / "Workflows" / "PrepareImages" / "PaidDeckVisualGenerator.py",
    ]

    leaking_files = []

    for stage_path in generation_stage_files:
        if not stage_path.exists():
            continue

        stage_source = stage_path.read_text(encoding="utf-8")

        if "AdminSourceCorpus" in stage_source or "paidDeckVerificationSources" in stage_source:
            leaking_files.append(stage_path.name)

    assert_that(
        len(leaking_files) == 0,
        "no generation stage reads a verification source"
        + ("" if not leaking_files else f" -- offenders: {', '.join(leaking_files)}"),
    )


def verify_prompts_resolve() -> None:
    section("Every prompt loads and every placeholder the workflow fills exists in it")

    workflow_source = WORKFLOW_PATH.read_text(encoding="utf-8")

    prompt_expectations = {
        "PAID_DECK_SOURCE_VERIFICATION_SYSTEM": [],
        "PAID_DECK_SOURCE_VERIFICATION_USER": ["{subject_name}", "{topic_chain}", "{reference_block}", "{content_block}"],
        "PAID_DECK_SOURCE_COVERAGE_SYSTEM": [],
        "PAID_DECK_SOURCE_COVERAGE_USER": ["{subject_name}", "{reference_block}", "{topic_block}"],
        "PAID_DECK_SOURCE_VISUAL_SYSTEM": [],
        "PAID_DECK_SOURCE_VISUAL_USER": ["{subject_name}", "{topic_chain}", "{visual_description}", "{reference_block}"],
    }

    for prompt_name, expected_placeholders in prompt_expectations.items():
        try:
            prompt_text = getattr(PromptPool, prompt_name)
        except Exception as load_error:
            assert_that(False, f"{prompt_name} loads ({load_error})")
            continue

        assert_that(len(prompt_text.strip()) > 0, f"{prompt_name} loads and is not empty")

        missing_placeholders = [
            placeholder for placeholder in expected_placeholders if placeholder not in prompt_text
        ]

        assert_that(
            len(missing_placeholders) == 0,
            f"{prompt_name} carries every placeholder the workflow fills"
            + ("" if not missing_placeholders else f" -- missing: {', '.join(missing_placeholders)}"),
        )

        # The inverse: a placeholder in the file that nothing replaces would
        # reach the model as a literal "{whatever}", which reads to the model as
        # an instruction it cannot follow.
        for placeholder in set(re.findall(r"\{[a-z_]+\}", prompt_text)):
            assert_that(
                f'.replace("{placeholder}"' in workflow_source,
                f"{prompt_name}'s {placeholder} is filled by the workflow",
            )


def verify_flag_normalisation() -> None:
    section("Flags normalise into the shape the publish gate and the review dialog read")

    workflow = object.__new__(PaidDeckSourceVerification)
    normalise = workflow._PaidDeckSourceVerification__normalise_flag

    batch = [
        {"item": {"topicChain": ["Unit I", "Optics"], "entityId": "material-1", "kind": "studyMaterial"}},
        {"item": {"topicChain": ["Unit I", "Thermodynamics"], "entityId": "card-1", "kind": "flashcard"}},
    ]

    complete_flag = normalise({
        "category": "constant",
        "severity": "BLOCKING",
        "itemIndex": 1,
        "quotedText": "3.1e8 m/s",
        "citedPassage": "The speed of light is 2.998e8 m/s.",
        "sourceName": "Physics Reference",
        "problem": "The deck states a different value.",
        "correctStatement": "2.998e8 m/s.",
    }, batch)

    assert_that(complete_flag is not None, "a complete flag survives")
    assert_that(complete_flag["source"] == "ADMIN_SOURCE", "it is stamped ADMIN_SOURCE, not MODEL")
    assert_that(complete_flag["severity"] == "blocking", "severity is lowercased to the value the gate compares against")
    assert_that(complete_flag["category"] == "CONSTANT", "category is upper-cased")
    assert_that(complete_flag["topicChain"] == ["Unit I", "Thermodynamics"], "itemIndex selects the right item's topic chain")
    assert_that(complete_flag["entityId"] == "card-1", "the flag names the entity it is about")

    # THE RULE THAT MATTERS. A flag with no quotable passage is the model's own
    # opinion wearing a cleared document's authority, which is exactly what the
    # separate ADMIN_SOURCE source value exists to keep apart.
    assert_that(
        normalise({"problem": "Something seems off.", "citedPassage": ""}, batch) is None,
        "a flag with no cited passage is DROPPED — it cannot point at the document it claims to rest on",
    )

    assert_that(
        normalise({"problem": "", "citedPassage": "A passage."}, batch) is None,
        "a flag with no stated problem is dropped",
    )

    assert_that(normalise("not a dict", batch) is None, "a non-object flag is dropped")

    out_of_range = normalise({
        "problem": "A problem.",
        "citedPassage": "A passage.",
        "itemIndex": 99,
    }, batch)

    assert_that(
        out_of_range is not None and out_of_range["entityId"] == "material-1",
        "an out-of-range itemIndex falls back to the first item rather than crashing the batch",
    )

    unknown_severity = normalise({"problem": "A problem.", "citedPassage": "A passage.", "severity": "critical"}, batch)
    assert_that(
        unknown_severity["severity"] == "advisory",
        "an unrecognised severity is advisory, not blocking — an unreadable answer must not block a publish",
    )

    section("A stage failure is not reported as a source disagreement")

    stage_flag = workflow._PaidDeckSourceVerification__build_stage_flag("Could not read a source.", "Try again.")

    assert_that(
        stage_flag["source"] == "STAGE",
        "a pass-level failure is sourced STAGE — labelling it ADMIN_SOURCE would put words in the document's mouth",
    )
    assert_that(stage_flag["severity"] == "advisory", "a pass that could not run is advisory, not evidence of an error")


def verify_retrieval() -> None:
    section("Retrieval selects passages that actually relate to the item")

    corpus = AdminSourceCorpus()

    optics_text = "The speed of light in vacuum is 2.998e8 metres per second, denoted c. " * 20
    thermodynamics_text = "Entropy is a measure of disorder in a thermodynamic system, denoted S. " * 20

    index_source = corpus._AdminSourceCorpus__index_source
    index_source(optics_text, "Optics Reference", "source-optics")
    index_source(thermodynamics_text, "Thermodynamics Reference", "source-thermo")
    corpus._AdminSourceCorpus__build_inverse_document_frequency()

    assert_that(not corpus.is_empty(), "the corpus indexed both sources")
    assert_that(
        corpus.get_loaded_source_names() == ["Optics Reference", "Thermodynamics Reference"],
        "both sources are named for the report",
    )

    optics_passages = corpus.select_passages("The speed of light is 3.1e8 m/s", ["Unit I", "Optics"])
    assert_that(len(optics_passages) > 0, "an item about light retrieves something")
    assert_that(
        optics_passages[0]["sourceName"] == "Optics Reference",
        "the best passage comes from the source that discusses it, not the other one",
    )
    assert_that(
        optics_passages[0]["sourceId"] == "source-optics",
        "the passage carries its source id, so a flag can name where it came from",
    )

    unrelated_passages = corpus.select_passages("The mitochondrion is the powerhouse of the cell", ["Biology"])
    assert_that(
        len(unrelated_passages) == 0,
        "an item no attached source discusses retrieves NOTHING — comparing unrelated text invites a false disagreement",
    )

    assert_that(
        len(corpus.select_passages("light speed", ["Optics"])) <= AdminSourceCorpus.PASSAGES_PER_ITEM,
        "retrieval is bounded, so one item cannot fill the prompt with a whole chapter",
    )

    # Determinism matters here beyond neatness: this pass's output ends up in an
    # audit trail, and a report that varies between two runs over identical
    # inputs invites the question of what else varied.
    first_selection = [passage["text"] for passage in corpus.select_passages("speed of light", ["Optics"])]
    second_selection = [passage["text"] for passage in corpus.select_passages("speed of light", ["Optics"])]
    assert_that(first_selection == second_selection, "selection is deterministic over identical inputs")

    section("A source that could not be read is reported, not silently skipped")

    unreadable_corpus = AdminSourceCorpus()
    unreadable_corpus._AdminSourceCorpus__problems.append("\"Missing.pdf\" could not be read.")

    assert_that(
        len(unreadable_corpus.get_problems()) == 1,
        "problems are exposed so the workflow can raise them as flags rather than claim a clean check",
    )


def verify_workflow_contract() -> None:
    section("The workflow's own contract")

    assert_that(
        PaidDeckSourceVerification.FLAG_SOURCE == "ADMIN_SOURCE",
        "the flag source value matches what the renderer and the review dialog branch on",
    )

    assert_that(
        WebFetchReasons.ADMIN_SOURCE_VERIFICATION.name == "ADMIN_SOURCE_VERIFICATION",
        "a URL-only source has its own web-fetch reason — every consulted URL is logged with why",
    )

    for ceiling_name in ["MAXIMUM_VERIFIED_ITEMS", "MAXIMUM_VERIFIED_VISUALS", "MAXIMUM_TOPICS_IN_COVERAGE_PASS"]:
        ceiling = getattr(PaidDeckSourceVerification, ceiling_name)
        assert_that(isinstance(ceiling, int) and ceiling > 0, f"{ceiling_name} bounds one pass")

    workflow_source = WORKFLOW_PATH.read_text(encoding="utf-8")

    # Every ceiling has to announce what it dropped. A silently truncated check
    # reported as a completed one is the failure mode this whole pass exists to
    # avoid in the content it inspects, so it must not be the pass's own.
    assert_that(
        workflow_source.count("__build_stage_flag") >= 4,
        "each ceiling and each read failure raises a stage flag rather than dropping work silently",
    )

    # Parsed rather than grepped: an import inside a function body is invisible
    # to a naive text search for a top-level import line.
    workflow_tree = ast.parse(workflow_source)
    imported_modules = set()

    for node in ast.walk(workflow_tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            imported_modules.add(node.module)

    assert_that(
        "Globals.Classes.Generation.FigureLocator" in imported_modules,
        "the visual pass reuses FigureLocator rather than re-deriving figure parsing",
    )

    corpus_tree = ast.parse(CORPUS_PATH.read_text(encoding="utf-8"))
    corpus_imports = {node.module for node in ast.walk(corpus_tree) if isinstance(node, ast.ImportFrom) and node.module}

    assert_that(
        "Workflows.PrepareForSimilaritySearch.EmbedPages" in corpus_imports,
        "the corpus reuses the similarity-search chunk shape rather than inventing a second one",
    )


def main() -> int:
    print(f"Verifying source-grounded paid-deck verification (Agent at {AGENT_DIRECTORY})")

    verify_route_boundary()
    verify_prompts_resolve()
    verify_flag_normalisation()
    verify_retrieval()
    verify_workflow_contract()

    print("\n=== Summary ===")
    print(f"  passed: {passed_count}")
    print(f"  failed: {failed_count}")

    return 0 if failed_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
