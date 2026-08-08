"""
Verification harness for the paid-deck audit-trail PDF renderer.

Run from the Agent directory:
    .venv/Scripts/python.exe Verification/VerifyAuditTrailRenderer.py    (Windows)
    .venv/bin/python Verification/VerifyAuditTrailRenderer.py            (Linux)

WHAT THIS EXISTS TO CATCH. The renderer builds every data table through one
helper. That helper used a plain Table with repeatRows=1 and no split controls,
which means ReportLab may split only BETWEEN rows and refuses even that unless
the repeated header and the first data row both fit the page frame. Every value
in these tables is model-authored prose with no length limit, so a single long
cell made the whole table unplaceable and the build died with

    LayoutError: Flowable with cell(0,0) containing 'Topic'(481.88 x 8060.0), too tall

taking the entire report with it. That is not a hypothetical: it is what
/Admin/PaidDecks/AuditTrail returned on production, so the evidence artefact for
every paid deck could not be produced at all.

Two tiers, so the default run needs no services:

  1. ALWAYS -- the clamping helpers in isolation; a real end-to-end render of a
     deliberately pathological provenance document (cells far taller than a
     page, in every table that takes free prose) driven through the renderer as
     a subprocess exactly as Dock spawns it; and a source-level guard that every
     sibling renderer's make_table carries the same split controls, since the
     helper was copy-pasted into all of them and the bug is latent in each copy.

  2. NONE. There is no opt-in tier -- the whole point is that this runs anywhere.
"""

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

# This harness lives in Agent/Verification/, so the repository root -- which is
# where Common/Scripts lives -- is two levels up.
AGENT_DIRECTORY = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = AGENT_DIRECTORY.parent
RENDERER_PATH = REPOSITORY_ROOT / "Common" / "Scripts" / "RenderPaidDeckAuditTrail.py"

sys.path.insert(0, str(RENDERER_PATH.parent))

import RenderPaidDeckAuditTrail as renderer


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


def verify_clamping_helpers() -> None:
    section("safe_clamped announces what it removed; short_hash never cuts an entity")

    short_text = "A short verdict."
    assert_that(
        renderer.safe_clamped(short_text) == "A short verdict.",
        "text within the limit passes through unchanged",
    )

    assert_that(
        renderer.safe_clamped(None) == renderer.MISSING_TEXT,
        "an absent value still renders as the named gap, not as an empty cell",
    )
    assert_that(
        renderer.safe_clamped("   ") == renderer.MISSING_TEXT,
        "a whitespace-only value renders as the named gap",
    )
    assert_that(
        renderer.safe_clamped(None, fallback="&mdash;") == "&mdash;",
        "the caller's fallback is honoured",
    )

    over_long_text = "x" * (renderer.PROSE_CELL_CHARACTER_LIMIT + 250)
    clamped = renderer.safe_clamped(over_long_text)
    assert_that(
        "truncated" in clamped and "250 character(s) omitted" in clamped,
        "an over-long value states that it was cut and by how much",
    )
    assert_that(
        clamped.startswith("x" * renderer.PROSE_CELL_CHARACTER_LIMIT),
        "the kept portion is the leading portion, at exactly the limit",
    )

    # Clamping BEFORE escaping is what keeps the cut off an entity boundary.
    # Escaping first turns one "&" into five characters, so a limit landing
    # inside "&amp;" would print "&am" as literal text.
    entity_heavy_text = "&" * (renderer.PROSE_CELL_CHARACTER_LIMIT + 10)
    clamped_entities = renderer.safe_clamped(entity_heavy_text)
    assert_that(
        clamped_entities.count("&amp;") == renderer.PROSE_CELL_CHARACTER_LIMIT,
        "clamping happens before escaping, so no entity is cut in half",
    )

    assert_that(
        renderer.short_hash("&" * 40) == "&amp;" * 16,
        "short_hash slices the raw hash and escapes afterwards",
    )
    assert_that(
        renderer.short_hash(None) == renderer.MISSING_TEXT,
        "a missing hash renders as the named gap rather than an empty arrow",
    )


