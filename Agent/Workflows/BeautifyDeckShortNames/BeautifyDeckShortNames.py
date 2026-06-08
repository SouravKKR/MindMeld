import asyncio
import json
import os

from Workflows.Workflow import Workflow
from Workflows.BeautifyDeckShortNames.BeautifiedDeckShortNamesResponse import BeautifiedDeckShortNamesResponse
from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.Providers.GeminiProvider import GeminiProvider
from Globals.Classes.Generic.Persistence import Persistence
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Constants.PersistenceConstants import PersistenceConstants
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Utility.JoinPath import join_path


class BeautifyDeckShortNames(Workflow):

    MODEL_NAME                   = "gemini-2.5-flash-lite"
    MAX_DECKS_PER_BATCH          = 50
    MAX_SHORT_NAME_LENGTH        = 16
    BEAUTIFIED_OUTPUT_FILE_NAME  = "BeautifiedShortNames.json"
    FLASHCARDS_DIRECTORY_NAME    = PersistenceConstants.FLASHCARDS_DIRECTORY
    STUDY_MATERIALS_DIRECTORY_NAME = PersistenceConstants.STUDY_MATERIALS_DIRECTORY

    SYSTEM_PROMPT = (
        "You are an expert at writing concise, readable short names for flashcard decks. "
        "Each short name must be at most 16 characters long, in Title Case, and must be "
        "instantly recognisable as a label for that deck. Prefer the full topic word when "
        "it fits (e.g. 'Limits', 'Algebra'). For multi-word topics, drop filler words and "
        "keep the most distinctive ones (e.g. 'The Nervous System' -> 'Nervous System'). "
        "Never invent unrelated names. Never exceed 16 characters."
    )

    def __init__(self, payload = {}):
        super().__init__(payload)

    async def run(self, args = {}):
        main_task_id = os.getenv("MAIN_TASK_ID")

        if not main_task_id:
            print("[BeautifyDeckShortNames] No MAIN_TASK_ID — exiting.")
            return

        # Two invocation modes:
        # 1. Post-generation (Generate.js) — payload is empty; we scan the
        #    task folder's Flashcards/ and StudyMaterials/ for topicChains.
        # 2. Admin-triggered (BeautifyDeckShortNames endpoint) — payload
        #    carries `deckChains` directly so we skip the file scan and
        #    avoid touching the staged generation artefacts.
        payload_deck_chains = self._payload.get("deckChains") if isinstance(self._payload, dict) else None

        if isinstance(payload_deck_chains, list) and payload_deck_chains:
            topic_chains = [
                [str(part) for part in chain]
                for chain in payload_deck_chains
                if isinstance(chain, list) and chain
            ]
        else:
            topic_chains = await self.__collect_topic_chains(main_task_id)

        if not topic_chains:
            print("[BeautifyDeckShortNames] No topic chains found — nothing to beautify.")
            return

        unique_deck_entries = self.__derive_unique_deck_entries(topic_chains)

        if not unique_deck_entries:
            print("[BeautifyDeckShortNames] No unique deck entries derived — nothing to beautify.")
            return

        print(f"[BeautifyDeckShortNames] Beautifying {len(unique_deck_entries)} unique deck short name(s).")

        provider = GeminiProvider()
        caller   = AutomationCaller(provider)

        beautified_map = {}

        for batch_start in range(0, len(unique_deck_entries), BeautifyDeckShortNames.MAX_DECKS_PER_BATCH):
            batch_entries = unique_deck_entries[batch_start : batch_start + BeautifyDeckShortNames.MAX_DECKS_PER_BATCH]
            beautified_for_batch = await self.__beautify_batch(batch_entries, caller)

            for entry, beautified_short_name in zip(batch_entries, beautified_for_batch):
                if beautified_short_name is None:
                    continue
                beautified_map[entry["key"]] = beautified_short_name

        await self.__write_output(main_task_id, beautified_map)

        task = await TaskManager.get_current_task()
        if task is not None:
            task.set_completion(1.0)
            await TaskManager.set_task(task)

        print(f"[BeautifyDeckShortNames] Wrote {len(beautified_map)} beautified short name(s).")

    async def __collect_topic_chains(self, main_task_id: str) -> list[list[str]]:
        collected_chains = []

        for content_directory in (
            BeautifyDeckShortNames.FLASHCARDS_DIRECTORY_NAME,
            BeautifyDeckShortNames.STUDY_MATERIALS_DIRECTORY_NAME,
        ):
            prefix = join_path(
                "/",
                PersistenceConstants.TASKS_DIRECTORY,
                main_task_id,
                content_directory,
            ) + "/"

            try:
                file_paths = await Persistence.list(prefix)
            except Exception as listing_error:
                print(f"[BeautifyDeckShortNames] Failed to list {prefix}: {listing_error}")
                continue

            for file_path in file_paths:
                try:
                    file_bytes = await Persistence.read(file_path)
                    file_content = json.loads(file_bytes.decode("utf-8"))
                except Exception as read_error:
                    print(f"[BeautifyDeckShortNames] Failed to read {file_path}: {read_error}")
                    continue

                topic_chain = file_content.get("topicChain")
                if isinstance(topic_chain, list) and topic_chain:
                    collected_chains.append([str(part) for part in topic_chain])

        return collected_chains

    @staticmethod
    def __derive_unique_deck_entries(topic_chains: list[list[str]]) -> list[dict]:
        seen_keys = set()
        unique_entries = []

        for topic_chain in topic_chains:
            for prefix_length in range(1, len(topic_chain) + 1):
                deck_key = " > ".join(topic_chain[:prefix_length])
                if deck_key in seen_keys:
                    continue
                seen_keys.add(deck_key)
                unique_entries.append({
                    "key":        deck_key,
                    "name":       topic_chain[prefix_length - 1],
                    "hierarchy":  topic_chain[:prefix_length],
                })

        return unique_entries

    async def __beautify_batch(self, batch_entries: list[dict], caller: AutomationCaller) -> list[str | None]:
        prompt_lines = []
        for index, entry in enumerate(batch_entries):
            hierarchy_breadcrumb = " > ".join(entry["hierarchy"])
            prompt_lines.append(f"{index + 1}. {hierarchy_breadcrumb}")

        user_prompt = (
            "For each numbered deck path below, produce a concise short name (max 16 characters) "
            "for the LEAF segment (the last segment after the final '>'). Consult the parent "
            "segments for context (so 'Math > Algebra > Limits' should shorten to 'Limits' rather "
            "than 'Math Limits'). Return the result as JSON matching the requested schema — one "
            "item per input, with `index` matching the input number and `short_name` containing "
            "the beautified name.\n\n"
            + "\n".join(prompt_lines)
        )

        request = AutomationRequest(
            BeautifyDeckShortNames.MODEL_NAME,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, BeautifyDeckShortNames.SYSTEM_PROMPT),
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    user_prompt,
                    metadata = { "response_schema": BeautifiedDeckShortNamesResponse },
                ),
            ]
        )

        response = await caller.call(request, None, retries = 2)

        if response is None:
            print("[BeautifyDeckShortNames] LLM returned no response for batch.")
            return [None] * len(batch_entries)

        try:
            raw_output = response.get_output().get_data()
        except Exception as response_error:
            print(f"[BeautifyDeckShortNames] Failed to read LLM response: {response_error}")
            return [None] * len(batch_entries)

        if not isinstance(raw_output, str) or not raw_output.strip():
            print("[BeautifyDeckShortNames] LLM response was empty or non-string.")
            return [None] * len(batch_entries)

        try:
            parsed_response = BeautifiedDeckShortNamesResponse.model_validate_json(raw_output)
        except Exception as parse_error:
            snippet = raw_output.strip()
            if len(snippet) > 600:
                snippet = snippet[:600] + "..."
            print(f"[BeautifyDeckShortNames] Schema validation failed: {parse_error}. Raw output: {snippet}")
            return [None] * len(batch_entries)

        results: list[str | None] = [None] * len(batch_entries)
        for item in parsed_response.items:
            entry_index = item.index - 1
            if entry_index < 0 or entry_index >= len(batch_entries):
                continue
            candidate = (item.short_name or "").strip()
            if not candidate:
                continue
            results[entry_index] = candidate[: BeautifyDeckShortNames.MAX_SHORT_NAME_LENGTH]

        return results

    async def __write_output(self, main_task_id: str, beautified_map: dict) -> None:
        output_path = join_path(
            "/",
            PersistenceConstants.TASKS_DIRECTORY,
            main_task_id,
            BeautifyDeckShortNames.BEAUTIFIED_OUTPUT_FILE_NAME,
        )

        await Persistence.write(
            output_path,
            json.dumps(beautified_map, ensure_ascii = False),
        )
