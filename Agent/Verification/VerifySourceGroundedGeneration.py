"""
Verification harness for source-grounded chunk generation.

Run from the Agent directory:
    .venv/Scripts/python.exe Verification/VerifySourceGroundedGeneration.py    (Windows)
    .venv/bin/python Verification/VerifySourceGroundedGeneration.py            (Linux)

WHAT THIS EXISTS TO PROTECT. Paid-deck content now rests on one of two bases,
and which one is a recorded fact per topic:

  - Written from model knowledge, defensible because the pipeline demonstrably
    had no third-party document to work from. Produced by KnowledgeChunkGenerator
    on a PAID_DECK_* model entry, inside the ROUTE BOUNDARY.
  - Written from a licensed document, defensible because the licence was declared
    and the document retained. Produced by SourceGroundedChunkGenerator on
    SOURCE_GROUNDED_CHUNK_MODEL, deliberately outside that boundary.

Everything below asserts that those two stay apart — that the writer inside the
boundary can never be handed a document, that the writer outside it never touches
a PAID_DECK_* entry, and that the provenance record cannot claim a licensed basis
for a topic that did not get one. A comment saying "do not do X" is not a
control; a test that fails when someone does X is.

One tier, no opt-in. Everything here runs offline with no services.
"""

import ast
import asyncio
import re
import sys
from pathlib import Path

AGENT_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENT_DIRECTORY))

from Globals.Classes.Automation.Pools.ModelPool import ModelPool
from Globals.Classes.Automation.Pools.PromptPool import PromptPool
from Globals.Classes.Generation.AdminSourceCorpus import AdminSourceCorpus
from Workflows.MapTopicsWithContent.SourceGroundedChunkGenerator import SourceGroundedChunkGenerator


GENERATOR_PATH = AGENT_DIRECTORY / "Workflows" / "MapTopicsWithContent" / "SourceGroundedChunkGenerator.py"
FALLBACK_PATH = AGENT_DIRECTORY / "Workflows" / "MapTopicsWithContent" / "KnowledgeChunkGenerator.py"
ORCHESTRATOR_PATH = AGENT_DIRECTORY / "Workflows" / "MapTopicsWithContent" / "MapTopicsWithContent.py"

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
    section("The licensed-source writer stays outside the PAID_DECK_* boundary")

    generator_source = GENERATOR_PATH.read_text(encoding="utf-8")

    # Matched on the ATTRIBUTE ACCESS, so the class's own prose — which
    # necessarily names PAID_DECK_KNOWLEDGE_CHUNK_MODEL while explaining why it
    # is not the one used here — cannot satisfy or trip this.
    paid_deck_model_pattern = re.compile(r"ModelPool\.PAID_DECK_\w+")
    offenders = paid_deck_model_pattern.findall(generator_source)

    assert_that(
        len(offenders) == 0,
        "the source-grounded writer references no PAID_DECK_* model"
        + ("" if not offenders else f" -- found: {', '.join(sorted(set(offenders)))}"),
    )

    model_references = re.findall(r"ModelPool\.(\w+)", generator_source)

    assert_that(
        set(model_references) == {"SOURCE_GROUNDED_CHUNK_MODEL"},
        f"it uses exactly one model entry, the outside-boundary one (found: {sorted(set(model_references))})",
    )

    assert_that(
        model_references.count("SOURCE_GROUNDED_CHUNK_MODEL") == 1,
        "there is exactly ONE line to audit — the model is read in one place and passed around",
    )

    model_string, provider_class = ModelPool.SOURCE_GROUNDED_CHUNK_MODEL

    assert_that(
        provider_class.__name__ == "GoogleEnterpriseAiProvider",
        f"the entry routes to Google, not Anthropic (got {provider_class.__name__}) -- the 30-day "
        "abuse-monitoring window is a poor fit for a document someone licensed",
    )

    assert_that(
        isinstance(model_string, str) and len(model_string) > 0,
        "the entry names a model",
    )

    assert_that(
        "SOURCE_GROUNDED_CHUNK_MODEL" not in FALLBACK_PATH.read_text(encoding="utf-8"),
        "the model-knowledge writer does not reference the outside-boundary entry either",
    )


