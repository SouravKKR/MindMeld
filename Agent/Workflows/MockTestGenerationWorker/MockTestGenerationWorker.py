import json
import os
import random

from datetime import datetime, timezone

from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.BatchSubmitter import BatchSubmitter
from Globals.Classes.Automation.Pools.ModelPool import ModelPool
from Globals.Classes.Automation.Pools.PromptPool import PromptPool
from Globals.Classes.MockTest.SolvingStepsDirective import SolvingStepsDirective
from Globals.Classes.Automation.Providers.GeminiProvider import GeminiProvider
from Globals.Classes.Generic.Persistence import Persistence
from Globals.Classes.Generic.TokenSafeContent import TokenSafeContent
from Globals.Classes.Task.AutoGeneration.MockTestGenerationSettings import MockTestGenerationSettings
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Constants.PersistenceConstants import PersistenceConstants
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Enumerations.SectionQuestionCountModes import SectionQuestionCountModes
from Globals.Utility.JoinPath import join_path
from Globals.Utility.SanitizeFilename import sanitize_filename
from Globals.Utility.StripJsonMarkdown import strip_json_markdown
from Workflows.MockTestGenerationWorker.ConvertQuestions import convert_raw_questions
from Workflows.Workflow import Workflow


class MockTestGenerationWorker(Workflow):

    LENGTH_WEIGHT = 0.3
    RANDOM_WEIGHT = 0.7

    DIFFICULTY_ORDER = ["VERY_EASY", "EASY", "MEDIUM", "HARD", "VERY_HARD"]

    ALL_TYPE_KEYS = {
        "MULTIPLE_CHOICE", "MULTIPLE_CORRECT", "OBJECTIVE_SINGLE_WORD_OR_PHRASE",
        "SHORT_SUBJECTIVE", "MEDIUM_SUBJECTIVE", "LONG_SUBJECTIVE", "VERY_LONG_SUBJECTIVE"
    }
    OPTION_BASED_TYPES = {"MULTIPLE_CHOICE", "MULTIPLE_CORRECT"}

    # When the PYQ pool has at least this many seeds matching a given
    # question type, the worker switches that (topic, type) cell from the
    # fresh-generation prompt to the rephrase-aware prompt and feeds the
    # matching seeds in.
    MIN_SEEDS_FOR_REPHRASE = 1

    # Max seed PYQs embedded into a single cell's user prompt. Caps the
    # prompt size on large pools.
    MAX_SEEDS_PER_CELL = 6

    # Hard safety cap on the number of LLM cells a single mock-test task
    # may fan out into. Each cell = one batched LLM request; exceeding the
    # quota previously cost a 429 RESOURCE_EXHAUSTED. The cap converts a
    # latent quota crash into a clear pre-submit refusal the user can act on
    # (reduce topics, sections, or per-section question counts).
    MAX_CELLS_PER_TASK = 200

    # Per-cell prompt body cap. Mock-test cells embed every chunk that the
    # similarity-search step mapped to the topic — for a textbook chapter
    # this can run 500K-1M characters. We multiply that by every cell
    # generated for that topic (one per question type), then by every
    # topic in the paper. Capping the per-cell body at ~50K tokens
    # (~200K chars) is plenty for the LLM to write 2-10 questions of one
    # type without bloating the batch token bucket. This is significantly
    # tighter than TokenSafeContent's default 200K-token cap, which is
    # tuned for single-call use (e.g. flashcards, study material).
    PROMPT_BODY_TOKEN_CAP = 50_000

    def __init__(self, payload = {}):
        super().__init__(payload)
        self.__paths = payload["paths"]
        self.__total_weight = payload["totalWeight"]
        self.__num_questions = payload["numQuestions"]
        self.__exam_name = payload.get("examName", "")
        self.__subject_name = payload.get("subjectName", "the subject")
        self.__blueprint = payload["blueprint"]
        # Map from topic file path → pre-allocated question count, set by
        # GenerateMockTests for even-per-topic distribution. When absent
        # (legacy payload), falls back to the content+random heuristic.
        self.__topic_question_counts = payload.get("topicQuestionCounts", {}) or {}
        # Orchestrator-computed GLOBAL per-topic per-type breakdown (keyed by
        # topic path). Honours the question-type weightage across the whole
        # pool; absent on legacy payloads, in which case the worker falls back
        # to its own worker-global type allocation.
        self.__topic_type_counts = payload.get("topicTypeCounts", {}) or {}
        self.__pyq_pool = payload.get("pyqPool", []) or []
        self.__settings = MockTestGenerationSettings.from_json(payload.get("mockTestGenerationSettings", payload))

    # ── Helpers ────────────────────────────────────────────────────────────────

    @staticmethod
    def __largest_remainder_allocate(weights: list[float], total: int) -> list[int]:
        if not weights or total == 0:
            return [0] * len(weights)

        total_weight = sum(weights)
        if total_weight == 0:
            return [0] * len(weights)

        quotas           = [(w / total_weight) * total for w in weights]
        floors           = [int(q) for q in quotas]
        remainders       = [(quotas[i] - floors[i], i) for i in range(len(floors))]
        remainder_needed = total - sum(floors)

        remainders.sort(key = lambda entry: entry[0], reverse = True)
        for remainder_index in range(remainder_needed):
            floors[remainders[remainder_index][1]] += 1

        return floors

    def __allocate_types_across_topics(self, type_values: list[float], type_keys: list[str], topic_question_counts: list[int]) -> list[dict]:
        # Distribute this worker's WHOLE question budget across the question
        # types first (so the per-type weightage is honoured globally), then
        # spread each type's quota across the worker's topics in proportion to
        # each topic's own question count.
        #
        # This replaces a per-topic type allocation, which starved the later
        # types: when an individual topic only earns a handful of questions
        # (fewer than the number of types), the largest-remainder pass can only
        # cover the first few types — and because that same bias repeats for
        # every topic, the whole pool ends up dominated by the first types.
        # That is the reported "the test only contains the first few question
        # types" bug. Allocating globally lets every weighted type earn its
        # proportional share even when each individual topic is small.
        #
        # Column sums (per type) therefore match the weighted global
        # allocation; row sums (per topic) stay close to each topic's intended
        # share. The grand total is preserved exactly (largest-remainder always
        # allocates the full amount).
        topic_type_counts = [dict() for _ in topic_question_counts]

        worker_total = sum(topic_question_counts)
        if worker_total == 0:
            return topic_type_counts

        global_type_counts = self.__largest_remainder_allocate(type_values, worker_total)
        topic_weights      = [float(count) for count in topic_question_counts]

        for type_index, type_key in enumerate(type_keys):
            type_total = global_type_counts[type_index]
            if type_total == 0:
                continue

            per_topic_counts = self.__largest_remainder_allocate(topic_weights, type_total)
            for topic_index, topic_type_count in enumerate(per_topic_counts):
                if topic_type_count > 0:
                    topic_type_counts[topic_index][type_key] = topic_type_count

        return topic_type_counts

    def __allocate_questions_to_topics(self, topics: list[dict]) -> list[int]:
        # Preferred path: orchestrator pre-allocated counts evenly per topic.
        if self.__topic_question_counts:
            preallocated = [int(self.__topic_question_counts.get(topic["path"], 0)) for topic in topics]
            if sum(preallocated) > 0:
                return preallocated

        # Fallback (legacy payloads only): content-length + randomness blend.
        lengths       = [len("\n".join(topic["chunks"])) for topic in topics]
        max_len       = max(lengths) if max(lengths) > 0 else 1
        length_scores = [length / max_len for length in lengths]

        rand_scores = [random.random() for _ in topics]
        max_rand    = max(rand_scores) if max(rand_scores) > 0 else 1
        rand_scores = [random_score / max_rand for random_score in rand_scores]

        combined = [
            self.LENGTH_WEIGHT * length_scores[topic_index] + self.RANDOM_WEIGHT * rand_scores[topic_index]
            for topic_index in range(len(topics))
        ]

        return self.__largest_remainder_allocate(combined, self.__num_questions)

    def __get_hardest_difficulty(self, difficulty_counts: dict) -> str:
        for difficulty_key in reversed(self.DIFFICULTY_ORDER):
            if difficulty_counts.get(difficulty_key, 0) > 0:
                return difficulty_key
        return "MEDIUM"

    def __build_validator(self, type_key: str, expected_count: int):
        b_strict           = bool(self.__exam_name and self.__exam_name.strip())
        all_difficulty_keys = set(self.DIFFICULTY_ORDER)

        def validator(response) -> bool:
            try:
                data   = response.get_output().get_data()
                parsed = strip_json_markdown(data) if isinstance(data, str) else data

                if not isinstance(parsed, list) or len(parsed) == 0:
                    self._wlog(f"[Validator:{type_key}] Not a non-empty list. type={type(parsed).__name__}")
                    return False

                for question in parsed:
                    if not isinstance(question, dict):
                        self._wlog(f"[Validator:{type_key}] Question is not a dict: {question}")
                        return False
                    required = {"question", "expectedAnswer", "answerReason", "type", "difficulty", "marks"}
                    missing  = required - question.keys()
                    if missing:
                        self._wlog(f"[Validator:{type_key}] Missing keys: {missing}")
                        return False
                    if question["type"] not in self.ALL_TYPE_KEYS:
                        self._wlog(f"[Validator:{type_key}] Bad type value: '{question['type']}'")
                        return False
                    if question["difficulty"] not in all_difficulty_keys:
                        self._wlog(f"[Validator:{type_key}] Bad difficulty value: '{question['difficulty']}'")
                        return False
                    if type_key in self.OPTION_BASED_TYPES:
                        options = question.get("options")
                        if not isinstance(options, list) or len(options) == 0:
                            self._wlog(f"[Validator:{type_key}] Missing or empty options")
                            return False

                actual = len(parsed)
                if b_strict:
                    if actual != expected_count:
                        self._wlog(f"[Validator:{type_key}] Strict count fail: got {actual}, need {expected_count}")
                        return False
                else:
                    diff      = abs(actual - expected_count)
                    threshold = max(2, expected_count * 0.2)
                    if diff > threshold:
                        self._wlog(f"[Validator:{type_key}] Lenient count fail: got {actual}, need {expected_count}, threshold {threshold:.1f}")
                        return False

                return True

            except Exception as validation_error:
                self._wlog(f"[Validator:{type_key}] Exception: {validation_error}")
                return False

        return validator

    def __pick_seeds_for_cell(self, type_key: str) -> list[dict]:
        """
        Returns up to MAX_SEEDS_PER_CELL PYQ entries whose `type` matches
        the requested type_key. Deterministic ordering — first matches in
        pool order — keeps generation reproducible per task run.
        """
        if not self.__pyq_pool:
            return []

        matches = [seed for seed in self.__pyq_pool if seed.get("type") == type_key]
        return matches[:self.MAX_SEEDS_PER_CELL]

    @staticmethod
    def __format_seeds_block(seeds: list[dict]) -> str:
        lines = []
        for seed_index, seed in enumerate(seeds, start=1):
            answer_part = f"\n   Answer: {seed['answer']}" if seed.get("answer") else ""
            difficulty = seed.get("difficulty") or "UNKNOWN"
            lines.append(f"{seed_index}. ({difficulty}) {seed['question']}{answer_part}")
        return "\n\n".join(lines)

    def __format_marking_scheme_summary(self) -> str:
        """
        Produces a human-readable summary of the marking scheme on the
        MockTestGenerationSettings — the same shape the user configured in
        the UI / template — for embedding in the LLM system prompt.

        Layout:
            Default rule: correct=+4, wrong=-1, unattempted=0, partial=0
            Per-question-type overrides:
              * OBJECTIVE_SINGLE_WORD_OR_PHRASE: wrong=0
            Per-section overrides:
              * Section II (Multi-correct) [MULTIPLE_CORRECT]: correct=+4, wrong=-2, partial=+1
        """
        settings = self.__settings

        correct_marks     = settings.get_correct_marks()
        wrong_marks       = settings.get_wrong_marks()
        unattempted_marks = settings.get_unattempted_marks()
        partial_marks     = settings.get_partial_marks()

        default_line = (
            f"Default rule: correct={MockTestGenerationWorker.__format_marks(correct_marks)}, "
            f"wrong={MockTestGenerationWorker.__format_marks(wrong_marks)}, "
            f"unattempted={MockTestGenerationWorker.__format_marks(unattempted_marks)}, "
            f"partial={MockTestGenerationWorker.__format_marks(partial_marks)}"
        )

        lines = [default_line]

        type_overrides = settings.get_per_type_marking_overrides() or {}
        if isinstance(type_overrides, dict) and len(type_overrides) > 0:
            lines.append("Per-question-type overrides:")
            for type_key, override_rule in type_overrides.items():
                if not isinstance(override_rule, dict):
                    continue
                lines.append(f"  * {type_key}: {MockTestGenerationWorker.__format_override_rule(override_rule)}")

        section_structure = settings.get_section_structure() or []
        if isinstance(section_structure, list) and len(section_structure) > 0:
            lines.append("Section structure (each section describes how questions group + score; counts are realized per generation):")
            for section_entry in section_structure:
                if not isinstance(section_entry, dict):
                    continue
                section_name = section_entry.get("name", "Unnamed section")
                applicable_types = section_entry.get("questionTypes") or []
                applicable_label = f" types=[{', '.join(applicable_types)}]" if applicable_types else " types=[any]"
                count_summary = MockTestGenerationWorker.__format_section_question_count(section_entry)
                total_marks = section_entry.get("totalMarks") or 0
                rule_summary = MockTestGenerationWorker.__format_override_rule(section_entry)
                lines.append(
                    f"  * {section_name}: {count_summary}, {total_marks} marks,"
                    f"{applicable_label}, {rule_summary}"
                )

        return "\n".join(lines)

    @staticmethod
    def __format_section_question_count(section_entry: dict) -> str:
        if section_entry.get("questionCountMode") == SectionQuestionCountModes.RANGE.value:
            minimum_count = int(section_entry.get("questionCountMin") or 0)
            maximum_count = int(section_entry.get("questionCountMax") or minimum_count)
            configured_weights = section_entry.get("questionCountWeights") or {}

            peak_candidate = None
            peak_weight = -1.0
            if maximum_count >= minimum_count:
                for candidate_value in range(minimum_count, maximum_count + 1):
                    raw_weight = configured_weights.get(str(candidate_value))
                    candidate_weight = float(raw_weight) if isinstance(raw_weight, (int, float)) else 1.0
                    if candidate_weight > peak_weight:
                        peak_weight = candidate_weight
                        peak_candidate = candidate_value

            if peak_candidate is None:
                return f"range {minimum_count}-{maximum_count} questions"
            return f"range {minimum_count}-{maximum_count} questions (most likely {peak_candidate})"

        question_count = int(section_entry.get("questionCount") or 0)
        return f"{question_count} questions"

    @staticmethod
    def __format_marks(value) -> str:
        # None values indicate "inherit from a higher tier" — they come from
        # legacy payloads that predate the marking-scheme schema, where the
        # JSON dictionary did not include these keys at all.
        if value is None:
            return "inherit"
        try:
            numeric_value = float(value)
        except (TypeError, ValueError):
            return str(value)
        sign = "+" if numeric_value > 0 else ""
        if numeric_value.is_integer():
            return f"{sign}{int(numeric_value)}"
        return f"{sign}{numeric_value:g}"

    @staticmethod
    def __format_override_rule(rule_dict: dict) -> str:
        parts = []
        for field_label, field_key in (
            ("correct", "correctMarks"),
            ("wrong", "wrongMarks"),
            ("unattempted", "unattemptedMarks"),
            ("partial", "partialMarks"),
        ):
            if field_key in rule_dict:
                parts.append(f"{field_label}={MockTestGenerationWorker.__format_marks(rule_dict[field_key])}")
        return ", ".join(parts) if parts else "(no fields overridden — inherits default)"

    def __build_request(self, topic: dict, type_key: str, type_questions: int, difficulty_counts: dict):
        difficulty_parts = [
            f"{count} {difficulty_key}"
            for difficulty_key, count in difficulty_counts.items()
            if count > 0
        ]
        difficulty_breakdown = ", ".join(difficulty_parts)
        topic_chain_string = " -> ".join(topic["topicChain"])
        content = "\n\n".join(topic["chunks"])
        content = TokenSafeContent.cap_content_for_prompt(
            content,
            max_tokens = MockTestGenerationWorker.PROMPT_BODY_TOKEN_CAP,
            label = f"mock-test topic content ({topic_chain_string}, type={type_key})",
        )

        seeds = self.__pick_seeds_for_cell(type_key)
        use_rephrase_prompt = len(seeds) >= self.MIN_SEEDS_FOR_REPHRASE

        marking_scheme_summary = self.__format_marking_scheme_summary()
        show_solving_steps_block = SolvingStepsDirective.for_flag(bool(self.__settings.get_show_solving_steps()))

        if use_rephrase_prompt:
            seed_block = self.__format_seeds_block(seeds)
            system_text = (
                PromptPool.MOCK_TEST_QUESTION_REPHRASE_SYSTEM
                .replace("{marking_scheme_summary}", marking_scheme_summary)
                .replace("{show_solving_steps_block}", show_solving_steps_block)
            )
            user_prompt = (
                PromptPool.MOCK_TEST_QUESTION_REPHRASE_USER
                .replace("{exam_name}", self.__exam_name if self.__exam_name else "General")
                .replace("{subject_name}", self.__subject_name)
                .replace("{topic_chain}", topic_chain_string)
                .replace("{content}", content)
                .replace("{seed_questions_block}", seed_block)
                .replace("{num_questions}", str(type_questions))
                .replace("{type_breakdown}", f"exactly {type_questions} {type_key}")
                .replace("{difficulty_breakdown}", difficulty_breakdown)
            )
        else:
            system_text = (
                PromptPool.MOCK_TEST_QUESTION_GENERATION_SYSTEM
                .replace("{marking_scheme_summary}", marking_scheme_summary)
                .replace("{show_solving_steps_block}", show_solving_steps_block)
            )
            user_prompt = (
                PromptPool.MOCK_TEST_QUESTION_GENERATION_USER
                .replace("{exam_name}", self.__exam_name if self.__exam_name else "General")
                .replace("{subject_name}", self.__subject_name)
                .replace("{topic_chain}", topic_chain_string)
                .replace("{content}", content)
                .replace("{num_questions}", str(type_questions))
                .replace("{type_breakdown}", f"exactly {type_questions} {type_key}")
                .replace("{difficulty_breakdown}", difficulty_breakdown)
            )

        hardest = self.__get_hardest_difficulty(difficulty_counts)
        model_string, _provider_class = ModelPool.MOCK_TEST_MODEL_MAP.get(
            (hardest, type_key),
            ModelPool.MOCK_TEST_AUTO_MODEL
        )

        request = AutomationRequest(
            model_string,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, system_text),
                AutomationContent(AutomationContentTypes.TEXT,   user_prompt),
            ]
        )

        return request, model_string

    # ── Entry point ────────────────────────────────────────────────────────────

    async def run(self, args = {}):
        main_task_id   = os.getenv("MAIN_TASK_ID")
        parent_task_id = os.getenv("PARENT_TASK_ID")

        worker_id = os.getenv("TASK_ID", "unknown")
        log_lines = []

        def wlog(message: str):
            print(message)
            log_lines.append(message)
        self._wlog = wlog

        async def flush_wlog():
            try:
                log_path = join_path(
                    "/", PersistenceConstants.TASKS_DIRECTORY, main_task_id,
                    f"Worker_{worker_id}.log"
                )
                await Persistence.write(log_path, "\n".join(log_lines))
            except Exception as write_log_error:
                print(f"[MockTestGenerationWorker] Could not write worker log: {write_log_error}")

        wlog(f"[MockTestGenerationWorker] Starting. task={worker_id} main={main_task_id} parent={parent_task_id}")
        wlog(f"[MockTestGenerationWorker] paths={self.__paths}")
        wlog(f"[MockTestGenerationWorker] numQuestions={self.__num_questions}")

        try:
            blueprint_format = self.__blueprint["format"]
            difficulty_dist  = self.__blueprint["difficultyDistribution"]
        except Exception as blueprint_error:
            wlog(f"[MockTestGenerationWorker] ERROR reading blueprint: {blueprint_error}")
            await flush_wlog()
            raise

        type_keys   = list(blueprint_format.keys())
        type_values = [float(blueprint_format[key]) for key in type_keys]

        difficulty_keys   = list(difficulty_dist.keys())
        difficulty_values = [float(difficulty_dist[key]) for key in difficulty_keys]

        wlog(f"[MockTestGenerationWorker] Blueprint types: {type_keys}")
        wlog(f"[MockTestGenerationWorker] Blueprint difficulties: {difficulty_keys}")
        await flush_wlog()

        # ── 1. Load all topic files ────────────────────────────────────────────
        topics = []
        for path in self.__paths:
            try:
                raw = json.loads((await Persistence.read(path)).decode("utf-8"))
                topics.append({
                    "path":       path,
                    "topicChain": raw["topicChain"],
                    "chunks":     raw["chunks"],
                    "weight":     float(raw.get("weight", 0.0)),
                })
                wlog(f"[MockTestGenerationWorker] Loaded topic: {raw['topicChain']}")
            except Exception as load_error:
                wlog(f"[MockTestGenerationWorker] Failed to load topic at '{path}': {load_error}")
                continue

        if not topics:
            wlog("[MockTestGenerationWorker] No topics loaded. Exiting.")
            await flush_wlog()
            return

        # ── 2. Allocate questions across topics ────────────────────────────────
        topic_question_counts = self.__allocate_questions_to_topics(topics)
        wlog(f"[MockTestGenerationWorker] Question allocation per topic: {topic_question_counts}")
        await flush_wlog()

        # ── 3. Build per-cell requests across all topics ───────────────────────
        # Prefer the orchestrator's GLOBAL per-topic per-type breakdown (keyed
        # by topic path) so the per-type weightage is honoured across the whole
        # pool. Fall back to a worker-global allocation for legacy payloads that
        # don't carry it. Either way, types are NOT split per topic in
        # isolation — that starves the later types when topics are small. See
        # __allocate_types_across_topics for the rationale.
        if self.__topic_type_counts:
            topic_type_allocations = [
                dict(self.__topic_type_counts.get(topic["path"], {}) or {})
                for topic in topics
            ]
        else:
            topic_type_allocations = self.__allocate_types_across_topics(type_values, type_keys, topic_question_counts)

        topic_cells = []

        for topic_index, (topic, topic_questions) in enumerate(zip(topics, topic_question_counts)):
            topic_chain = topic["topicChain"]
            safe_unit = sanitize_filename(topic_chain[0]) if topic_chain else "Uncategorised"
            safe_topic = sanitize_filename(topic_chain[-1]) if topic_chain else "Unknown"
            output_path = join_path(
                "/",
                PersistenceConstants.TASKS_DIRECTORY,
                main_task_id,
                PersistenceConstants.MOCK_TEST_QUESTIONS_DIRECTORY,
                safe_unit,
                f"{safe_topic}.json",
            )

            # Checkpoint-resume: if this topic's questions were already written in
            # a prior (paused) run, reuse them — no cells, no LLM. Its full weight
            # is granted in the aggregation loop below.
            if await Persistence.exists(output_path):
                wlog(f"[MockTestGenerationWorker] Reusing existing questions for '{' -> '.join(topic_chain)}' — skipping generation.")
                topic_cells.append({"topic_index": topic_index, "topic": topic, "cells": [], "reused": True, "output_path": output_path})
                continue

            type_allocation = topic_type_allocations[topic_index]
            if not type_allocation:
                topic_cells.append({"topic_index": topic_index, "topic": topic, "cells": [], "reused": False, "output_path": output_path})
                continue

            wlog(f"[MockTestGenerationWorker] Topic {topic_index} type allocation: {type_allocation}")

            cells = []
            for type_key, type_q_count in type_allocation.items():
                difficulty_counts_raw = self.__largest_remainder_allocate(difficulty_values, type_q_count)
                difficulty_allocation = {
                    difficulty_keys[difficulty_index]: difficulty_counts_raw[difficulty_index]
                    for difficulty_index in range(len(difficulty_keys))
                    if difficulty_counts_raw[difficulty_index] > 0
                }

                request, model_string = self.__build_request(topic, type_key, type_q_count, difficulty_allocation)
                cell_key              = f"topic-{topic_index}-type-{type_key}"

                cells.append({
                    "key":          cell_key,
                    "request":      request,
                    "model_string": model_string,
                    "type_key":     type_key,
                    "expected":     type_q_count,
                })

            topic_cells.append({"topic_index": topic_index, "topic": topic, "cells": cells, "reused": False, "output_path": output_path})

        # ── 4. Pre-submit safety check + telemetry ─────────────────────────────
        total_cell_count = sum(len(entry["cells"]) for entry in topic_cells)
        wlog(
            f"[MockTestGenerationWorker] Prepared {total_cell_count} cell(s) across "
            f"{len(topic_cells)} topic(s); safety cap is {MockTestGenerationWorker.MAX_CELLS_PER_TASK}."
        )
        await flush_wlog()
        if total_cell_count > MockTestGenerationWorker.MAX_CELLS_PER_TASK:
            wlog(
                f"[MockTestGenerationWorker] Cell count {total_cell_count} exceeds safety cap "
                f"{MockTestGenerationWorker.MAX_CELLS_PER_TASK} — refusing to spam the LLM. "
                f"Reduce topic count, sections, or per-section question counts."
            )
            await flush_wlog()
            return

        # ── 5. Group cells by model and submit batches ─────────────────────────
        main_task                  = await TaskManager.get_task(main_task_id)
        batch_submitters_by_model  = {}
        validators_by_key          = {}

        for entry in topic_cells:
            for cell in entry["cells"]:
                if cell["model_string"] not in batch_submitters_by_model:
                    batch_submitters_by_model[cell["model_string"]] = BatchSubmitter(cell["model_string"], main_task = main_task)
                batch_submitters_by_model[cell["model_string"]].enqueue(cell["key"], cell["request"])
                validators_by_key[cell["key"]] = self.__build_validator(cell["type_key"], cell["expected"])

        wlog(
            f"[MockTestGenerationWorker] Submitting {total_cell_count} cell(s) across "
            f"{len(batch_submitters_by_model)} model(s): {list(batch_submitters_by_model.keys())}"
        )
        await flush_wlog()

        live_fallback_caller = AutomationCaller(GeminiProvider())

        # Grant the submit-time share of each topic's weight up front so the
        # parent bar advances when batches are dispatched, not only when every
        # batch returns minutes later. The remaining share lands per topic below.
        # Reused topics are skipped here — their full weight lands in the
        # aggregation loop instead.
        for entry in topic_cells:
            if entry.get("reused"):
                continue
            await TaskManager.increment_completion(parent_task_id, BatchSubmitter.SUBMIT_PROGRESS_SHARE * entry["topic"]["weight"])

        responses_by_key = {}
        for submitter in batch_submitters_by_model.values():
            submitter_results = await live_fallback_caller.call_batch(
                submitter,
                live_fallback_caller = live_fallback_caller,
                validators           = validators_by_key,
            )
            responses_by_key.update(submitter_results)

        await flush_wlog()

        # ── 6. Aggregate per topic, persist, and increment completion ──────────
        total_questions_persisted = 0
        for entry in topic_cells:
            topic           = entry["topic"]
            topic_chain     = topic["topicChain"]
            topic_chain_str = " -> ".join(topic_chain)

            # Reused topic: its questions are already on disk — grant the full
            # weight and leave the existing file untouched (do NOT overwrite with
            # an empty list, which the no-cells path below would otherwise do).
            if entry.get("reused"):
                await TaskManager.increment_completion(parent_task_id, topic["weight"])
                continue

            raw_questions = []
            for cell in entry["cells"]:
                response = responses_by_key.get(cell["key"])
                if response is None:
                    wlog(f"[MockTestGenerationWorker] '{topic_chain_str}' / {cell['type_key']}: no response (after fallback), skipping cell.")
                    continue

                try:
                    data   = response.get_output().get_data()
                    parsed = strip_json_markdown(data) if isinstance(data, str) else data
                    if isinstance(parsed, list):
                        raw_questions.extend(parsed)
                except Exception as parse_error:
                    wlog(f"[MockTestGenerationWorker] '{topic_chain_str}' / {cell['type_key']}: parse failed — {parse_error}")
                    continue

            converted = convert_raw_questions(raw_questions)
            total_questions_persisted += len(converted)

            wlog(f"[MockTestGenerationWorker] '{topic_chain_str}': {len(converted)} question(s) generated.")

            output = {
                "topicChain":  topic_chain,
                "questions":   converted,
                "generatedAt": datetime.now(timezone.utc).isoformat(),
            }

            file_path = entry["output_path"]

            try:
                await Persistence.write(file_path, json.dumps(output, ensure_ascii=False))
                wlog(f"[MockTestGenerationWorker] Written: {file_path}")
            except Exception as write_error:
                wlog(f"[MockTestGenerationWorker] WRITE FAILED for '{topic_chain_str}': {write_error}")

            await flush_wlog()

            await TaskManager.increment_completion(parent_task_id, (1.0 - BatchSubmitter.SUBMIT_PROGRESS_SHARE) * topic["weight"])

        if total_questions_persisted < self.__num_questions:
            wlog(
                f"[MockTestGenerationWorker] Strict count miss: pool target was {self.__num_questions} "
                f"but only {total_questions_persisted} question(s) survived validation. The downstream "
                f"GenerateMockTests step will distribute what is available; consider re-running with a "
                f"smaller per-test count or more lenient settings if this gap is too large for one mock test."
            )
        else:
            wlog(
                f"[MockTestGenerationWorker] Persisted {total_questions_persisted} question(s) "
                f"against pool target {self.__num_questions}."
            )

        wlog("[MockTestGenerationWorker] Done.")
        await flush_wlog()