def build_pathological_provenance() -> dict:
    """
    A provenance document whose every free-prose cell is far taller than a page.

    The lengths are deliberately past PROSE_CELL_CHARACTER_LIMIT so both defences
    are exercised at once: the clamp shortens the value, and what survives the
    clamp is still tall enough in the narrowest column that the row has to split
    across pages rather than be placed whole.
    """
    long_prose = ("This diagram was reviewed against the specification it was generated from. " * 400).strip()

    return {
        "deckId": "deck-pathological",
        "deckName": "Renderer regression deck",
        "mainTaskId": "run-pathological",
        "generatedByUserId": "user-under-test",
        "recordedAt": 1_760_000_000_000,
        "producedDeckIds": ["deck-child-1", "deck-child-2"],
        "sources": [
            {"name": "Syllabus.pdf", "declaredSourceType": "CURRICULUM_OR_SYLLABUS", "contentHash": "a" * 128},
        ],
        "acceptedSourceTypeName": "CURRICULUM_OR_SYLLABUS",
        "actions": [
            {
                "actionType": "LLM_CALL",
                "phase": "COVERAGE_SUMMARY",
                "timestampUtcMilliseconds": 1_760_000_001_000,
                "modelIdentifier": "gemini-3.1-flash-lite",
                "promptIdentifier": "PAID_DECK_COVERAGE_SUMMARY",
                "outcome": long_prose,
                "succeeded": True,
                "inputTokens": 1200,
                "outputTokens": 800,
            },
            {
                "actionType": "WEB_FETCH",
                "phase": "COVERAGE_RECONCILIATION",
                "timestampUtcMilliseconds": 1_760_000_002_000,
                "url": "https://example.com/" + ("segment/" * 200),
                "reason": "COVERAGE_CHECK",
            },
            {
                "actionType": "VISUAL",
                "phase": "VISUAL_GENERATION",
                "timestampUtcMilliseconds": 1_760_000_003_000,
                "topicChain": ["Unit I", "Thermodynamics", "Carnot cycle"],
                "description": long_prose,
                "origin": "INFERRED",
                "kind": "PROCESS_DIAGRAM",
                "method": "LABELLED_DESCRIPTION",
                "visionReviewOutcome": long_prose,
                "succeeded": True,
            },
        ],
        "verification": {
            "verifiedEntityCount": 3,
            "blockingFlagCount": 1,
            "advisoryFlagCount": 0,
            "flags": [
                {
                    "category": "CONSTANT",
                    "severity": "blocking",
                    "source": "REFERENCE_SET",
                    "topicChain": ["Unit I", "Thermodynamics"],
                    "quotedText": "the speed of light is 3.1e8 m/s",
                    "problem": long_prose,
                    "correctStatement": "2.998e8 m/s",
                },
                {
                    "category": "DEFINITION",
                    "severity": "advisory",
                    "source": "ADMIN_SOURCE",
                    "topicChain": ["Unit I", "Thermodynamics"],
                    "quotedText": "entropy always increases",
                    "citedPassage": long_prose,
                    "sourceName": "Reference textbook chapter",
                    "problem": long_prose,
                    "correctStatement": "Entropy of an isolated system never decreases.",
                },
            ],
            "summary": "One blocking flag, one source-grounded advisory.",
        },
        "flagResolutions": [
            {
                "flagIndex": 0,
                "resolution": "FIXED",
                "note": long_prose,
                "actorUserId": "admin-under-test",
                "resolvedAt": 1_760_000_004_000,
            },
        ],
        "coverageReconciliation": {
            "attempted": True,
            "patternConfidence": "HIGH",
            "patternSummary": "Pattern read from the published syllabus.",
            "gaps": [{"topic": "Entropy", "reason": long_prose, "suggestedParent": "Unit I"}],
            "outOfScope": [{"topicChain": ["Unit II", "Legacy topic"], "reason": long_prose}],
        },
        "contentRefinements": [
            {
                "refinementId": "refinement-1",
                "createdAt": 1_760_000_005_000,
                "actorUserId": "admin-under-test",
                "entityTypeName": "STUDY_MATERIAL",
                "entityId": "material-1",
                "instruction": long_prose,
                "modelIdentifier": "gemini-3.1-flash-lite",
                "summary": long_prose,
                "concerns": long_prose,
                "beforeContentHash": "&" * 40,
                "afterContentHash": "b" * 64,
                "consultedUrls": ["https://example.com/reference"],
                "informationSourceId": "source-1",
                "sourceName": "Reference textbook chapter",
                "sourceHash": "c" * 128,
                "sourceUrl": "https://example.com/licence",
                "licenceType": 1,
                "licenceNote": "Released under CC0 by the publisher.",
            },
        ],
        "verificationSourceDeclarations": [
            {
                "declarationId": "declaration-1",
                "event": "ATTACHED",
                "deckId": "deck-pathological",
                "sourceName": "Reference textbook chapter",
                "sourceUrl": "https://example.com/licence",
                "sourceHash": "c" * 128,
                "licenceType": 1,
                "licenceNote": long_prose,
                "declaredByUserId": "admin-under-test",
                "declaredByEmail": "admin@example.com",
                "createdAt": 1_760_000_006_000,
            },
            {
                "declarationId": "declaration-2",
                "event": "DETACHED",
                "deckId": "deck-pathological",
                "sourceName": "Reference textbook chapter",
                "sourceUrl": "",
                "sourceHash": "c" * 128,
                "licenceType": 6,
                "licenceNote": "",
                "declaredByUserId": "admin-under-test",
                "declaredByEmail": "admin@example.com",
                "createdAt": 1_760_000_007_000,
            },
        ],
    }