def verify_fallback_cannot_see_a_document() -> None:
    section("The model-knowledge writer can never be handed a document")

    fallback_source = FALLBACK_PATH.read_text(encoding="utf-8")

    for marker in ("AdminSourceCorpus", "paidDeckVerificationSources", "contentSources", "select_passages"):
        assert_that(
            marker not in fallback_source,
            f"KnowledgeChunkGenerator does not reference {marker}",
        )

    fallback_model_references = re.findall(r"ModelPool\.(\w+)", fallback_source)

    assert_that(
        set(fallback_model_references) == {"PAID_DECK_KNOWLEDGE_CHUNK_MODEL"},
        f"it stays on its own inside-boundary entry (found: {sorted(set(fallback_model_references))})",
    )

    # An AST check rather than a text search: the orchestrator constructs both
    # writers a few lines apart, and the failure this guards against is a corpus
    # being passed to the wrong one by a copy-paste that a grep would not catch.
    orchestrator_tree = ast.parse(ORCHESTRATOR_PATH.read_text(encoding="utf-8"))

    fallback_constructions = []
    grounded_constructions = []

    for node in ast.walk(orchestrator_tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
            continue
        if node.func.id == "KnowledgeChunkGenerator":
            fallback_constructions.append(node)
        elif node.func.id == "SourceGroundedChunkGenerator":
            grounded_constructions.append(node)

    assert_that(
        len(fallback_constructions) == 1,
        f"the fallback writer is constructed in exactly one place ({len(fallback_constructions)} found)",
    )

    fallback_keywords = {
        keyword.arg
        for construction in fallback_constructions
        for keyword in construction.keywords
    }

    assert_that(
        "corpus" not in fallback_keywords,
        f"the fallback writer is constructed with no corpus (keywords: {sorted(fallback_keywords)})",
    )

    grounded_keywords = {
        keyword.arg
        for construction in grounded_constructions
        for keyword in construction.keywords
    }

    assert_that(
        "corpus" in grounded_keywords,
        "the source-grounded writer IS constructed with a corpus, so the two are visibly different calls",
    )

    section("The content sources are read off an attribute that actually exists")

    # This caught a real bug. MapTopicsWithContent does not keep its own copy of
    # the payload — the Workflow base class stores it as self._payload — so
    # reading self.__payload would have raised AttributeError on the first
    # paid-deck run with a licensed source, i.e. only in the new code path and
    # only in production. Name-mangled private attributes make this class of
    # mistake invisible to a grep, so it is asserted instead.
    orchestrator_source = ORCHESTRATOR_PATH.read_text(encoding="utf-8")

    assert_that(
        "self.__payload" not in orchestrator_source,
        "MapTopicsWithContent does not read a self.__payload it never assigns",
    )

    assert_that(
        'self._payload or {}).get("contentSources")' in orchestrator_source,
        "it reads contentSources off the base class's _payload, defensively",
    )

    from Workflows.MapTopicsWithContent.MapTopicsWithContent import MapTopicsWithContent

    workflow = MapTopicsWithContent({"contentSources": [{"informationSourceId": "src-1"}]})

    assert_that(
        getattr(workflow, "_payload", None) is not None
        and (workflow._payload.get("contentSources") or []) != [],
        "a constructed workflow really can reach its content sources — the attribute resolves at runtime",
    )

    assert_that(
        (MapTopicsWithContent({})._payload or {}).get("contentSources") is None,
        "...and an ordinary run without content sources reads as having none rather than raising",
    )


def verify_prompts_resolve() -> None:
    section("Every prompt loads and every placeholder the writer fills exists in it")

    generator_source = GENERATOR_PATH.read_text(encoding="utf-8")

    for prompt_name in ("PAID_DECK_SOURCE_GROUNDED_CHUNK_SYSTEM", "PAID_DECK_SOURCE_GROUNDED_CHUNK_USER"):
        try:
            prompt_text = getattr(PromptPool, prompt_name)
        except AttributeError:
            assert_that(False, f"{prompt_name} loads")
            continue

        assert_that(bool(prompt_text.strip()), f"{prompt_name} loads and is not empty")

        # Every placeholder the prompt declares must be one the writer fills.
        # A placeholder nobody fills reaches the model as a literal "{topic_chain}",
        # which reads to it as an instruction it cannot follow.
        for placeholder in sorted(set(re.findall(r"\{(\w+)\}", prompt_text))):
            assert_that(
                f'.replace("{{{placeholder}}}"' in generator_source,
                f"{prompt_name}'s {{{placeholder}}} is filled by the writer",
            )

    # And the reverse: every placeholder the writer fills must exist in one of
    # the prompts, or the substitution is silently a no-op.
    filled_placeholders = set(re.findall(r'\.replace\("\{(\w+)\}"', generator_source))
    combined_prompt_text = (
        PromptPool.PAID_DECK_SOURCE_GROUNDED_CHUNK_SYSTEM + PromptPool.PAID_DECK_SOURCE_GROUNDED_CHUNK_USER
    )

    for placeholder in sorted(filled_placeholders):
        assert_that(
            "{" + placeholder + "}" in combined_prompt_text,
            f"the writer's {{{placeholder}}} substitution targets a placeholder that exists",
        )

    assert_that(
        "SOURCE_EXPRESSION_RULES" in generator_source,
        "the shared accuracy rules are composed in, as every other writer in the pipeline does",
    )


def build_corpus() -> AdminSourceCorpus:
    corpus = AdminSourceCorpus()

    page_one = "The molar gas constant R equals 8.314462618 joules per mole per kelvin. " * 10
    page_two = "Carnot efficiency is one minus the ratio of cold to hot reservoir temperature. " * 10
    combined = page_one + page_two

    corpus._AdminSourceCorpus__index_source(
        combined, "Thermodynamics.pdf", "src-thermo", [(0, 0), (len(page_one), 1)])
    corpus._AdminSourceCorpus__build_inverse_document_frequency()

    return corpus


def verify_passage_provenance() -> None:
    section("Retrieved passages carry a locator good enough to check them against the document")

    corpus = build_corpus()
    passages = corpus.select_passages("molar gas constant 8.314462618", ["Thermodynamics", "Gas Laws"])

    assert_that(len(passages) > 0, "an item about the gas constant retrieves something")

    if not passages:
        return

    top_passage = passages[0]

    assert_that(top_passage.get("sourceId") == "src-thermo", "the passage names the source it came from")
    assert_that(top_passage.get("pageNumber") == 0, "the passage names the page it came from")
    assert_that(
        isinstance(top_passage.get("characterStart"), int)
        and isinstance(top_passage.get("characterEnd"), int)
        and top_passage["characterStart"] < top_passage["characterEnd"],
        "the passage carries a non-empty character range",
    )

    carnot_passages = corpus.select_passages("Carnot efficiency cold hot reservoir", ["Thermodynamics"])

    assert_that(
        bool(carnot_passages) and carnot_passages[0].get("pageNumber") == 1,
        "a passage from the second page is attributed to the second page, not the first",
    )

    assert_that(
        [passage["text"] for passage in passages]
        == [passage["text"] for passage in corpus.select_passages("molar gas constant 8.314462618", ["Thermodynamics", "Gas Laws"])],
        "selection is deterministic over identical inputs — an audit artefact that changes invites the "
        "question of what else did",
    )

    excerpt = AdminSourceCorpus.build_excerpt("x" * 1000)

    assert_that(
        len(excerpt) <= AdminSourceCorpus.MAXIMUM_EXCERPT_CHARACTERS + 1 and excerpt.endswith("…"),
        "an over-long excerpt is capped AND marked as truncated, so a shortened quote never reads as a whole one",
    )


def verify_provenance_paths() -> None:
    section("A topic's recorded basis matches what actually produced it")

    corpus = build_corpus()

    generator = SourceGroundedChunkGenerator(
        subject_name = "Physics",
        exam_name = "",
        coverage_summaries = {"topics": []},
        corpus = corpus,
        action_log = None,
    )

    covered_leaf = {"path": ["Unit I"], "topic": "molar gas constant 8.314462618"}
    uncovered_leaf = {"path": ["Unit II"], "topic": "medieval Provencal lyric poetry"}

    # No provider is reachable here, so a covered topic's LLM call fails. That is
    # the case worth asserting: a topic the fallback ends up writing must never
    # be recorded as source-grounded merely because this path was attempted.
    chunks_by_leaf_index, provenance_by_leaf_index, uncovered_leaf_indices = asyncio.run(
        generator.generate([covered_leaf, uncovered_leaf], None))

    assert_that(
        1 in uncovered_leaf_indices,
        "a topic no source discusses is handed to the fallback rather than written from unrelated passages",
    )

    uncovered_provenance = provenance_by_leaf_index.get(1)

    assert_that(
        uncovered_provenance is not None and uncovered_provenance.get("path") == "MODEL_KNOWLEDGE",
        "an uncovered topic is recorded as MODEL_KNOWLEDGE",
    )

    assert_that(
        uncovered_provenance is not None and uncovered_provenance.get("passages") == [],
        "an uncovered topic cites no passages — it was not written from any",
    )

    failed_provenance = provenance_by_leaf_index.get(0)

    assert_that(
        0 in uncovered_leaf_indices,
        "a covered topic whose generation call failed also falls back rather than being lost",
    )

    assert_that(
        failed_provenance is not None and failed_provenance.get("path") == "MODEL_KNOWLEDGE",
        "a FAILED source-grounded attempt is recorded as MODEL_KNOWLEDGE, not as source-grounded — "
        "the fallback is what will actually write it",
    )

    assert_that(
        failed_provenance is not None and failed_provenance.get("passages") == [],
        "a failed attempt cites no passages, so no topic can claim a licensed basis it did not use",
    )

    assert_that(
        chunks_by_leaf_index == {},
        "no chunks are returned for topics that produced none, so the caller can tell them apart",
    )

    assert_that(
        uncovered_leaf_indices == sorted(uncovered_leaf_indices),
        "uncovered indices come back sorted — the caller maps them onto the fallback's positional results",
    )


def verify_grounding_threshold() -> None:
    section("A topic is only claimed as source-grounded when the source really covers it")

    assert_that(
        SourceGroundedChunkGenerator.MINIMUM_PASSAGES_FOR_GROUNDING >= 2,
        "more than one passage is required before a topic is written from the source — one weak match is "
        "usually a stray vocabulary hit, and writing a whole topic from it would claim a basis it lacks",
    )

    assert_that(
        SourceGroundedChunkGenerator.TARGET_CHUNKS_PER_TOPIC
        == __import__(
            "Workflows.MapTopicsWithContent.KnowledgeChunkGenerator",
            fromlist=["KnowledgeChunkGenerator"],
        ).KnowledgeChunkGenerator.TARGET_CHUNKS_PER_TOPIC,
        "both writers target the same chunk count, so a topic's downstream treatment does not depend on "
        "which one happened to write it",
    )


def main() -> int:
    print(f"Verifying source-grounded chunk generation (Agent at {AGENT_DIRECTORY})")

    verify_route_boundary()
    verify_fallback_cannot_see_a_document()
    verify_prompts_resolve()
    verify_passage_provenance()
    verify_provenance_paths()
    verify_grounding_threshold()

    section("Summary")
    print(f"  passed: {passed_count}")
    print(f"  failed: {failed_count}")

    return 1 if failed_count else 0


if __name__ == "__main__":
    sys.exit(main())
