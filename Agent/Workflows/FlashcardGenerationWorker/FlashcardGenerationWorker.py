import json
import math
import os
import random

from datetime import datetime, timezone

from Workflows.Workflow import Workflow
from Workflows.FlashcardGenerationWorker.BuildValidator import build_validator, build_thin_batch_validator
from Workflows.FlashcardGenerationWorker.BuildPrompts import (
    build_question_types_instruction,
    build_difficulty_instruction,
    build_cell_question_types_instruction,
    build_cell_difficulty_instruction,
)
from Workflows.FlashcardGenerationWorker.ConvertCards import convert_raw_cards
from Globals.Classes.Compliance.SourceSimilarityScorer import SourceSimilarityScorer
from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.BatchSubmitter import BatchSubmitter
from Globals.Classes.Automation.Pools.ModelPool import ModelPool
from Globals.Classes.Automation.Pools.PromptPool import PromptPool
from Globals.Classes.Automation.Providers.GoogleEnterpriseAiProvider import GoogleEnterpriseAiProvider
from Globals.Classes.Generic.Persistence import Persistence
from Globals.Classes.Generic.TokenSafeContent import TokenSafeContent
from Globals.Classes.Task.AutoGeneration.FlashcardGenerationSettings import FlashcardGenerationSettings
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Constants.PersistenceConstants import PersistenceConstants
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Enumerations.AutomationLevels import AutomationLevels
from Globals.Enumerations.DifficultyLevels import DifficultyLevels
from Globals.Enumerations.QuestionTypes import QuestionTypes
from Globals.Utility.JoinPath import join_path
from Globals.Utility.SanitizeFilename import sanitize_filename
from Globals.Utility.StripJsonMarkdown import strip_json_markdown


