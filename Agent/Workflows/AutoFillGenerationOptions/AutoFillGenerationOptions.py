"""
AutoFillGenerationOptions — single-shot stdin/stdout worker for the
"Auto Fill Other Options" generation helper.

Spawned per-request by the Dock endpoint /Generate/AutoFillOptions. It reads one
JSON request body on stdin, asks Gemini for recommended generation option values,
and writes exactly one {"type":"result","options":{...}} line followed by
{"type":"done"} (or {"type":"error","message":...} then {"type":"done"} on
failure). The wire protocol mirrors StreamAskAiResponse.py so Dock can stay
AI-free — it spawns this worker and reads the result off stdout.

Like StreamAskAiResponse this is intentionally NOT a Workflow subclass: it
bypasses the task queue, isn't tracked by Redis, and lives only for the duration
of one HTTP request. The authoritative credit charge happens in Dock on a clean
completion.
"""

import asyncio
import json
import sys
from pathlib import Path

# Python only adds the script's own directory to sys.path; Dock spawns this worker
# with cwd at the Agent root but that isn't picked up automatically. The directory
# two levels up from Workflows/AutoFillGenerationOptions/ is Agent/, so insert it
# explicitly to resolve `from Globals.*` and `from Workflows.*`.
_AGENT_ROOT = Path(__file__).resolve().parents[2]
if str(_AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(_AGENT_ROOT))

from Globals.Utility.EnvironmentLoader import EnvironmentLoader


MODEL_NAME = "gemini-2.5-flash-lite"


def _emit(event: dict) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii = False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _log(message: str) -> None:
    sys.stderr.write(f"[AutoFillGenerationOptions worker] {message}\n")
    sys.stderr.flush()


def _read_request_body() -> dict:
    raw_text = sys.stdin.read()
    if not raw_text or not raw_text.strip():
        raise ValueError("Empty stdin payload — Dock did not write a request body.")
    return json.loads(raw_text)


def _build_prompts(request_body: dict) -> tuple[str, str]:
    # The mode drives WHICH option groups the model is asked to fill. Kept generic
    # and short, with no worked examples, so it behaves the same for every subject.
    mode = str(request_body.get("mode") or "ADVANCED").upper()
    subject_name = str(request_body.get("subjectName") or "").strip()
    exam_name = str(request_body.get("examName") or "").strip()
    description = str(request_body.get("description") or "").strip()
    user_additional_instructions = str(request_body.get("additionalInstructions") or "").strip()
    enabled_artifacts = request_body.get("enabledArtifacts") or {}

    b_flashcards = bool(enabled_artifacts.get("flashcards"))
    b_study_materials = bool(enabled_artifacts.get("studyMaterials"))
    b_mock_tests = bool(enabled_artifacts.get("mockTests"))

    system_prompt = (
        "You recommend settings for an automatic study-content generator. "
        "Flashcards are for learning and recall, not a copy of the exam: pick a question-type mix "
        "and difficulty that build understanding of the subject. "
        "Mock tests should reflect the named exam's usual pattern — its typical difficulty mix, "
        "question types, number of tests, questions per test, sections and marking. "
        "Study-material detail levels should suit how much depth the subject needs. "
        "Recommend only sensible values and keep any instructions short. "
        "When the user gave no general guidance you may add a brief general instruction; otherwise leave it unset."
    )

    if mode == "TEMPLATE":
        scope_line = (
            "Fill only these: flashcard difficulty weights, mock-test difficulty weights, "
            "mock-test number of tests, and study-material detail levels. Leave every other field unset."
        )
    else:
        scope_line = "Fill the option groups for the enabled artifacts."

    enabled_line = (
        f"Enabled artifacts — flashcards: {b_flashcards}, study materials: {b_study_materials}, "
        f"mock tests: {b_mock_tests}. Do not fill options for a disabled artifact."
    )

    user_prompt = (
        f"Subject: {subject_name or '(not given)'}\n"
        f"Exam: {exam_name or '(not given)'}\n"
        f"Description: {description or '(not given)'}\n"
        f"User additional instructions: {user_additional_instructions or '(none)'}\n"
        f"{enabled_line}\n"
        f"{scope_line}"
    )

    return system_prompt, user_prompt


async def run() -> int:
    EnvironmentLoader.load()

    try:
        request_body = _read_request_body()
    except Exception as parse_error:
        _emit({ "type": "error", "message": f"Bad request body: {parse_error}" })
        _emit({ "type": "done" })
        return 0

    from Globals.Classes.Automation.AutomationCaller import AutomationCaller
    from Globals.Classes.Automation.AutomationContent import AutomationContent
    from Globals.Classes.Automation.AutomationRequest import AutomationRequest
    from Globals.Classes.Automation.Providers.GeminiProvider import GeminiProvider
    from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
    from Workflows.AutoFillGenerationOptions.AutoFillGenerationOptionsResponse import AutoFillGenerationOptionsResponse

    system_prompt, user_prompt = _build_prompts(request_body)
    _log(f"Recommending generation options for subject '{request_body.get('subjectName')}' (mode={request_body.get('mode')}).")

    request = AutomationRequest(
        MODEL_NAME,
        [
            AutomationContent(AutomationContentTypes.SYSTEM, system_prompt),
            AutomationContent(
                AutomationContentTypes.TEXT,
                user_prompt,
                metadata = { "response_schema": AutoFillGenerationOptionsResponse },
            ),
        ],
    )

    caller = AutomationCaller(GeminiProvider())

    try:
        response = await caller.call(request, None, retries = 2)
    except Exception as call_error:
        _emit({ "type": "error", "message": f"Model call failed: {call_error}" })
        _emit({ "type": "done" })
        return 0

    if response is None:
        _emit({ "type": "error", "message": "No response from model." })
        _emit({ "type": "done" })
        return 0

    try:
        raw_output = response.get_output().get_data()
        parsed_response = AutoFillGenerationOptionsResponse.model_validate_json(raw_output)
    except Exception as parse_error:
        _emit({ "type": "error", "message": f"Schema validation failed: {parse_error}" })
        _emit({ "type": "done" })
        return 0

    _emit({ "type": "result", "options": parsed_response.model_dump(exclude_none = True) })
    _emit({ "type": "done" })
    return 0


if __name__ == "__main__":
    # Ensure stdout/stderr are utf-8 even when launched from a Windows console whose
    # default code page is cp1252 — model output regularly contains characters
    # outside that range.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding = "utf-8")
            except Exception:
                pass

    sys.exit(asyncio.run(run()))
