"""
RefineContent — stdin/stdout one-shot worker that revises one existing passage
of generated content against a reviewer's instruction.

Spawned per-request by Dock, from both the metered user-facing refinement
endpoint and the unmetered admin verification auto-fix.

Wire protocol (kept thin so Dock can stay AI-free):

  stdin  ── one JSON object:
            { targetKind, beforeHtml, instruction, subjectName, topicChain,
              referenceSourceUrl, referenceSourceText }

  stdout ── exactly one JSON line:
            { "revisedHtml": "...", "summary": "...", "concerns": "...",
              "consultedUrls": [...], "modelIdentifier": "..." }
            or { "error": "..." }. Exit 0 on success, non-zero otherwise.

  stderr ── human-readable progress (Dock tee's it to the server log).

Like GeneratePaidDeckField this is intentionally NOT a Workflow subclass: it
bypasses the task queue and lives only for one HTTP request.

It PROPOSES and never writes. Nothing here touches the database, the deck or
storage — the revised HTML goes back up the pipe, a person compares it against
what is there today, and a separate endpoint applies it only if they approve.
That separation is the whole design: an AI that both decides and writes turns a
review gate into an autopilot with a progress bar.
"""

import asyncio
import json
import sys
from pathlib import Path

# Python only adds the script's own directory to sys.path; Dock spawns this
# worker with cwd at the Agent root but that does not get picked up
# automatically. The directory two levels up is Agent/.
_AGENT_ROOT = Path(__file__).resolve().parents[2]
if str(_AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(_AGENT_ROOT))

from Globals.Utility.EnvironmentLoader import EnvironmentLoader


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _log(message: str) -> None:
    sys.stderr.write(f"[RefineContent worker] {message}\n")
    sys.stderr.flush()


def _read_request_body() -> dict:
    raw_text = sys.stdin.read()
    if not raw_text or not raw_text.strip():
        raise ValueError("Empty stdin payload — Dock did not write a request body.")
    return json.loads(raw_text)


