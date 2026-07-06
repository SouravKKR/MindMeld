"""
DetermineChatStrategy — stdin/stdout one-shot helper for the deck Chat mode.

Spawned per chat turn by Dock at /AskAi/Chat/Strategy, BEFORE the answer call. It
makes ONE cheap structured LLM call that decides how much deck content to retrieve
(nearest cards / materials) and proposes a few non-deviating alternate phrasings of
the question to widen the client-side similarity search. It does NOT answer.

  stdin  ── one JSON line: { userQuery, conversation?, modelId }
  stdout ── one JSON line: { nearestCards, nearestMaterials, expandedQueries }

Like StreamAskAiResponse this bypasses the task queue and lives for one request.
Every failure degrades to a safe fallback so chat never breaks because of it.
"""

import asyncio
import json
import sys
from pathlib import Path

# Insert the Agent root so `from Globals.*` / `from Workflows.*` resolve regardless
# of the interpreter's cwd (Dock spawns with cwd at the Agent root, mirroring the
# AskAi worker). The directory two levels up from Workflows/AskAi/ is Agent/.
_AGENT_ROOT = Path(__file__).resolve().parents[2]
if str(_AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(_AGENT_ROOT))

from Globals.Utility.EnvironmentLoader import EnvironmentLoader


DEFAULT_NEAREST_CARDS     = 4
DEFAULT_NEAREST_MATERIALS = 3
MAX_NEAREST_CARDS         = 10
MAX_NEAREST_MATERIALS     = 8
MAX_EXPANDED_QUERIES      = 4

SYSTEM_PROMPT = (
    "You plan how to retrieve relevant content from a learner's flashcard deck to "
    "answer their question. You do NOT answer the question. You decide how many "
    "flashcards and study materials to pull, and you propose a few alternate phrasings "
    "of the same question to improve a similarity search. Return only the requested JSON."
)


def _fallback() -> dict:
    return {
        "nearestCards":     DEFAULT_NEAREST_CARDS,
        "nearestMaterials": DEFAULT_NEAREST_MATERIALS,
        "expandedQueries":  [],
    }


def _clamp(value, low, high, default):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


async def run() -> dict:
    EnvironmentLoader.load()

    raw_text = sys.stdin.read()
    if not raw_text or not raw_text.strip():
        return _fallback()

    try:
        request_body = json.loads(raw_text)
    except Exception:
        return _fallback()

    user_query = (request_body.get("userQuery") or "").strip()
    model_id   = request_body.get("modelId")
    if not user_query or not model_id:
        return _fallback()

    # Recent turns give a follow-up question ("and the second one?") something to
    # expand against. Context only — the strategy still plans for the CURRENT question.
    context_note = ""
    conversation = request_body.get("conversation")
    if isinstance(conversation, list) and conversation:
        recent_lines = []
        for turn in conversation[-4:]:
            if not isinstance(turn, dict):
                continue
            speaker = "Learner" if (turn.get("role") or "").lower() == "user" else "Assistant"
            text = (turn.get("text") or "").strip()
            if text:
                recent_lines.append(f"{speaker}: {text[:300]}")
        if recent_lines:
            context_note = "Recent conversation (context only):\n" + "\n".join(recent_lines) + "\n\n"

    from Globals.Classes.Automation.AutomationCaller import AutomationCaller
    from Globals.Classes.Automation.AutomationContent import AutomationContent
    from Globals.Classes.Automation.AutomationRequest import AutomationRequest
    from Globals.Classes.Automation.Providers.GoogleEnterpriseAiProvider import GoogleEnterpriseAiProvider
    from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
    from Workflows.AskAi.ChatStrategyResponse import ChatStrategyResponse

    user_prompt = (
        context_note
        + "Plan retrieval for this learner question against their flashcard deck.\n\n"
        + f"Question: {user_query}\n\n"
        + "Decide nearest_cards and nearest_materials (small for simple/definitional "
        + "questions, larger for broad 'list / compare / all' questions) and up to "
        + f"{MAX_EXPANDED_QUERIES} alternate phrasings that do not change the meaning. "
        + "Return JSON matching the schema."
    )

    request = AutomationRequest(
        model_id,
        [
            AutomationContent(AutomationContentTypes.SYSTEM, SYSTEM_PROMPT),
            AutomationContent(
                AutomationContentTypes.TEXT,
                user_prompt,
                metadata={"response_schema": ChatStrategyResponse},
            ),
        ],
    )

    response = await AutomationCaller(GoogleEnterpriseAiProvider()).call(request, None, retries=1)
    if response is None:
        return _fallback()

    try:
        parsed = ChatStrategyResponse.model_validate_json(response.get_output().get_data())
    except Exception:
        return _fallback()

    expanded_queries = []
    for phrase in (parsed.expanded_queries or [])[:MAX_EXPANDED_QUERIES]:
        text = (phrase or "").strip()
        if text:
            expanded_queries.append(text)

    return {
        "nearestCards":     _clamp(parsed.nearest_cards, 1, MAX_NEAREST_CARDS, DEFAULT_NEAREST_CARDS),
        "nearestMaterials": _clamp(parsed.nearest_materials, 0, MAX_NEAREST_MATERIALS, DEFAULT_NEAREST_MATERIALS),
        "expandedQueries":  expanded_queries,
    }


def main():
    try:
        result = asyncio.run(run())
    except Exception as strategy_error:
        sys.stderr.write(f"[ChatStrategy] {strategy_error}\n")
        result = _fallback()

    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
