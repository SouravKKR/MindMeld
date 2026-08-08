"""
GeneratePaidDeckField — stdin/stdout one-shot worker for the admin
"AI generate field" buttons on the paid-deck upload / edit dialogs.

Spawned per-request by the Dock endpoint at /Admin/PaidDecks/GenerateField.

Wire protocol (kept as thin as possible so Dock can stay AI-free):

  stdin  ── one JSON object: the generation context assembled by the
            client — { field, studyMaterialTitles, deckChain,
            existingMetadata }.

  stdout ── exactly one JSON line: { "text": "..." } on success, or
            { "error": "..." } on failure. The process exits 0 when it
            produced text and non-zero when it could not.

  stderr ── human-readable progress (Dock tee's it to the server log).

Like StreamAskAiResponse this is intentionally NOT a Workflow subclass:
it bypasses the task queue and lives only for one HTTP request. Every
piece of generation context arrives on stdin (the paid deck does not yet
exist in the database at upload time), so the worker needs no database
reads of its own — though the shared automation stack may still open a
Mongo connection for its read-through response cache when one is
configured, degrading gracefully to no caching when it is not.
"""

import asyncio
import json
import sys
from pathlib import Path

# Python only adds the script's own directory to sys.path; Dock spawns
# this worker with cwd at the Agent root but that does not get picked up
# automatically. Insert the Agent root explicitly so `from Globals.*`
# resolves no matter where the interpreter was invoked from. The
# directory two levels up is Agent/.
_AGENT_ROOT = Path(__file__).resolve().parents[2]
if str(_AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(_AGENT_ROOT))

from Globals.Utility.EnvironmentLoader import EnvironmentLoader


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _log(message: str) -> None:
    sys.stderr.write(f"[GeneratePaidDeckField worker] {message}\n")
    sys.stderr.flush()


def _read_request_body() -> dict:
    raw_text = sys.stdin.read()
    if not raw_text or not raw_text.strip():
        raise ValueError("Empty stdin payload — Dock did not write a request body.")
    return json.loads(raw_text)


