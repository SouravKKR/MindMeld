"""
StreamAskAiResponse — stdin/stdout streaming worker for the AskAi feature.

Spawned per-request by the Dock endpoint at /AskAi/Query/{Basic|Pro|ProPlus}.

Wire protocol (deliberately as thin as possible so Dock can stay AI-free):

  stdin  ── one line of JSON: the full request body from the browser plus
            the {modelId, bEnableGoogleSearch} pair Dock injected based on
            which endpoint was hit.

  stdout ── NDJSON, one event per line, flushed after each line so Dock
            can forward the chunk to the browser immediately.

  stderr ── human-readable progress (not forwarded to the browser; Dock
            tee's it to the server log only).

This script is intentionally NOT a Workflow subclass — it bypasses the
task queue, isn't tracked by Redis, and lives only for the duration of
one HTTP request. Workflow plumbing (TaskManager, status updates,
nextTaskIds) would add latency for no benefit here.

Heavy imports (the PDF reader, `sentence_transformers`) are deferred to the
branches that need them, keeping the no-grounding cold start cheap.
"""

import time as _time_module
# Captured the instant this module starts executing — the earliest point the
# spawned worker can measure. Compared against the Dock-supplied spawn time to
# isolate interpreter-launch overhead, and used as the zero-point for every
# per-phase [ASKAI_TIMING] marker below.
_PROCESS_START_MONOTONIC = _time_module.monotonic()
_PROCESS_START_EPOCH_MS = _time_module.time() * 1000

import asyncio
import base64
import json
import os
import sys
from pathlib import Path

# Python only adds the script's own directory to sys.path; Dock spawns
# this worker with cwd at the Agent root but that doesn't get picked up
# automatically. Insert the Agent root explicitly so `from Globals.*`
# and `from Workflows.*` resolve no matter where the interpreter was
# invoked from. The directory three levels up is Agent/.
_AGENT_ROOT = Path(__file__).resolve().parents[2]
if str(_AGENT_ROOT) not in sys.path:
    sys.path.insert(0, str(_AGENT_ROOT))

from Globals.Utility.EnvironmentLoader import EnvironmentLoader


