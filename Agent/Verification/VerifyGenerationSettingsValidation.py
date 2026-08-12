"""
Verification harness for PrepareForGeneration's payload validation.

Run from the Agent directory:
    .venv/Scripts/python.exe Verification/VerifyGenerationSettingsValidation.py   (Windows)
    .venv/bin/python Verification/VerifyGenerationSettingsValidation.py           (Linux)

Pure: no network, no model calls, no database. The workflow's validation reads
nothing but the payload it was constructed with, so every case here is a direct
decision check.

What it protects. PrepareForGeneration is the root of the generation pipeline —
every other task in the run is a descendant of it, and credits are charged per
task as the tree executes. A payload that is structurally wrong is therefore
discovered, without this validation, only once a child task dereferences it,
which is after the money is spent and after the staging namespace is populated.

The four shapes pinned below are the ones that reach a child rather than fail
loudly at the root:

  1. NO GENERATION MODE. GeneralGenerationSettings.from_json leaves the mode
     None when the key is absent, and the pipeline's branches select on it. None
     matches no branch, so the run proceeds and takes none of them.

  2. A SOURCE WITH NO InformationSource, or one carrying no sourceType. The
     pipeline dereferences these unguarded — the recurring shape is
     `extractable_source.get_information_source().get_source_type()` — so the
     failure is an AttributeError inside whichever child touches it first.

  3. NOTHING TO GENERATE FROM. Dock substitutes virtual web sources when a run
     has no sources but does have a description; a payload with neither never
     went through that path, and produces an empty deck at full price.

And the regression that the guards above must NOT cause:

  4. FALSY-ZERO ENUM MEMBERS ARE VALID. AutomaticGenerationModes.SIMPLE is 0 and
     InformationSourceTypes.PROVIDED_DOCUMENTS is 0. A truthiness test anywhere
     in the validation would reject the single most common kind of run — simple
     mode over an uploaded document — while passing every case above. Both are
     asserted accepted.

The user-facing rules (source caps, page ranges, URL safety, section
arithmetic) are Dock's, in Endpoints/Helpers/ValidateGenerationSettings.js, and
are deliberately not duplicated here.
"""

import asyncio
import sys
from pathlib import Path

AGENT_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENT_DIRECTORY))

from Globals.Enumerations.AutomaticGenerationModes import AutomaticGenerationModes
from Globals.Enumerations.InformationSourceTypes import InformationSourceTypes
from Workflows.PrepareForGeneration.PrepareForGeneration import PrepareForGeneration


passed_count = 0
failed_count = 0


def report(case_name: str, b_passed: bool, detail: str = "") -> None:
    global passed_count, failed_count

    if b_passed:
        passed_count += 1
        print(f"  PASS  {case_name}")
    else:
        failed_count += 1
        print(f"  FAIL  {case_name}{(' — ' + detail) if detail else ''}")


def build_extractable_source(source_type = InformationSourceTypes.PROVIDED_DOCUMENTS, b_include_source: bool = True) -> dict:
    """One entry of the informationSources / imageSources list, in wire shape."""
    if not b_include_source:
        return {"informationSource": None, "pageRanges": []}

    information_source = {"name": "Textbook.pdf", "userId": "verification-user"}

    if source_type is not None:
        information_source["sourceType"] = int(source_type)

    return {"informationSource": information_source, "pageRanges": []}


def build_payload(generation_mode = AutomaticGenerationModes.ADVANCED, information_sources = None, image_sources = None, description: str = "") -> dict:
    """A main-task payload in the shape Dock's Generate.js writes."""
    payload = {
        "description": description,
        "informationSources": information_sources if information_sources is not None else [build_extractable_source()],
        "imageSources": image_sources if image_sources is not None else [],
        "subjectName": "Physics",
        "examName": "",
        "paidDeckMode": False,
    }

    if generation_mode is not None:
        payload["generationMode"] = int(generation_mode)

    return payload


async def expect_accepted(case_name: str, payload: dict) -> None:
    try:
        await PrepareForGeneration(payload).run()
        report(case_name, True)
    except Exception as validation_error:
        report(case_name, False, f"rejected a valid payload: {validation_error}")


async def expect_rejected(case_name: str, payload: dict) -> None:
    try:
        await PrepareForGeneration(payload).run()
        report(case_name, False, "accepted a payload it should have refused")
    except ValueError:
        report(case_name, True)
    except Exception as unexpected_error:
        report(case_name, False, f"raised {type(unexpected_error).__name__} instead of ValueError: {unexpected_error}")


async def main() -> int:
    print("\nPrepareForGeneration — payload validation\n")

    print(" Accepted (must not regress):")
    await expect_accepted(
        "advanced mode over an uploaded document",
        build_payload(),
    )
    await expect_accepted(
        "SIMPLE mode (enum value 0) is a real mode, not a missing one",
        build_payload(generation_mode = AutomaticGenerationModes.SIMPLE),
    )
    await expect_accepted(
        "PROVIDED_DOCUMENTS (enum value 0) is a real source type",
        build_payload(information_sources = [build_extractable_source(InformationSourceTypes.PROVIDED_DOCUMENTS)]),
    )
    await expect_accepted(
        "description-driven run with no sources",
        build_payload(information_sources = [], description = "Newton's laws of motion"),
    )
    await expect_accepted(
        "absent imageSources is not a malformed list",
        build_payload(image_sources = None),
    )
    await expect_accepted(
        "populated imageSources alongside informationSources",
        build_payload(image_sources = [build_extractable_source()]),
    )

    print("\n Refused (each would otherwise fail inside a child task):")
    await expect_rejected(
        "generationMode absent",
        build_payload(generation_mode = None),
    )
    await expect_rejected(
        "an information source carrying no InformationSource",
        build_payload(information_sources = [build_extractable_source(b_include_source = False)]),
    )
    await expect_rejected(
        "an information source carrying no sourceType",
        build_payload(information_sources = [build_extractable_source(source_type = None)]),
    )
    await expect_rejected(
        "a malformed image source is caught too, not only information sources",
        build_payload(image_sources = [build_extractable_source(b_include_source = False)]),
    )
    await expect_rejected(
        "neither an information source nor a description",
        build_payload(information_sources = [], description = "   "),
    )

    print(f"\n{passed_count} passed, {failed_count} failed\n")

    return 1 if failed_count > 0 else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
