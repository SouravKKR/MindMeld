import asyncio
import json
import os

from Workflows.Workflow import Workflow
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
            "For each numbered deck path below, output a concise short name (max 16 characters) "
            "on its own line, in the same numbered order. Use only the LEAF of the path (the last "
            "segment) when crafting the short name, but consult the parent segments for context "
            "(so 'Math > Algebra > Limits' might shorten to 'Limits' rather than 'Math Limits'). "
            "Return exactly one line per input, in the format '<n>. <short name>'. Do not include "
            "any other commentary.\n\n"
            + "\n".join(prompt_lines)
        )

        request = AutomationRequest(
            BeautifyDeckShortNames.MODEL_NAME,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, BeautifyDeckShortNames.SYSTEM_PROMPT),
                AutomationContent(AutomationContentTypes.TEXT,   user_prompt),
            ]
        )

        response = await caller.call(request, None, retries = 2)

        if response is None:
            print("[BeautifyDeckShortNames] LLM returned no response for batch — falling back per entry.")
            return [None] * len(batch_entries)

        try:
            raw_output = response.get_output().get_data()
        except Exception as response_error:
            print(f"[BeautifyDeckShortNames] Failed to read LLM response: {response_error}")
            return [None] * len(batch_entries)

        if not isinstance(raw_output, str):
            print("[BeautifyDeckShortNames] LLM response was not text — falling back per entry.")
            return [None] * len(batch_entries)

        return BeautifyDeckShortNames.__parse_batch_response(raw_output, len(batch_entries))

    @staticmethod
    def __parse_batch_response(raw_output: str, expected_count: int) -> list[str | None]:
        parsed_short_names: list[str | None] = [None] * expected_count

        for raw_line in raw_output.splitlines():
            stripped_line = raw_line.strip()
            if not stripped_line:
                continue

            dot_position = stripped_line.find(".")
            if dot_position <= 0:
                continue

            leading_number = stripped_line[:dot_position].strip()
            if not leading_number.isdigit():
                continue

            entry_index = int(leading_number) - 1
            if entry_index < 0 or entry_index >= expected_count:
                continue

            candidate_short_name = stripped_line[dot_position + 1 :].strip()
            if not candidate_short_name:
                continue

            sanitized_short_name = candidate_short_name.strip("\"'`").strip()
            if not sanitized_short_name:
                continue

            parsed_short_names[entry_index] = sanitized_short_name[: BeautifyDeckShortNames.MAX_SHORT_NAME_LENGTH]

        return parsed_short_names

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