class PaidDeckFieldGenerator:
    """
    Builds a field-specific prompt from the deck's study-material titles
    (falling back to the deck hierarchy) and asks Gemini 3.1 flash-lite
    for a single value to drop into one admin form field.
    """

    MODEL_NAME = "gemini-3.1-flash-lite"

    # Mirrors the maxlength on the matching <input>/<textarea> in the
    # upload / edit dialogs. Tags has no hard input cap, so it gets a
    # sensible soft ceiling instead. A value of 0 means "no cap".
    FIELD_MAX_LENGTHS = {
        "title": 256,
        "category": 128,
        "description": 4096,
        "tags": 240,
    }

    ALLOWED_FIELDS = set(FIELD_MAX_LENGTHS.keys())

    # Keys a model may wrap the value under when it answers with an object
    # instead of a bare value. The requested field name comes first because a
    # model with no schema keys its invented envelope off the task wording.
    JSON_ENVELOPE_KEYS_BY_FIELD = {
        "title": ("title", "deckTitle", "value", "text"),
        "category": ("category", "subject", "value", "text"),
        "description": ("description", "summary", "value", "text"),
        "tags": ("tags", "keywords", "value", "text"),
    }

    SYSTEM_PROMPT = (
        "You write storefront metadata for a paid flashcard deck on a study platform. "
        "You are given the topics the deck covers (study-material titles, or the deck's "
        "place in the subject hierarchy) and whatever metadata the seller has already "
        "filled in. Produce one clean value for the single requested field and nothing "
        "else — no labels, no quotes, no markdown, no explanation. Write in neutral, "
        "factual English. Do not invent specific facts (exam dates, prices, guarantees) "
        "that are not supported by the topics provided."
    )

    FIELD_INSTRUCTIONS = {
        "description": (
            "Write a concise description (2-3 sentences) of what topics this deck covers "
            "and who it helps. Stay generic and faithful to the listed topics."
        ),
        "title": (
            "Write a short, clear deck title (a handful of words). No trailing punctuation."
        ),
        "category": (
            "Give a single broad subject category for this deck (e.g. 'Biology', "
            "'Mathematics', 'History'). Output only the category words."
        ),
        "tags": (
            "Give a comma-separated list of 4-8 short, lowercase search tags describing "
            "the deck's topics. Output only the comma-separated list."
        ),
    }

    @staticmethod
    def __format_context(study_material_titles: list, deck_chain: list, existing_metadata: dict) -> str:
        sections = []

        cleaned_titles = [str(title).strip() for title in study_material_titles if str(title).strip()]
        if cleaned_titles:
            rendered_titles = "\n".join(f"- {title}" for title in cleaned_titles)
            sections.append(f"Study materials in this deck:\n{rendered_titles}")
        else:
            cleaned_chain = [str(name).strip() for name in deck_chain if str(name).strip()]
            if cleaned_chain:
                sections.append(
                    "This deck has no study materials; infer the topic from its place in the "
                    f"subject hierarchy (broad → specific): {' → '.join(cleaned_chain)}"
                )

        descriptive_existing = []
        for key in ("title", "category", "tags", "description"):
            value = str((existing_metadata or {}).get(key) or "").strip()
            if value:
                descriptive_existing.append(f"- {key}: {value}")
        if descriptive_existing:
            rendered_existing = "\n".join(descriptive_existing)
            sections.append(
                "Metadata the seller already entered (stay consistent with it; do not contradict it):\n"
                f"{rendered_existing}"
            )

        if not sections:
            return ""

        return "\n\n".join(sections)

    @classmethod
    def build_prompts(cls, field: str, study_material_titles: list, deck_chain: list, existing_metadata: dict):
        context_block = cls.__format_context(study_material_titles, deck_chain, existing_metadata)
        instruction = cls.FIELD_INSTRUCTIONS[field]

        if context_block:
            user_prompt = (
                f"{context_block}\n\n"
                f"Task: {instruction}"
            )
        else:
            # No study materials, no hierarchy, no existing metadata — fall
            # back to whatever the seller may type later. With nothing to go
            # on we ask for a safe generic placeholder rather than failing.
            user_prompt = (
                "No topic details are available for this deck yet. "
                f"Task: {instruction}"
            )

        return cls.SYSTEM_PROMPT, user_prompt

    @classmethod
    def __unwrap_json_envelope(cls, field: str, raw_text: str) -> str:
        """
        Returns the value carried by a JSON envelope, or the text unchanged
        when it is not one.

        The provider defaults response_mime_type to "application/json" unless
        some content carries response_as_text, and with no schema to shape it
        the model invents its own wrapper — {"description": "..."} — which then
        landed verbatim in the admin's form field. The request now asks for
        plain text, so this is the second line of defence rather than the
        first: a model that wraps the value anyway still yields the value.

        Runs BEFORE the code-fence strip, because stripping the backticks off a
        fenced JSON payload leaves a fragment that no longer parses.
        """
        candidate = (raw_text or "").strip()

        if candidate.startswith("```"):
            candidate = candidate.strip("`").strip()
            # A fenced block usually opens with its language on the first line.
            if candidate.lower().startswith("json"):
                candidate = candidate[len("json"):].strip()

        if not candidate.startswith("{") and not candidate.startswith("["):
            return raw_text

        try:
            parsed = json.loads(candidate)
        except (ValueError, TypeError):
            return raw_text

        if isinstance(parsed, list):
            return cls.__join_string_list(parsed) or raw_text

        if not isinstance(parsed, dict):
            return raw_text

        for envelope_key in cls.JSON_ENVELOPE_KEYS_BY_FIELD.get(field, ()):
            envelope_value = parsed.get(envelope_key)
            if isinstance(envelope_value, str) and envelope_value.strip():
                return envelope_value
            if isinstance(envelope_value, list):
                joined_value = cls.__join_string_list(envelope_value)
                if joined_value:
                    return joined_value

        # An envelope under a key we did not anticipate is still recoverable
        # when the object carries exactly one value — that value is
        # unambiguously the one that was asked for. More than one and we cannot
        # tell which, so the raw text is returned and the caller sees the
        # envelope rather than a silently wrong guess.
        string_values = [value for value in parsed.values() if isinstance(value, str) and value.strip()]
        if len(parsed) == 1 and len(string_values) == 1:
            return string_values[0]

        return raw_text

    @staticmethod
    def __join_string_list(values: list) -> str:
        return ", ".join(str(entry).strip() for entry in values if str(entry).strip())

    @classmethod
    def __post_process(cls, field: str, raw_text: str) -> str:
        text = cls.__unwrap_json_envelope(field, (raw_text or "").strip()).strip()

        # Models occasionally wrap a single value in quotes or a stray code
        # fence despite the instruction — strip the common cases.
        if text.startswith("```"):
            text = text.strip("`").strip()
        if len(text) >= 2 and text[0] == text[-1] and text[0] in ("\"", "'"):
            text = text[1:-1].strip()

        # Title / category are single-line values; collapse any newlines.
        if field in ("title", "category", "tags"):
            text = " ".join(part.strip() for part in text.splitlines() if part.strip())

        max_length = cls.FIELD_MAX_LENGTHS.get(field, 0)
        if max_length and len(text) > max_length:
            text = text[:max_length].rstrip()

        return text

    @classmethod
    async def generate(cls, field: str, study_material_titles: list, deck_chain: list, existing_metadata: dict) -> str:
        from Globals.Classes.Automation.AutomationCaller import AutomationCaller
        from Globals.Classes.Automation.AutomationContent import AutomationContent
        from Globals.Classes.Automation.AutomationRequest import AutomationRequest
        from Globals.Classes.Automation.Providers.GoogleEnterpriseAiProvider import GoogleEnterpriseAiProvider
        from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes

        system_prompt, user_prompt = cls.build_prompts(field, study_material_titles, deck_chain, existing_metadata)

        request = AutomationRequest(
            cls.MODEL_NAME,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, system_prompt),
                # Without this the provider defaults response_mime_type to
                # "application/json" and, with no schema to shape it, the model
                # invents a wrapper object whose raw text reached the admin's
                # form field. The prompt asks for a bare value; this makes the
                # transport ask for one too.
                AutomationContent(AutomationContentTypes.TEXT, user_prompt, {"response_as_text": True}),
            ]
        )

        caller = AutomationCaller(GoogleEnterpriseAiProvider())
        response = await caller.call(request, None, retries=2)

        if response is None:
            raise RuntimeError("The model returned no response.")

        # A response can carry zero outputs when the model produced no text
        # (e.g. a safety block or an empty finish) — guard before indexing so
        # we surface a clear error instead of an IndexError.
        outputs = response.get_outputs()
        if not outputs:
            raise RuntimeError("The model returned no usable content.")

        raw_output = outputs[0].get_data()
        if not isinstance(raw_output, str):
            raw_output = str(raw_output)

        text = cls.__post_process(field, raw_output)
        if not text:
            raise RuntimeError("The model returned an empty value.")

        return text


