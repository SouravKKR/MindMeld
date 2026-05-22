import asyncio
import json
import os
from datetime import datetime, timezone
from typing import Any

from Workflows.Workflow import Workflow
from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.Providers.GeminiProvider import GeminiProvider
from Globals.Classes.Database.DatabaseConnector import DatabaseConnector
from Globals.Classes.Task.TaskDescriptor import TaskDescriptor
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Constants.DatabaseConstants import DatabaseConstants
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Enumerations.TaskExecutionTargets import TaskExecutionTargets
from Globals.Enumerations.TaskTypes import TaskTypes
from Globals.Enumerations.TopicStrength import TopicStrength
from Globals.Utility.StripJsonMarkdown import strip_json_markdown


class AnalyzeDeckPerformance(Workflow):
    """
    Weekly per-deck performance analysis. Reads cards + progress points
    from Mongo for the deck (and all its descendants), scores each card
    on three axes — weakness (FSRS r30 + Glicko confidence), strength
    (the same metric inverted), and volatility (high Glicko RD AND
    mixed recent correctness) — then asks Gemini 2.5-flash-lite to
    distil the top-8 cards in each tier into up-to-3 conceptual topics
    per tier, every topic stamped with the TopicStrength enum.

    The flat result lands on the deck's additionalData and, when
    curated study is also enabled, spawns one child task per WEAK
    topic (max 3). Volatile and strong topics are stored + displayed
    but do not generate study materials — the gap the user needs to
    close lives in the WEAK tier.
    """

    MODEL_NAME                                = "gemini-2.5-flash-lite"
    TOP_CARDS_PER_TIER                        = 8
    TOP_TOPICS_PER_TIER                       = 3
    MIN_PROGRESS_POINTS_FOR_CARD_ELIGIBILITY  = 1
    MIN_PROGRESS_POINTS_FOR_VOLATILITY        = 3
    VOLATILITY_RECENT_CORRECTNESS_WINDOW      = 5
    VOLATILITY_GLICKO_RD_THRESHOLD            = 150.0
    AUTO_PERFORMANCE_ANALYSIS_ENABLED_FIELD   = "autoPerformanceAnalysisEnabled"
    AUTO_GENERATE_CURATED_STUDY_ENABLED_FIELD = "autoGenerateCuratedStudyEnabled"
    LAST_ANALYZED_AT_FIELD                    = "lastAnalyzedAt"
    LAST_ANALYSIS_TOPICS_FIELD                = "lastAnalysisTopics"
    ROOT_DECK_ID                              = "0"

    SYSTEM_PROMPT = (
        "You are an expert tutor identifying conceptual study topics from flashcard performance data. "
        "Given three groups of flashcards — ones the student answered poorly (WEAK), ones they answered "
        "consistently well (STRONG), and ones they keep flipping on (VOLATILE) — infer the underlying "
        "conceptual topics. A topic may be the literal subject of the card OR a foundational concept the "
        "student is missing in order to answer it. Topics must be subject-level concepts (e.g. 'Limits of "
        "trigonometric functions', not 'Q3 from chapter 4'). Use the provided deck-context chain to keep "
        "topic names appropriate to the user's syllabus level.\n\n"
        "Return STRICT compact JSON with exactly one key 'topics' — an array of objects with "
        "'name' (string), 'strength' (one of 'WEAK', 'STRONG', 'VOLATILE'), and 'reason' (one short "
        "sentence explaining the classification). Use thresholds: return at most 3 entries per strength "
        "tier, and return fewer if the card evidence does not justify a full tier (e.g. zero VOLATILE "
        "if no cards show a real confusion pattern). No prose outside the JSON."
    )

    def __init__(self, payload: dict = {}):
        super().__init__(payload)
        self.__deck_id                     = payload.get("deckId", "")
        self.__auto_generate_curated_study = bool(payload.get("autoGenerateCuratedStudy", False))

    async def run(self, args: dict = {}):
        if not self.__deck_id:
            print("[AnalyzeDeckPerformance] No deckId in payload — exiting.")
            return

        database = await DatabaseConnector.get_database()
        if database is None:
            print("[AnalyzeDeckPerformance] No database connection — exiting.")
            return

        deck_collection = database[DatabaseConstants.DECKS_COLLECTION]
        card_collection = database[DatabaseConstants.CARDS_COLLECTION]

        root_deck = await asyncio.to_thread(deck_collection.find_one, {"id": self.__deck_id}, {"_id": 0})
        if root_deck is None:
            print(f"[AnalyzeDeckPerformance] Deck {self.__deck_id} not found — exiting.")
            return

        user_id = root_deck.get("userId", "")
        if not user_id:
            print(f"[AnalyzeDeckPerformance] Deck {self.__deck_id} has no userId — exiting.")
            return

        # Re-check the opt-in flag server-side so a stale client request
        # cannot drive an LLM call after the user has un-checked the toggle.
        additional_data = root_deck.get("additionalData") or {}
        if additional_data.get(AnalyzeDeckPerformance.AUTO_PERFORMANCE_ANALYSIS_ENABLED_FIELD) is not True:
            print(f"[AnalyzeDeckPerformance] Deck {self.__deck_id} no longer opted in — exiting.")
            return

        descendant_deck_ids = await self.__collect_descendant_deck_ids(deck_collection, user_id, self.__deck_id)
        deck_ids_in_scope = [self.__deck_id, *descendant_deck_ids]

        scored_cards = await self.__score_cards_for_decks(card_collection, user_id, deck_ids_in_scope)
        if not scored_cards:
            print(f"[AnalyzeDeckPerformance] No studied cards found under deck {self.__deck_id} — exiting.")
            return

        weakest = sorted(scored_cards, key=lambda entry: entry["weaknessScore"], reverse=True)[: AnalyzeDeckPerformance.TOP_CARDS_PER_TIER]
        strongest = sorted(scored_cards, key=lambda entry: entry["weaknessScore"])[: AnalyzeDeckPerformance.TOP_CARDS_PER_TIER]
        volatile = sorted(
            (card for card in scored_cards if card["volatilityScore"] > 0.0),
            key=lambda entry: entry["volatilityScore"],
            reverse=True,
        )[: AnalyzeDeckPerformance.TOP_CARDS_PER_TIER]

        deck_chain = await self.__build_deck_chain(deck_collection, user_id, self.__deck_id)

        topics = await self.__ask_gemini_for_topics(weakest, strongest, volatile, deck_chain)
        if topics is None:
            print(f"[AnalyzeDeckPerformance] LLM returned no usable topics for deck {self.__deck_id}.")
            return

        generated_at = datetime.now(timezone.utc).isoformat()
        analysis_summary = {
            "topics":      topics,
            "deckChain":   deck_chain,
            "generatedAt": generated_at,
        }

        await asyncio.to_thread(
            deck_collection.update_one,
            {"id": self.__deck_id},
            {"$set":
            {
                f"additionalData.{AnalyzeDeckPerformance.LAST_ANALYSIS_TOPICS_FIELD}": analysis_summary,
                f"additionalData.{AnalyzeDeckPerformance.LAST_ANALYZED_AT_FIELD}":     generated_at,
                "lifecycle.lastModified":                                              datetime.now(timezone.utc),
            }}
        )

        tier_counts = {
            "WEAK":     sum(1 for entry in topics if entry["strength"] == TopicStrength.WEAK.name),
            "STRONG":   sum(1 for entry in topics if entry["strength"] == TopicStrength.STRONG.name),
            "VOLATILE": sum(1 for entry in topics if entry["strength"] == TopicStrength.VOLATILE.name),
        }
        print(f"[AnalyzeDeckPerformance] Stored analysis for deck {self.__deck_id}: {tier_counts['WEAK']} weak / {tier_counts['STRONG']} strong / {tier_counts['VOLATILE']} volatile topic(s).")

        if self.__auto_generate_curated_study and additional_data.get(AnalyzeDeckPerformance.AUTO_GENERATE_CURATED_STUDY_ENABLED_FIELD) is True:
            weak_topics = [entry for entry in topics if entry["strength"] == TopicStrength.WEAK.name]
            await self.__spawn_curated_study_children(user_id, weak_topics, deck_chain)

        current_task = await TaskManager.get_current_task()
        if current_task is not None:
            current_task.set_completion(1.0)
            await TaskManager.set_task(current_task)

    async def __collect_descendant_deck_ids(self, deck_collection, user_id: str, root_deck_id: str) -> list[str]:
        descendant_ids: list[str] = []
        frontier: list[str]       = [root_deck_id]
        visited: set[str]         = {root_deck_id}

        while frontier:
            next_frontier: list[str] = []
            for parent_id in frontier:
                children = await asyncio.to_thread(
                    list,
                    deck_collection.find(
                        {"userId": user_id, "parent": parent_id},
                        {"_id": 0, "id": 1},
                    ),
                )

                for child in children:
                    child_id = child.get("id")
                    if child_id and child_id not in visited:
                        visited.add(child_id)
                        descendant_ids.append(child_id)
                        next_frontier.append(child_id)

            frontier = next_frontier

        return descendant_ids

    async def __build_deck_chain(self, deck_collection, user_id: str, leaf_deck_id: str) -> list[str]:
        """
        Walks from leaf_deck_id up to (but excluding) the root deck and returns
        the ordered list of deck names from outermost ancestor to leaf. Root is
        omitted because every deck shares it — including it adds no signal.
        """
        chain_names: list[str] = []
        visited_ids: set[str] = set()
        current_deck_id: str = leaf_deck_id

        while current_deck_id and current_deck_id not in visited_ids and current_deck_id != AnalyzeDeckPerformance.ROOT_DECK_ID:
            visited_ids.add(current_deck_id)
            current_doc = await asyncio.to_thread(
                deck_collection.find_one,
                {"userId": user_id, "id": current_deck_id},
                {"_id": 0, "id": 1, "parent": 1, "name": 1},
            )
            if current_doc is None:
                break

            deck_name = current_doc.get("name") or ""
            if deck_name:
                chain_names.insert(0, deck_name)

            current_deck_id = current_doc.get("parent") or ""

        return chain_names

    async def __score_cards_for_decks(self, card_collection, user_id: str, deck_ids: list[str]) -> list[dict]:
        if not deck_ids:
            return []

        cards = await asyncio.to_thread(
            list,
            card_collection.find(
                {"userId": user_id, "deckId": {"$in": deck_ids}},
                {"_id": 0},
            ),
        )

        scored: list[dict] = []

        for card in cards:
            progress_block = card.get("progress") or {}
            progress_points = progress_block.get("progressPoints") or []

            if len(progress_points) < AnalyzeDeckPerformance.MIN_PROGRESS_POINTS_FOR_CARD_ELIGIBILITY:
                continue

            latest_point   = progress_points[-1]
            fsrs_state     = latest_point.get("fsrs") or {}
            glicko_state   = latest_point.get("glicko") or {}

            stability = AnalyzeDeckPerformance.__coerce_float(fsrs_state.get("stability"), default=0.1)
            r30_value = AnalyzeDeckPerformance.__compute_r30(stability)

            rating_deviation = AnalyzeDeckPerformance.__coerce_float(glicko_state.get("ratingDeviation"), default=350.0)
            confidence_factor = max(0.0, min(1.0, 1.0 - (rating_deviation / 350.0)))

            current_rating = AnalyzeDeckPerformance.__coerce_float(glicko_state.get("rating"), default=1500.0)
            base_difficulty = AnalyzeDeckPerformance.__coerce_float(card.get("baseDifficulty"), default=1500.0)
            rating_deficit = max(0.0, base_difficulty - current_rating)
            rating_deficit_signal = min(1.0, rating_deficit / 500.0)

            total_attempts = len(progress_points)

            weakness_score = (1.0 - r30_value) * (0.5 + 0.5 * confidence_factor) + rating_deficit_signal * 0.5

            correctness_history = AnalyzeDeckPerformance.__compute_correctness_history(progress_points)
            volatility_score = AnalyzeDeckPerformance.__compute_volatility_score(correctness_history, rating_deviation, total_attempts)

            scored.append({
                "id":               card.get("id"),
                "question":         AnalyzeDeckPerformance.__strip_html(card.get("question") or ""),
                "answer":           AnalyzeDeckPerformance.__strip_html(card.get("answer") or ""),
                "weaknessScore":    weakness_score,
                "volatilityScore":  volatility_score,
                "r30":              r30_value,
                "rating":           current_rating,
                "ratingDeviation":  rating_deviation,
                "totalAttempts":    total_attempts,
            })

        return scored

    @staticmethod
    def __compute_correctness_history(progress_points: list[dict]) -> list[bool]:
        """
        Reconstructs the per-attempt correctness sequence from the lapses
        counter on each progress point. A lapse (FSRS grade 1) is the only
        signal that increments lapses, so a flat lapses delta between
        consecutive points means the attempt was correct (grade ≥ 2).
        """
        correctness: list[bool] = []
        previous_lapses_count = 0
        for progress_point in progress_points:
            fsrs_state = progress_point.get("fsrs") or {}
            current_lapses_count = int(AnalyzeDeckPerformance.__coerce_float(fsrs_state.get("lapses"), default=0.0))
            was_correct = (current_lapses_count == previous_lapses_count)
            correctness.append(was_correct)
            previous_lapses_count = current_lapses_count
        return correctness

    @staticmethod
    def __compute_volatility_score(correctness_history: list[bool], rating_deviation: float, total_attempts: int) -> float:
        """
        A card is volatile when the user keeps flipping between knowing
        and not knowing it. Two signals must coincide:
          (1) Glicko rating-deviation is still high — the rating engine
              itself is uncertain about this card's true difficulty for
              this user.
          (2) The user's recent answer stream contains both correct and
              incorrect answers (a "swing" pattern, not steady progress).
        Either signal alone is too noisy (high RD also means "too few
        reps"; mixed correctness alone matches "just learning"). The
        product of the two captures genuine confusion.
        """
        if total_attempts < AnalyzeDeckPerformance.MIN_PROGRESS_POINTS_FOR_VOLATILITY:
            return 0.0

        if rating_deviation < AnalyzeDeckPerformance.VOLATILITY_GLICKO_RD_THRESHOLD:
            return 0.0

        recent_window = correctness_history[-AnalyzeDeckPerformance.VOLATILITY_RECENT_CORRECTNESS_WINDOW :]
        if len(set(recent_window)) < 2:
            return 0.0

        swing_count = 0
        for index in range(1, len(recent_window)):
            if recent_window[index] != recent_window[index - 1]:
                swing_count += 1

        mixed_factor = swing_count / max(1, len(recent_window) - 1)
        return rating_deviation * mixed_factor

    @staticmethod
    def __coerce_float(value: Any, default: float) -> float:
        try:
            if value is None:
                return default
            numeric = float(value)
            if numeric != numeric:
                return default
            return numeric
        except (TypeError, ValueError):
            return default

    @staticmethod
    def __compute_r30(stability: float) -> float:
        effective_stability = max(stability, 0.1)
        return 1.0 / (1.0 + 30.0 / (9.0 * effective_stability))

    @staticmethod
    def __strip_html(html_text: str) -> str:
        import re
        without_tags = re.sub(r"<[^>]+>", " ", html_text)
        return re.sub(r"\s+", " ", without_tags).strip()[:240]

    @staticmethod
    def __format_card_block(label: str, cards: list[dict]) -> str:
        if not cards:
            return f"{label}: (no cards in this tier)"

        lines = [f"{label}:"]
        for card in cards:
            lines.append(
                f"- (r30={card['r30']:.2f}, rating={card['rating']:.0f}, rd={card['ratingDeviation']:.0f}) "
                f"Q: {card['question']} | A: {card['answer']}"
            )
        return "\n".join(lines)

    async def __ask_gemini_for_topics(self, weakest_cards: list[dict], strongest_cards: list[dict], volatile_cards: list[dict], deck_chain: list[str]) -> list[dict] | None:
        deck_context_line = (
            f"Deck context (root → leaf, root omitted): {' → '.join(deck_chain)}"
            if deck_chain
            else "Deck context: (top-level deck, no parent chain)"
        )

        user_prompt = (
            f"{deck_context_line}\n\n"
            f"{AnalyzeDeckPerformance.__format_card_block('WEAK — lowest retention / lowest win rate', weakest_cards)}\n\n"
            f"{AnalyzeDeckPerformance.__format_card_block('STRONG — highest retention / steady wins', strongest_cards)}\n\n"
            f"{AnalyzeDeckPerformance.__format_card_block('VOLATILE — user keeps flipping (high Glicko RD + mixed recent correctness)', volatile_cards)}\n\n"
            "Identify up to 3 conceptual topics per tier. A weak topic may be a foundational gap rather "
            "than the literal card subject — name what the student is missing. Skip a tier entirely if "
            "the cards do not justify it. Return JSON only."
        )

        request = AutomationRequest(
            AnalyzeDeckPerformance.MODEL_NAME,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, AnalyzeDeckPerformance.SYSTEM_PROMPT),
                AutomationContent(AutomationContentTypes.TEXT,   user_prompt),
            ]
        )

        caller = AutomationCaller(GeminiProvider())
        response = await caller.call(request, None, retries=2)

        if response is None:
            return None

        try:
            raw_output = response.get_output().get_data()
            parsed = strip_json_markdown(raw_output) if isinstance(raw_output, str) else raw_output
            if not isinstance(parsed, dict):
                return None

            raw_topics = parsed.get("topics") if isinstance(parsed.get("topics"), list) else []
            return AnalyzeDeckPerformance.__sanitize_topic_entries(raw_topics)
        except Exception as parse_error:
            print(f"[AnalyzeDeckPerformance] Failed to parse LLM JSON: {parse_error}")
            return None

    @staticmethod
    def __sanitize_topic_entries(raw_entries: list) -> list[dict]:
        """
        Validates each LLM topic entry and stamps it with the canonical
        TopicStrength enum name. Unknown strength values are dropped so
        downstream consumers can rely on the field being one of WEAK /
        STRONG / VOLATILE.
        """
        valid_strength_names = {member.name for member in TopicStrength}
        per_tier_caps = {member.name: AnalyzeDeckPerformance.TOP_TOPICS_PER_TIER for member in TopicStrength}
        per_tier_counts: dict[str, int] = {member.name: 0 for member in TopicStrength}

        sanitized: list[dict] = []
        for entry in raw_entries:
            if not isinstance(entry, dict):
                continue

            name_value = entry.get("name")
            if not isinstance(name_value, str) or not name_value.strip():
                continue

            strength_value = entry.get("strength")
            if not isinstance(strength_value, str):
                continue

            normalized_strength = strength_value.strip().upper()
            if normalized_strength not in valid_strength_names:
                continue

            if per_tier_counts[normalized_strength] >= per_tier_caps[normalized_strength]:
                continue

            reason_value = entry.get("reason")
            sanitized.append({
                "name":     name_value.strip()[:120],
                "strength": normalized_strength,
                "reason":   (reason_value.strip()[:240] if isinstance(reason_value, str) else ""),
            })
            per_tier_counts[normalized_strength] += 1

        return sanitized

    async def __spawn_curated_study_children(self, user_id: str, weak_topics: list[dict], deck_chain: list[str]) -> None:
        if not weak_topics:
            return

        current_task = await TaskManager.get_current_task()
        if current_task is None:
            return

        spawned_task_ids: list[str] = []

        for weakness_index, topic_entry in enumerate(weak_topics[: AnalyzeDeckPerformance.TOP_TOPICS_PER_TIER]):
            topic_name = topic_entry.get("name", "")
            if not topic_name:
                continue

            curated_task = TaskDescriptor(
                type=TaskTypes.GENERATE_CURATED_STUDY_MATERIAL,
                execution_target=TaskExecutionTargets.LOCAL,
                user_id=user_id,
                payload={
                    "deckId":         self.__deck_id,
                    "userId":         user_id,
                    "topicName":      topic_name,
                    "weaknessIndex":  weakness_index,
                    "reason":         topic_entry.get("reason", ""),
                    "deckChain":      deck_chain,
                },
                next_task_ids=[],
                parent_task_id=current_task.get_id(),
            )

            await TaskManager.set_task(curated_task)
            spawned_task_ids.append(curated_task.get_id())

        if spawned_task_ids:
            current_task.set_next_task_ids(spawned_task_ids)
            await TaskManager.set_task(current_task)
            print(f"[AnalyzeDeckPerformance] Spawned {len(spawned_task_ids)} curated study child task(s).")