def verify_pathological_document_renders() -> None:
    section("A provenance document with page-busting cells renders instead of raising LayoutError")

    if not RENDERER_PATH.exists():
        assert_that(False, f"the renderer exists at {RENDERER_PATH}")
        return

    # Two records, so the multi-run index page and the per-run page breaks are
    # exercised alongside the tall rows rather than being left untested.
    envelope = {
        "deckId": "deck-pathological",
        "deckName": "Renderer regression deck",
        "records": [build_pathological_provenance(), build_pathological_provenance()],
    }

    with tempfile.TemporaryDirectory() as working_directory:
        provenance_path = Path(working_directory) / "provenance.json"
        output_path = Path(working_directory) / "AuditTrail.pdf"

        provenance_path.write_text(json.dumps(envelope), encoding="utf-8")

        # Spawned exactly as Dock spawns it, so a failure that only appears in a
        # subprocess -- an import that resolves in this process but not a bare
        # one, for instance -- is caught here rather than in production.
        completed = subprocess.run(
            [sys.executable, str(RENDERER_PATH), str(provenance_path), str(output_path)],
            capture_output=True,
            text=True,
        )

        assert_that(
            completed.returncode == 0,
            f"the renderer exits 0 (got {completed.returncode}: {completed.stderr.strip()[:400]})",
        )
        assert_that(output_path.exists(), "a PDF file is written")

        if not output_path.exists():
            return

        pdf_bytes = output_path.read_bytes()
        assert_that(pdf_bytes.startswith(b"%PDF"), "the output is a PDF")

        page_count = len(re.findall(rb"/Type\s*/Page[^s]", pdf_bytes))
        assert_that(
            page_count > 1,
            f"the tall rows flow across several pages rather than failing to place (pages: {page_count})",
        )


def verify_every_renderer_can_split_a_tall_row() -> None:
    """
    make_table was copy-pasted into every sibling renderer, so the bug is latent
    in each copy. This is a source-level guard rather than a render of each one:
    the reports differ in content but not in this helper, and what matters is
    that no copy is left without the split controls.
    """
    section("Regression guard: every renderer's table builder can split a tall row")

    scripts_directory = REPOSITORY_ROOT / "Common" / "Scripts"
    offenders = []
    checked_count = 0

    for renderer_path in sorted(scripts_directory.glob("Render*.py")):
        source_text = renderer_path.read_text(encoding="utf-8", errors="replace")

        if "def make_table(" not in source_text:
            continue

        checked_count += 1

        # The construction inside make_table, not any other table in the file.
        builder_source = source_text.split("def make_table(", 1)[1]
        builder_source = builder_source.split("\ndef ", 1)[0]

        if "enable_in_row_split(table)" not in builder_source:
            offenders.append(renderer_path.name)

    assert_that(checked_count > 0, f"renderers with a make_table were found to check (found {checked_count})")
    assert_that(
        len(offenders) == 0,
        "every make_table routes its table through enable_in_row_split"
        + ("" if not offenders else f" -- offenders: {', '.join(offenders)}"),
    )

    # An unconditional splitInRow is the setting that produces the orphan
    # fragment — one cell's first line with every other cell in the row blank —
    # so it is called out by name rather than left to be rediscovered.
    # Matched on the CONSTRUCTOR call, not on any mention of the keyword — the
    # helper itself sets table.splitInRow, which is the whole point and must not
    # be reported as the thing it exists to prevent.
    unconditional_offenders = [
        renderer_path.name
        for renderer_path in sorted(scripts_directory.glob("Render*.py"))
        if re.search(r"Table\([^)]*splitInRow", renderer_path.read_text(encoding="utf-8", errors="replace"))
    ]

    assert_that(
        len(unconditional_offenders) == 0,
        "no renderer sets splitInRow unconditionally at construction"
        + ("" if not unconditional_offenders else f" -- offenders: {', '.join(unconditional_offenders)}"),
    )


def main() -> int:
    print(f"Verifying the audit-trail renderer (repository at {REPOSITORY_ROOT})")

    verify_clamping_helpers()
    verify_pathological_document_renders()
    verify_every_renderer_can_split_a_tall_row()

    print("\n=== Summary ===")
    print(f"  passed: {passed_count}")
    print(f"  failed: {failed_count}")

    return 0 if failed_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