async def run() -> int:
    EnvironmentLoader.load()

    try:
        request_body = _read_request_body()
    except Exception as parse_error:
        _emit({ "error": f"Bad request body: {parse_error}" })
        return 1

    field = str(request_body.get("field") or "").strip()
    if field not in PaidDeckFieldGenerator.ALLOWED_FIELDS:
        _emit({ "error": f"Unsupported field '{field}'." })
        return 1

    study_material_titles = request_body.get("studyMaterialTitles") or []
    deck_chain            = request_body.get("deckChain") or []
    existing_metadata     = request_body.get("existingMetadata") or {}

    if not isinstance(study_material_titles, list):
        study_material_titles = []
    if not isinstance(deck_chain, list):
        deck_chain = []
    if not isinstance(existing_metadata, dict):
        existing_metadata = {}

    _log(f"Generating '{field}' from {len(study_material_titles)} titles / {len(deck_chain)} chain entries.")

    try:
        text = await PaidDeckFieldGenerator.generate(field, study_material_titles, deck_chain, existing_metadata)
    except Exception as generation_error:
        _emit({ "error": f"Generation failed: {generation_error}" })
        return 1

    _emit({ "text": text })
    return 0


if __name__ == "__main__":
    # Ensure stdout/stderr are utf-8 even when launched from a Windows
    # console whose default code page is cp1252 — generated copy regularly
    # contains characters outside that range.
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