def _emit(event: dict) -> None:
    """
    Write one NDJSON event line to stdout, flushed. The flush is the
    whole point of the worker — without it Python buffers up to ~4 KB
    of output before releasing, which kills the streaming illusion on
    short responses.
    """
    sys.stdout.write(json.dumps(event, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _log(message: str) -> None:
    sys.stderr.write(f"[AskAi worker] {message}\n")
    sys.stderr.flush()


# Correlation tag Dock injects into the request body so its own [ASKAI_TIMING]
# lines and this worker's lines can be tied to one HTTP request. Held in a dict
# so _timing can read the latest value without a `global` declaration.
_TIMING_STATE = {"tag": "?"}


def _timing(label: str) -> None:
    """
    Emit one [ASKAI_TIMING] marker to stderr (Dock tees stderr to the server
    log). Each line carries the milliseconds elapsed since this worker process
    started, so the whole request timeline can be reconstructed from the log
    alone — where the seconds actually go (spawn, imports, grounding, web image
    search, prompt build, or Gemini time-to-first-token).
    """
    elapsed_ms = int((_time_module.monotonic() - _PROCESS_START_MONOTONIC) * 1000)
    sys.stderr.write(f"[AskAi worker] [ASKAI_TIMING tag={_TIMING_STATE['tag']}] {label} @ +{elapsed_ms}ms\n")
    sys.stderr.flush()


def _read_request_body() -> dict:
    """
    Dock writes exactly one JSON line on stdin then closes. We read the
    whole stream rather than readline() — large image attachments can
    push the JSON well past the default line buffer.
    """
    raw_text = sys.stdin.read()
    if not raw_text or not raw_text.strip():
        raise ValueError("Empty stdin payload — Dock did not write a request body.")
    return json.loads(raw_text)


def _build_attached_image_parts(attached_images: list[dict]) -> list:
    """
    Decode each base64 image into a Gemini-friendly Part. Late-imports
    google.genai.types so the import cost is paid only here, not at
    module-load time.
    """
    from google.genai import types

    image_parts = []
    for attached_image in attached_images or []:
        mime_type = attached_image.get("mimeType") or "image/png"
        base64_data = attached_image.get("base64Data") or ""
        if not base64_data:
            continue
        try:
            decoded_bytes = base64.b64decode(base64_data, validate=False)
        except Exception as decode_error:
            _log(f"Skipping malformed image attachment: {decode_error}")
            continue
        image_parts.append(types.Part.from_bytes(data=decoded_bytes, mime_type=mime_type))
    return image_parts


async def _retrieve_grounding_chunks(selected_text: str, user_query: str | None, information_sources: list[dict], owner_user_id: str) -> list[dict]:
    """
    Run a single nomic-embed-text-v1 query, then a cosine top-k against
    the chunks Mongo already has for the supplied source hashes. Only
    invoked when useInformationSources is on AND the list is non-empty
    — keeps the no-grounding path off the sentence-transformers import.

    owner_user_id is threaded down to the query engine, which re-derives
    which of the requested hashes this user actually owns. The hashes reach
    us from a client payload and the chunk documents carry no tenant column,
    so the retrieval must not be scoped by hash alone.
    """
    from Workflows.PrepareForSimilaritySearch.EmbedPages import load_model
    from Globals.Classes.Database.EmbeddingsQueryEngine import EmbeddingsQueryEngine

    information_source_hashes = []
    for information_source_entry in information_sources or []:
        nested_information_source = information_source_entry.get("informationSource") or {}
        source_hash = nested_information_source.get("hash")
        if source_hash:
            information_source_hashes.append(source_hash)

    if not information_source_hashes:
        return []

    _log(f"Embedding query for grounding against {len(information_source_hashes)} source(s)…")

    query_text = (selected_text or "").strip()
    if user_query:
        query_text = (query_text + " " + user_query).strip()

    # nomic's task-prefix convention: search_query: for embedding-time
    # queries, search_document: for the index-time chunks (already
    # applied during PrepareForSimilaritySearch).
    embedding_model = load_model()
    prefixed_query = "search_query: " + query_text
    query_embedding_array = embedding_model.encode([prefixed_query], convert_to_numpy=True, show_progress_bar=False)[0]
    query_embedding = query_embedding_array.tolist()

    retrieved_chunks = await EmbeddingsQueryEngine.vector_search(
        query_embedding = query_embedding,
        information_source_hashes = information_source_hashes,
        owner_user_id = owner_user_id,
        top_k = 5,
    )

    _log(f"Retrieved {len(retrieved_chunks)} chunk(s) for grounding.")
    return retrieved_chunks


async def _search_web_images(selected_text: str, user_query: str | None) -> list[dict]:
    """
    Run a DDGS image search for the AskAi query. Only invoked on the
    Pro / Pro Plus path (google-search grounding on). The query mirrors
    the grounding-embed query: the learner's typed question joined with
    any highlighted fragment. Returns [] on any failure so a flaky image
    search never aborts the reply.
    """
    query_text = (selected_text or "").strip()
    if user_query:
        query_text = (query_text + " " + user_query).strip()
    if not query_text:
        return []

    from Globals.Classes.WebScraping.WebScraper import WebScraper

    _log(f"Searching web images for: {query_text[:120]}")
    return await WebScraper().search_images(query_text)


async def run() -> int:
    _timing("run() entered (interpreter + module imports done)")
    EnvironmentLoader.load()

    try:
        request_body = _read_request_body()
    except Exception as parse_error:
        _emit({ "type": "error", "message": f"Bad request body: {parse_error}" })
        _emit({ "type": "done" })
        return 0

    _TIMING_STATE["tag"] = str(request_body.get("requestTag") or "?")
    _dock_spawn_issued_ms = request_body.get("dockSpawnIssuedAtMs")
    if _dock_spawn_issued_ms:
        _timing(f"env loaded + body read (interpreter launch was {int(_PROCESS_START_EPOCH_MS - _dock_spawn_issued_ms)}ms after Dock issued spawn)")
    else:
        _timing("env loaded + body read")

    prompt_mode_string  = request_body.get("promptMode") or "EXPLAIN"
    context_kind_string = request_body.get("contextKind") or "CARD"
    context_payload     = request_body.get("contextPayload") or {}
    selected_text       = request_body.get("selectedText") or ""
    user_query          = request_body.get("userQuery")
    attached_images     = request_body.get("attachedImages") or []
    information_sources = request_body.get("informationSources") or []
    b_use_information_sources = bool(request_body.get("useInformationSources"))
    selected_language         = request_body.get("selectedLanguage") or "ENGLISH"
    b_combine_with_english    = bool(request_body.get("combineWithEnglish"))
    model_id                  = request_body.get("modelId")
    b_enable_google_search    = bool(request_body.get("bEnableGoogleSearch"))
    # Dock injects the resolved userId alongside modelId so every worker
    # log line can be attributed to the user being charged for the call.
    user_id = request_body.get("userId") or "unknown"

    if not model_id:
        _emit({ "type": "error", "message": "Missing modelId — Dock should inject this from ModelTierMetadata." })
        _emit({ "type": "done" })
        return 0

    from Globals.Enumerations.AskAiPromptModes import AskAiPromptModes
    from Globals.Enumerations.AskAiContextKinds import AskAiContextKinds

    prompt_mode  = AskAiPromptModes[prompt_mode_string]  if prompt_mode_string  in AskAiPromptModes.__members__ else AskAiPromptModes.EXPLAIN
    context_kind = AskAiContextKinds[context_kind_string] if context_kind_string in AskAiContextKinds.__members__ else AskAiContextKinds.CARD

    # Deck Chat must answer ONLY from the deck excerpts the client retrieved, so
    # web-search grounding is forced off for it regardless of tier — otherwise
    # Pro / Pro Plus would keep the google_search tool live and contradict the
    # deck-only grounding the prompt promises.
    if int(context_kind) == int(AskAiContextKinds.DECK):
        b_enable_google_search = False

    retrieved_chunks: list[dict] = []
    if b_use_information_sources and information_sources:
        _timing("grounding (embedding-model load + vector search) START")
        try:
            retrieved_chunks = await _retrieve_grounding_chunks(selected_text, user_query, information_sources, user_id)
        except Exception as grounding_error:
            # Grounding failure should not abort the whole reply — log
            # it and continue without the grounded excerpts.
            _log(f"Grounding retrieval failed, continuing ungrounded: {grounding_error}")
            retrieved_chunks = []
        _timing(f"grounding DONE ({len(retrieved_chunks)} chunk(s))")

    # Pro / Pro Plus only: fetch real, load-tested web images up front so
    # the model can embed them inline AND the result view can render them
    # as a thumbnail strip. Emitted immediately so the strip appears even
    # if the model embeds none. A failed search degrades to no images.
    image_candidates: list[dict] = []
    if b_enable_google_search and int(context_kind) != int(AskAiContextKinds.DECK):
        _timing("web image search START")
        try:
            image_candidates = await _search_web_images(selected_text, user_query)
        except Exception as image_error:
            _log(f"Image search failed, continuing without images: {image_error}")
            image_candidates = []
        _timing(f"web image search DONE ({len(image_candidates)} image(s))")
        if image_candidates:
            _emit({ "type": "images", "items": image_candidates })

    from Workflows.AskAi.AskAiPromptBuilder import AskAiPromptBuilder

    system_prompt, user_prompt = AskAiPromptBuilder.build(
        prompt_mode      = int(prompt_mode),
        context_kind     = int(context_kind),
        context_payload  = context_payload,
        selected_text    = selected_text,
        user_query       = user_query,
        retrieved_chunks = retrieved_chunks,
        b_enable_google_search = b_enable_google_search,
        selected_language      = selected_language,
        b_combine_with_english = b_combine_with_english,
        candidate_image_urls   = [candidate["imageUrl"] for candidate in image_candidates],
    )

    attached_image_parts = _build_attached_image_parts(attached_images)

    from Globals.Classes.Automation.Providers.GoogleEnterpriseAiProvider import GoogleEnterpriseAiProvider
    gemini_provider = GoogleEnterpriseAiProvider()

    _timing(f"prompt built + provider ready (system={len(system_prompt)} chars, user={len(user_prompt)} chars, images={len(attached_image_parts)})")
    _log(f"Streaming from {model_id} for user {user_id} (grounding={b_enable_google_search}, images={len(attached_image_parts)}).")

    gemini_call_start_monotonic = _time_module.monotonic()
    _timing("calling Gemini stream")
    b_first_token_seen = False

    try:
        async for event in gemini_provider.stream_text(
            model = model_id,
            system_prompt = system_prompt,
            user_prompt = user_prompt,
            attached_image_parts = attached_image_parts,
            b_enable_google_search = b_enable_google_search,
            # Attribution for the content guardrail's log entries. This is the
            # one streaming path where the user is known at the call site, so a
            # removal here lands in logEvents against a real account instead of
            # only a task id. The "unknown" placeholder above is for log prose;
            # accountId wants the empty string when there is no account.
            account_id = "" if user_id == "unknown" else user_id,
        ):
            if not b_first_token_seen and event.get("type") == "text":
                b_first_token_seen = True
                gemini_ttft_ms = int((_time_module.monotonic() - gemini_call_start_monotonic) * 1000)
                _timing(f"FIRST Gemini token received (Gemini TTFT = {gemini_ttft_ms}ms)")
            _emit(event)
    except Exception as stream_error:
        _emit({ "type": "error", "message": f"Unexpected stream failure: {stream_error}" })

    _timing("Gemini stream complete")
    _emit({ "type": "done" })
    return 0


if __name__ == "__main__":
    # Ensure stdout is utf-8 even when launched from a Windows console
    # whose default code page is cp1252 — Gemini output regularly
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