class ContentRefiner:
    """
    Builds the refinement request for one passage and returns the model's
    proposed replacement, with the passage's figures preserved exactly.
    """

    # How each target reads to the model. A card answer and a lesson body want
    # visibly different revisions, and naming the kind is cheaper and more
    # reliable than hoping the model infers it from the markup.
    TARGET_DESCRIPTIONS = {
        "STUDY_MATERIAL": "a study-material lesson body (HTML)",
        "CARD_QUESTION": "the question side of a flashcard (HTML)",
        "CARD_ANSWER": "the answer side of a flashcard (HTML)",
    }

    ALLOWED_TARGET_KINDS = set(TARGET_DESCRIPTIONS.keys())

    # An attached document is truncated rather than refused. A reviewer pointing
    # at a 400-page reference almost always means one section of it, and a
    # refusal at the size limit reads as a broken feature; a stated truncation
    # reads as what it is.
    REFERENCE_TEXT_CHARACTER_BUDGET = 60000

    MAXIMUM_INSTRUCTION_LENGTH = 4000

    @staticmethod
    async def read_reference_source_text(storage_path: str, mime_type: str) -> str:
        """
        Reads an attached reference document out of storage and returns its text.

        Dock cannot do this itself — it has no PDF reader — so it passes the
        storage path it already validated the caller owns, and the extraction
        happens here beside the machinery that already does it for generation.

        A document that cannot be read returns empty rather than failing the
        refinement. The reviewer's instruction is the primary input and the
        source is supporting evidence; refusing to correct a wrong constant
        because a PDF would not parse would be the wrong trade. The caller sees
        an empty reference block and the model works from the instruction alone.
        """
        from Globals.Classes.Generic.Persistence import Persistence

        try:
            source_bytes = await Persistence.read(storage_path)
        except Exception as read_error:
            _log(f"Could not read the reference source at {storage_path}: {read_error}")
            return ""

        if not source_bytes:
            return ""

        if "pdf" in (mime_type or "").lower():
            try:
                from Workflows.MapTopicsWithContent.ExtractText import extract_text
                return extract_text(source_bytes)
            except Exception as extraction_error:
                _log(f"Could not extract text from the reference PDF: {extraction_error}")
                return ""

        try:
            return source_bytes.decode("utf-8", errors = "replace")
        except Exception as decode_error:
            _log(f"Could not decode the reference source as text: {decode_error}")
            return ""

    @staticmethod
    def __build_reference_block(reference_source_text: str, reference_source_url: str) -> str:
        sections = []

        cleaned_url = (reference_source_url or "").strip()
        if cleaned_url:
            sections.append(
                "REFERENCE SOURCE (a URL the reviewer supplied; its fetched contents appear "
                f"in the grounded context above): {cleaned_url}"
            )

        cleaned_text = (reference_source_text or "").strip()
        if cleaned_text:
            truncated_text = cleaned_text[:ContentRefiner.REFERENCE_TEXT_CHARACTER_BUDGET]
            truncation_note = (
                "\n[The reviewer's document continues beyond this point and was truncated.]"
                if len(cleaned_text) > len(truncated_text)
                else ""
            )
            sections.append(
                "REFERENCE SOURCE (a document the reviewer attached and declared a licence for). "
                "Take facts from it; write them in your own words.\n"
                f"--- START REFERENCE ---\n{truncated_text}{truncation_note}\n--- END REFERENCE ---"
            )

        if not sections:
            return ""

        return "\n" + "\n\n".join(sections) + "\n"

    @classmethod
    async def refine(
        cls,
        target_kind: str,
        before_html: str,
        instruction: str,
        subject_name: str,
        topic_chain: list,
        reference_source_url: str,
        reference_source_text: str,
    ) -> dict:
        from Globals.Classes.Automation.AutomationCaller import AutomationCaller
        from Globals.Classes.Automation.AutomationContent import AutomationContent
        from Globals.Classes.Automation.AutomationRequest import AutomationRequest
        from Globals.Classes.Automation.Pools.ModelPool import ModelPool
        from Globals.Classes.Automation.Pools.PromptPool import PromptPool
        from Globals.Classes.Generation.FigurePlaceholderCodec import FigurePlaceholderCodec
        from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
        from Globals.Utility.StripJsonMarkdown import strip_json_markdown

        stripped_html, original_figures = FigurePlaceholderCodec.extract(before_html)
        _log(f"Held back {len(original_figures)} figure(s) from the model; {len(stripped_html)} characters of prose sent.")

        model_string, provider_class = ModelPool.REFINE_CONTENT_MODEL

        user_prompt = (
            PromptPool.REFINE_CONTENT_USER
                .replace("{subject_name}", subject_name)
                .replace("{topic_chain}", " > ".join(topic_chain) if topic_chain else "(not recorded)")
                .replace("{target_description}", cls.TARGET_DESCRIPTIONS[target_kind])
                .replace("{instruction}", instruction)
                .replace("{reference_block}", cls.__build_reference_block(reference_source_text, reference_source_url))
                .replace("{before_html}", stripped_html)
        )

        # Search stays on for every refinement, not only the ones that named a
        # source. A correction is a factual claim about the world, and the
        # grounding metadata the provider returns is what lets the audit record
        # state which pages were actually consulted rather than which ones the
        # model said it consulted.
        request_metadata = {"enable_search": True}

        cleaned_url = (reference_source_url or "").strip()
        if cleaned_url:
            request_metadata["search_results"] = [cleaned_url]

        request = AutomationRequest(
            model_string,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, PromptPool.REFINE_CONTENT_SYSTEM),
                AutomationContent(AutomationContentTypes.TEXT, user_prompt, request_metadata),
            ],
        )

        caller = AutomationCaller(provider_class())
        response = await caller.call(request, None, retries = 2)

        if response is None:
            raise RuntimeError("The model returned no response.")

        outputs = response.get_outputs()
        if not outputs:
            raise RuntimeError("The model returned no usable content.")

        parsed = strip_json_markdown(outputs[0].get_data())

        if not isinstance(parsed, dict) or not isinstance(parsed.get("revisedHtml"), str):
            raise RuntimeError("The model returned an unusable response shape.")

        revised_html, dropped_figure_count = FigurePlaceholderCodec.restore(
            parsed["revisedHtml"],
            original_figures,
        )

        if not revised_html.strip():
            raise RuntimeError("The model returned an empty revision.")

        concerns = str(parsed.get("concerns") or "").strip()

        if dropped_figure_count > 0:
            # Surfaced, never silent. The figures are still in the passage, at
            # the end rather than where they were, and only a person looking at
            # the comparison can say whether that is acceptable.
            dropped_note = (
                f"{dropped_figure_count} figure(s) were removed from their original positions by the "
                f"revision and have been re-appended at the end of the passage. Check their placement."
            )
            concerns = f"{concerns} {dropped_note}".strip()
            _log(dropped_note)

        return {
            "revisedHtml": revised_html,
            "summary": str(parsed.get("summary") or "").strip(),
            "concerns": concerns,
            "consultedUrls": [
                grounding_source.get("uri")
                for grounding_source in response.get_grounding_sources()
                if grounding_source.get("uri")
            ],
            "modelIdentifier": model_string,
        }