class FlashcardGenerationWorker(Workflow):

    THIN_TOPIC_BATCH_SIZE = 20
    MAX_CONCURRENT_CALLS  = 5

    # Per-cell prompt body cap. A flashcard cell generates 5-15 cards from
    # one topic, plus a fixed system prompt. 30K tokens (~120K chars) is
    # ample context for that — and importantly, with 10-20 cells fanning
    # out per worker, this keeps the per-minute TPM bucket from saturating
    # when batch + live-fallback share the same minute window.
    PROMPT_BODY_TOKEN_CAP = 30_000

    MARK_FOR_REVIEW_GUIDANCE = "Mark a card for review if the question seems important and the student reading this card should prioritise it. If in doubt, roughly the top 50% most important questions must be marked for review."

    def __init__(self, payload = {}):
        super().__init__(payload)
        self.__paths = payload["paths"]
        self.__total_weight = payload["totalWeight"]
        self.__flashcard_generation_settings: FlashcardGenerationSettings = FlashcardGenerationSettings.from_json(payload["flashcardGenerationSettings"])

    async def run(self, args = {}):
        main_task_id = os.getenv("MAIN_TASK_ID")
        parent_task_id = os.getenv("PARENT_TASK_ID")

        # ── 1. Load and build topic objects ───────────────────────────────────
        topics = []

        # Topic-chain -> source pages, so the thin-batch path (which only carries
        # topicChain through the LLM response) can recover each topic's pages when
        # writing its output file.
        source_pages_by_topic_chain = {}

        for path in self.__paths:
            content_bytes = await Persistence.read(path)
            raw = json.loads(content_bytes.decode("utf-8"))

            source_pages = raw.get("sourcePages", [])
            source_pages_by_topic_chain[" -> ".join(raw["topicChain"])] = source_pages

            content = "\n\n".join(raw["chunks"])
            content = TokenSafeContent.cap_content_for_prompt(
                content,
                max_tokens = FlashcardGenerationWorker.PROMPT_BODY_TOKEN_CAP,
                label = f"flashcard topic content ({' -> '.join(raw['topicChain'])})",
            )
            word_count = len(content.split())

            topics.append({
                "topic_chain": raw["topicChain"],
                "source_pages": source_pages,
                "content": content,
                "weight": float(raw.get("weight", 0.0)),
                "word_count": word_count,
            })

        # ── 1b. Checkpoint-resume: flag topics already generated in a prior run ─
        # The per-topic Flashcards/{unit}/{topic}.json file in GCS is the
        # checkpoint. A topic whose file already exists is granted its full weight
        # here and skipped during generation below (both thin and thick paths), so
        # a resumed run regenerates only the missing topics. Reused topics stay in
        # main_topics so the card-count distribution math over the full set is
        # unchanged — only their generation is skipped.
        for topic in topics:
            topic_chain = topic["topic_chain"]
            safe_unit = sanitize_filename(topic_chain[0]) if topic_chain else "Uncategorised"
            safe_topic = sanitize_filename(topic_chain[-1]) if topic_chain else "Unknown"
            topic["output_path"] = join_path(
                "/",
                PersistenceConstants.TASKS_DIRECTORY,
                main_task_id,
                PersistenceConstants.FLASHCARDS_DIRECTORY,
                safe_unit,
                f"{safe_topic}.json",
            )
            topic["reused"] = await Persistence.exists(topic["output_path"])
            if topic["reused"]:
                print(f"[FlashcardGenerationWorker] Reusing existing cards for '{' -> '.join(topic_chain)}' — skipping generation.")
                await TaskManager.increment_completion(parent_task_id, topic["weight"])

        # ── 2. Separate thin topics and batch them (reused topics excluded) ────
        thin_topics = [topic for topic in topics if topic["word_count"] < 100 and not topic["reused"]]
        main_topics = [topic for topic in topics if topic["word_count"] >= 100]

        thin_topic_batches = []
        current_batch = []

        for topic in thin_topics:
            if len(current_batch) >= FlashcardGenerationWorker.THIN_TOPIC_BATCH_SIZE:
                thin_topic_batches.append(current_batch)
                current_batch = []
            current_batch.append(topic)

        if current_batch:
            thin_topic_batches.append(current_batch)

        # ── 3. Resolve card count per main topic ──────────────────────────────
        settings = self.__flashcard_generation_settings
        num_cards_method = settings.get_num_cards_method()

        group_num_questions = round(self.__total_weight * settings.get_num_questions_to_generate())
        non_thin_weight_sum = sum(topic["weight"] for topic in main_topics)

        for topic in main_topics:
            if num_cards_method == AutomationLevels.AUTOMATIC:
                card_count = max(2, min(15, topic["word_count"] // 100))
            else:
                normalised_weight = topic["weight"] / non_thin_weight_sum if non_thin_weight_sum > 0 else 0
                card_count = max(2, round(normalised_weight * group_num_questions))

            topic["card_count"] = card_count

        # ── 4. Resolve question type distribution per topic ───────────────────
        question_types_method = settings.get_question_types_method()
        resolved_type_weights = self._payload.get("resolvedTypeWeights", None)
        all_question_type_keys = [question_type.name for question_type in QuestionTypes]
        all_question_type_names = set(all_question_type_keys)

        for topic in main_topics:
            if question_types_method == AutomationLevels.AUTOMATIC:
                if resolved_type_weights is not None:
                    topic["allowed_types"] = resolved_type_weights
                else:
                    topic["allowed_types"] = all_question_type_keys

            else:
                weights_source = resolved_type_weights if resolved_type_weights is not None else settings.get_question_types_with_weights()

                filtered_weights = {
                    question_type_key: weight
                    for question_type_key, weight in weights_source.items()
                    if weight > 0
                }

                if not filtered_weights:
                    filtered_weights = {question_type_key: 1 for question_type_key in all_question_type_keys}

                card_count = topic["card_count"]

                if len(filtered_weights) > card_count:
                    filtered_weights = dict(
                        sorted(filtered_weights.items(), key=lambda entry: entry[1], reverse=True)[:card_count]
                    )

                total_weight = sum(filtered_weights.values())

                topic["type_distribution"] = {
                    question_type_key: max(1, round((weight / total_weight) * card_count))
                    for question_type_key, weight in filtered_weights.items()
                }

        # ── 5. Resolve difficulty distribution per topic ──────────────────────
        difficulty_method = settings.get_difficulty_method()
        all_difficulty_keys = [difficulty_level.name for difficulty_level in DifficultyLevels]
        all_difficulty_names = set(all_difficulty_keys)

        for topic in main_topics:
            if difficulty_method == AutomationLevels.AUTOMATIC:
                topic["allowed_difficulties"] = all_difficulty_keys

            else:
                filtered_weights = {
                    difficulty_key: weight
                    for difficulty_key, weight in settings.get_question_difficulty_with_weights().items()
                    if weight > 0
                }

                if not filtered_weights:
                    filtered_weights = {difficulty_key: 1 for difficulty_key in all_difficulty_keys}

                card_count = topic["card_count"]

                if len(filtered_weights) > card_count:
                    filtered_weights = dict(
                        sorted(filtered_weights.items(), key=lambda entry: entry[1], reverse=True)[:card_count]
                    )

                total_weight = sum(filtered_weights.values())

                topic["difficulty_distribution"] = {
                    difficulty_key: max(1, round((weight / total_weight) * card_count))
                    for difficulty_key, weight in filtered_weights.items()
                }

        # ── 6. Build the (difficulty x type) call matrix per topic ───────────
        for topic in main_topics:
            card_count = topic["card_count"]
            b_type_manual = question_types_method != AutomationLevels.AUTOMATIC
            b_difficulty_manual = difficulty_method != AutomationLevels.AUTOMATIC

            if b_type_manual and b_difficulty_manual:
                # ── Flat list of (difficulty, type, ideal_float_count) cells ──
                raw_cells = []
                for difficulty_key, difficulty_count in topic["difficulty_distribution"].items():
                    for type_key, type_count in topic["type_distribution"].items():
                        ideal = difficulty_count * type_count / card_count
                        if ideal > 0:
                            raw_cells.append([difficulty_key, type_key, ideal])

                # ── Floor every cell, then distribute remainders largest-first ─
                floored = [[d, t, math.floor(v)] for d, t, v in raw_cells]
                remainders = sorted(
                    range(len(raw_cells)),
                    key=lambda i: raw_cells[i][2] - floored[i][2],
                    reverse=True,
                )
                assigned = sum(f[2] for f in floored)
                for remainder_index in remainders:
                    if assigned >= card_count:
                        break
                    floored[remainder_index][2] += 1
                    assigned += 1

                topic["call_matrix"] = [
                    (d, t, max(1, c))
                    for d, t, c in floored
                    if c > 0
                ]

            else:
                topic["call_matrix"] = [(None, None, card_count)]

        # ── 7. Group cells by model ───────────────────────────────────────────
        for topic in main_topics:
            model_groups = {}

            for (difficulty_key, type_key, cell_count) in topic["call_matrix"]:
                if difficulty_key is None and type_key is None:
                    model_tuple = ModelPool.FLASHCARD_AUTO_MODEL
                else:
                    model_tuple = ModelPool.FLASHCARD_MODEL_MAP.get((difficulty_key, type_key))

                    if model_tuple is None:
                        print(f"[WARN] No model found for ({difficulty_key}, {type_key}) — falling back to FLASHCARD_AUTO_MODEL.")
                        model_tuple = ModelPool.FLASHCARD_AUTO_MODEL

                if model_tuple not in model_groups:
                    model_groups[model_tuple] = []

                model_groups[model_tuple].append((difficulty_key, type_key, cell_count))

            topic["model_groups"] = model_groups

        # ── 8. Build the shared system prompt ─────────────────────────────────
        # The shared expression rules are prepended so this prompt inherits the
        # same copyright/accuracy posture as every other generation prompt —
        # verbatim for formulae and terms of art, own words for prose.
        system_prompt = PromptPool.SOURCE_EXPRESSION_RULES + "\n" + PromptPool.FLASHCARD_GENERATION_SYSTEM.replace(
            "{mark_for_review_guidance}", FlashcardGenerationWorker.MARK_FOR_REVIEW_GUIDANCE
        )

        # ── 9. Build user prompt and requests per topic per model group cell ──
        exam_name = settings.get_exam_name()
        subject_name = settings.get_subject_name()
        additional_instructions = settings.get_additional_instructions()
        b_mark_for_review = settings.get_b_mark_questions_for_review()

        exam_context = f"This is being prepared for the {exam_name} exam." if exam_name else ""

        additional_instructions_block = (
            f"User's additional instructions — these take precedence over all guidelines above:\n{additional_instructions}"
            if additional_instructions else ""
        )

        for topic in main_topics:
            topic["requests"] = []
            if topic["reused"]:
                continue
            topic_chain_string = " -> ".join(topic["topic_chain"])

            for model_tuple, cells in topic["model_groups"].items():
                model_string, provider_class = model_tuple

                for (difficulty_key, type_key, cell_count) in cells:
                    b_auto_cell = difficulty_key is None and type_key is None

                    if b_auto_cell:
                        question_types_instruction = build_question_types_instruction(topic, question_types_method)
                        difficulty_instruction = build_difficulty_instruction(topic, difficulty_method)
                        total_cards = topic["card_count"]
                    else:
                        question_types_instruction = build_cell_question_types_instruction(difficulty_key, type_key, cell_count)
                        difficulty_instruction = build_cell_difficulty_instruction(difficulty_key)
                        total_cards = cell_count

                    user_prompt = (
                        PromptPool.FLASHCARD_GENERATION_USER
                        .replace("{content}", topic["content"])
                        .replace("{topic_chain}", topic_chain_string)
                        .replace("{exam_context}", exam_context)
                        .replace("{subject}", subject_name)
                        .replace("{total_cards}", str(total_cards))
                        .replace("{question_types_instruction}", question_types_instruction)
                        .replace("{difficulty_instruction}", difficulty_instruction)
                        .replace("{mark_for_review_instruction}", "Mark appropriate cards for review." if b_mark_for_review else "Do not mark any cards for review. Set markedForReview to false for all cards.")
                        .replace("{additional_instructions_block}", additional_instructions_block)
                    )

                    request = AutomationRequest(
                        model_string,
                        [
                            AutomationContent(AutomationContentTypes.SYSTEM, system_prompt),
                            AutomationContent(AutomationContentTypes.TEXT, user_prompt),
                        ]
                    )

                    cell_key = f"topic-{len(main_topics)}-{id(topic)}-cell-{len(topic['requests'])}"
                    topic["requests"].append({
                        "request":        request,
                        "provider_class": provider_class,
                        "expected_count": total_cards,
                        "key":            cell_key,
                    })

        # ── 10. Build batch submitters grouped by model and submit ────────────
        main_task = await TaskManager.get_task(main_task_id)

        batch_submitters_by_model = {}
        validators_by_key         = {}

        for topic in main_topics:
            for request_entry in topic["requests"]:
                request_model_string = request_entry["request"].get_model()

                if request_model_string not in batch_submitters_by_model:
                    batch_submitters_by_model[request_model_string] = BatchSubmitter(request_model_string, main_task = main_task)

                submitter = batch_submitters_by_model[request_model_string]
                submitter.enqueue(request_entry["key"], request_entry["request"])

                validators_by_key[request_entry["key"]] = build_validator(
                    all_question_type_names,
                    all_difficulty_names,
                    request_entry["expected_count"],
                )

        live_fallback_caller = AutomationCaller(GoogleEnterpriseAiProvider())

        responses_by_key = {}
        for submitter in batch_submitters_by_model.values():
            submitter_results = await live_fallback_caller.call_batch(
                submitter,
                live_fallback_caller = live_fallback_caller,
                validators           = validators_by_key,
            )
            responses_by_key.update(submitter_results)

        # ── 11. Aggregate per topic, deduplicate, trim, persist and report ────
        for topic in main_topics:
            # Reused topics were granted their weight up front and have no
            # requests — leave the existing file untouched.
            if topic["reused"]:
                continue

            target_count = topic["card_count"]

            raw_card_lists = []
            for request_entry in topic["requests"]:
                response = responses_by_key.get(request_entry["key"])
                if response is None:
                    print(f"[WARN] Cell '{request_entry['key']}' produced no response — skipping.")
                    raw_card_lists.append([])
                    continue

                try:
                    data   = response.get_output().get_data()
                    parsed = strip_json_markdown(data) if isinstance(data, str) else data
                    raw_card_lists.append(parsed if isinstance(parsed, list) else [])
                except Exception:
                    raw_card_lists.append([])

            raw_cards = [card for card_list in raw_card_lists for card in card_list]

            converted_cards = convert_raw_cards(raw_cards)

            # Containment telemetry against the source chunks these cards were
            # grounded on, with formulae, notation and terms of art masked out
            # first so content that MUST be reproduced exactly is never counted
            # as copied.
            #
            # Study material has been scored since the scorer was introduced;
            # flashcards were not, despite being generated from the same chunks.
            # Enforcement stays off here exactly as it is there — the point is to
            # gather the distribution a threshold would have to be set from, and
            # a threshold guessed without it either fires constantly or never.
            #
            # Scored as one document per topic rather than per card: a single
            # card is often shorter than the scorer's minimum prose length, so
            # per-card scoring would report "not scored" for most of a deck and
            # produce no usable distribution at all.
            if converted_cards:
                combined_card_prose = "\n".join(
                    f"{card.get('question') or ''}\n{card.get('answer') or ''}"
                    for card in converted_cards
                )
                SourceSimilarityScorer.evaluate_gate(
                    f"flashcards topic='{' -> '.join(topic['topic_chain'])}'",
                    combined_card_prose,
                    [topic["content"]],
                )

            # Deduplicate by normalised question text — no API calls needed
            seen_questions: set[str] = set()
            deduplicated_cards = []
            for card in converted_cards:
                normalised_question = card["question"].strip().lower()
                if normalised_question not in seen_questions:
                    seen_questions.add(normalised_question)
                    deduplicated_cards.append(card)

            # Hard-trim to ±5 % of target (shuffle first so the trim is random)
            max_cards = math.ceil(target_count * 1.05)
            random.shuffle(deduplicated_cards)
            final_cards = deduplicated_cards[:max_cards]

            # ── 12. Persist ────────────────────────────────────────────────────
            topic_chain = topic["topic_chain"]
            safe_unit = sanitize_filename(topic_chain[0]) if topic_chain else "Uncategorised"
            safe_topic = sanitize_filename(topic_chain[-1]) if topic_chain else "Unknown"

            output = {
                "topicChain": topic_chain,
                "cards": final_cards,
                "sourcePages": topic["source_pages"],
                "totalCards": len(final_cards),
                "generatedAt": datetime.now(timezone.utc).isoformat(),
            }

            file_path = join_path(
                "/",
                PersistenceConstants.TASKS_DIRECTORY,
                main_task_id,
                PersistenceConstants.FLASHCARDS_DIRECTORY,
                safe_unit,
                f"{safe_topic}.json",
            )

            await Persistence.write(file_path, json.dumps(output, ensure_ascii=False))

            # ── 13. Report progress ────────────────────────────────────────────
            await TaskManager.increment_completion(parent_task_id, topic["weight"])

            print(f"[OK] {' -> '.join(topic_chain)} — {len(final_cards)} card(s) written (target {target_count}, deduped from {len(converted_cards)}).") 

        # ── 14. Handle thin topic batches (single-model BatchSubmitter) ───────
        if thin_topic_batches:
            thin_batch_model_string, _ = ModelPool.FLASHCARD_AUTO_MODEL
            thin_batch_validator       = build_thin_batch_validator(all_question_type_names, all_difficulty_names)

            thin_submitter        = BatchSubmitter(thin_batch_model_string, main_task = main_task)
            thin_validators_by_key = {}
            thin_batch_entries     = []

            for thin_batch_index, batch in enumerate(thin_topic_batches):
                topic_blocks = "\n\n".join(
                    f"Topic: {' -> '.join(topic['topic_chain'])}\n{topic['content']}"
                    for topic in batch
                )

                batch_weight = sum(topic["weight"] for topic in batch)

                user_prompt = (
                    PromptPool.FLASHCARD_GENERATION_THIN_BATCH_USER
                    .replace("{topic_blocks}", topic_blocks)
                    .replace("{subject}", subject_name)
                    .replace("{exam_context}", exam_context)
                    .replace("{mark_for_review_instruction}", "Mark appropriate cards for review." if b_mark_for_review else "Do not mark any cards for review. Set markedForReview to false for all cards.")
                    .replace("{additional_instructions_block}", additional_instructions_block)
                )

                thin_request = AutomationRequest(
                    thin_batch_model_string,
                    [
                        AutomationContent(AutomationContentTypes.SYSTEM, system_prompt),
                        AutomationContent(AutomationContentTypes.TEXT, user_prompt),
                    ]
                )

                thin_key = f"thin-batch-{thin_batch_index}"
                thin_submitter.enqueue(thin_key, thin_request)
                thin_validators_by_key[thin_key] = thin_batch_validator
                thin_batch_entries.append({
                    "key":          thin_key,
                    "batch_weight": batch_weight,
                })

            # Grant the submit-time share of each thin batch's weight up front so
            # the parent bar moves when the batch is dispatched rather than only
            # when Gemini returns it. The remaining share lands per entry below.
            for entry in thin_batch_entries:
                await TaskManager.increment_completion(parent_task_id, BatchSubmitter.SUBMIT_PROGRESS_SHARE * entry["batch_weight"])

            thin_results = await live_fallback_caller.call_batch(
                thin_submitter,
                live_fallback_caller = live_fallback_caller,
                validators           = thin_validators_by_key,
            )

            for entry in thin_batch_entries:
                response = thin_results.get(entry["key"])

                if response is None:
                    print(f"[WARN] Thin batch '{entry['key']}' failed after all retries — skipping.")
                    await TaskManager.increment_completion(parent_task_id, (1.0 - BatchSubmitter.SUBMIT_PROGRESS_SHARE) * entry["batch_weight"])
                    continue

                try:
                    data   = response.get_output().get_data()
                    parsed = strip_json_markdown(data) if isinstance(data, str) else data
                except Exception:
                    print(f"[WARN] Failed to parse thin batch response — skipping.")
                    await TaskManager.increment_completion(parent_task_id, (1.0 - BatchSubmitter.SUBMIT_PROGRESS_SHARE) * entry["batch_weight"])
                    continue

                for topic_entry in parsed:
                    topic_chain = topic_entry["topicChain"]
                    raw_cards   = topic_entry["cards"]

                    converted_cards = convert_raw_cards(raw_cards)
                    random.shuffle(converted_cards)

                    safe_unit  = sanitize_filename(topic_chain[0]) if topic_chain else "Uncategorised"
                    safe_topic = sanitize_filename(topic_chain[-1]) if topic_chain else "Unknown"

                    output = {
                        "topicChain":  topic_chain,
                        "cards":       converted_cards,
                        "sourcePages": source_pages_by_topic_chain.get(" -> ".join(topic_chain), []),
                        "totalCards":  len(converted_cards),
                        "generatedAt": datetime.now(timezone.utc).isoformat(),
                    }

                    file_path = join_path(
                        "/",
                        PersistenceConstants.TASKS_DIRECTORY,
                        main_task_id,
                        PersistenceConstants.FLASHCARDS_DIRECTORY,
                        safe_unit,
                        f"{safe_topic}.json",
                    )

                    await Persistence.write(file_path, json.dumps(output, ensure_ascii=False))
                    print(f"[OK] {' -> '.join(topic_chain)} — {len(converted_cards)} card(s) written (thin).")

                await TaskManager.increment_completion(parent_task_id, (1.0 - BatchSubmitter.SUBMIT_PROGRESS_SHARE) * entry["batch_weight"])