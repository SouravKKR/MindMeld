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
    # Must match Deck.MAX_SHORT_NAME_LENGTH in Main/Globals/Model/Deck.js — that is
    # the real storage/display budget the beautified name has to fit into. Targeting
    # a larger value here just gets the name hard-trimmed to this length downstream.
    MAX_SHORT_NAME_LENGTH        = 16
    BEAUTIFIED_OUTPUT_FILE_NAME  = "BeautifiedShortNames.json"
    FLASHCARDS_DIRECTORY_NAME    = PersistenceConstants.FLASHCARDS_DIRECTORY
    STUDY_MATERIALS_DIRECTORY_NAME = PersistenceConstants.STUDY_MATERIALS_DIRECTORY

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
        character_limit = BeautifyDeckShortNames.MAX_SHORT_NAME_LENGTH

        prompt_lines = []
        for index, entry in enumerate(batch_entries):
            hierarchy_breadcrumb = " > ".join(entry["hierarchy"])
            prompt_lines.append(f"{index + 1}. {hierarchy_breadcrumb}")

        # Kept deliberately generic: no worked examples, no topic-specific hints, so it
        # behaves the same for every subject. The rules describe HOW to shorten, not
        # WHAT any particular name should become.
        system_prompt = (
            "You write concise, human-readable short names for flashcard decks. "
            f"Given a deck's topic, produce a label that clearly refers to the same topic and fits within {character_limit} characters. "
            "To make it fit you may leave out less-important or filler words and/or use widely-recognised "
            "abbreviations, as long as the result stays clear and unmistakably points to the original topic. "
            "Always keep whole, readable words or standard abbreviations — never cut a word partway through, "
            "and never return a meaningless fragment. Use Title Case, and never invent a name unrelated to the "
            f"original topic. If the topic already fits within {character_limit} characters, return it unchanged."
        )

        user_prompt = (
            f"For each numbered deck path below, write a short name for the LEAF segment (the text after the "
            f"final '>') that fits within {character_limit} characters. Use the parent segments only for context "
            "and disambiguation — do not include them in the output. Return the result as JSON matching the "
            "requested schema: one item per input, with `index` matching the input number and `short_name` "
            "containing the short name.\n\n"
            + "\n".join(prompt_lines)
        )

        request = AutomationRequest(
            BeautifyDeckShortNames.MODEL_NAME,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, system_prompt),
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
            results[entry_index] = BeautifyDeckShortNames.__fit_short_name(candidate)

        return results

    @staticmethod
    def __fit_short_name(candidate: str) -> str:
        # Safety net for when the model returns something over budget: trim back to
        # the last whole word that fits rather than slicing through the middle of a
        # word. Only a single word longer than the budget is hard-capped (unavoidable
        # at the storage limit). Mirrors Deck.fitShortName on the frontend.
        trimmed = candidate.strip()
        max_length = BeautifyDeckShortNames.MAX_SHORT_NAME_LENGTH

        if len(trimmed) <= max_length:
            return trimmed

        window = trimmed[:max_length]
        last_space_index = window.rfind(" ")
        if last_space_index > 0:
            return window[:last_space_index].rstrip()

        return window

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