async def run() -> int:
    EnvironmentLoader.load()

    try:
        request_body = _read_request_body()
    except Exception as parse_error:
        _emit({"error": f"Bad request body: {parse_error}"})
        return 1

    target_kind = str(request_body.get("targetKind") or "").strip().upper()
    if target_kind not in ContentRefiner.ALLOWED_TARGET_KINDS:
        _emit({"error": f"Unsupported target kind '{target_kind}'."})
        return 1

    before_html = request_body.get("beforeHtml")
    if not isinstance(before_html, str) or not before_html.strip():
        _emit({"error": "beforeHtml is required and must be a non-empty string."})
        return 1

    instruction = str(request_body.get("instruction") or "").strip()
    if not instruction:
        _emit({"error": "instruction is required."})
        return 1
    instruction = instruction[:ContentRefiner.MAXIMUM_INSTRUCTION_LENGTH]

    subject_name = str(request_body.get("subjectName") or "").strip() or "the subject"
    topic_chain = request_body.get("topicChain") or []
    if not isinstance(topic_chain, list):
        topic_chain = []

    reference_source_url = str(request_body.get("referenceSourceUrl") or "").strip()
    reference_source_text = str(request_body.get("referenceSourceText") or "")

    # An attached document arrives as the storage path Dock already checked the
    # caller owns, never as a path the client chose — Dock resolves it from the
    # stored information-source row.
    reference_source_storage_path = str(request_body.get("referenceSourceStoragePath") or "").strip()

    if reference_source_storage_path and not reference_source_text:
        reference_source_text = await ContentRefiner.read_reference_source_text(
            reference_source_storage_path,
            str(request_body.get("referenceSourceMimeType") or ""),
        )
        _log(f"Read {len(reference_source_text)} characters from the attached reference source.")

    _log(
        f"Refining {target_kind} ({len(before_html)} characters) "
        f"with{'' if reference_source_url or reference_source_text else 'out'} a reference source."
    )

    try:
        result = await ContentRefiner.refine(
            target_kind,
            before_html,
            instruction,
            subject_name,
            [str(entry) for entry in topic_chain],
            reference_source_url,
            reference_source_text,
        )
    except Exception as refinement_error:
        _emit({"error": f"Refinement failed: {refinement_error}"})
        return 1

    _emit(result)
    return 0


if __name__ == "__main__":
    # Ensure stdout/stderr are utf-8 even when launched from a Windows console
    # whose default code page is cp1252 — generated content regularly contains
    # characters outside that range.
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding = "utf-8")
        except Exception:
            pass
    if hasattr(sys.stderr, "reconfigure"):
        try:
            sys.stderr.reconfigure(encoding = "utf-8")
        except Exception:
            pass

    sys.exit(asyncio.run(run()))
