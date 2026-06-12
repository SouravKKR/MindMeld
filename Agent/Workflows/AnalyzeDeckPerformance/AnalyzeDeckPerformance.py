import asyncio
import json
import os
import re
from datetime import datetime, timezone
from typing import Any

from Workflows.Workflow import Workflow
from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Analysis.AutoAnalysisDeckFields import AutoAnalysisDeckFields
from Globals.Classes.Analysis.CuratedFlashcardFields import CuratedFlashcardFields
from Globals.Classes.Analysis.CuratedStudyMaterialFields import CuratedStudyMaterialFields
from Globals.Classes.Automation.Providers.GeminiProvider import GeminiProvider
from Globals.Classes.Database.DatabaseConnector import DatabaseConnector
from Globals.Classes.Task.TaskDescriptor import TaskDescriptor
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Constants.DatabaseConstants import DatabaseConstants
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Enumerations.CuratedBatchReviewStates import CuratedBatchReviewStates
from Globals.Enumerations.CuratedSessionOutcomes import CuratedSessionOutcomes
from Globals.Enumerations.CuratedFlashcardGrade import CuratedFlashcardGrade
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
    TOP_TOPICS_PER_TIER                       = 5
    # The user's actual study evidence lives in `progress.progressPoints`
    # — a ring buffer that grows by one entry every time `Card.attempt`
    # runs. A single attempt is enough to count as evidence; we treat
    # 0-point cards as "never studied" and skip them. The FSRS engine
    # provides per-point stability + Glicko RD downstream in the
    # weakness / volatility scoring formulae, so we don't need a
    # separate stability floor at the eligibility stage.
    MIN_PROGRESS_POINTS_FOR_CARD_ELIGIBILITY  = 1
    MIN_PROGRESS_POINTS_FOR_VOLATILITY        = 3
    VOLATILITY_RECENT_CORRECTNESS_WINDOW      = 5
    VOLATILITY_GLICKO_RD_THRESHOLD            = 150.0
    # Per-topic cap on the source-card list carried through the curated
    # pipeline. The LLM can name up to this many tokens per topic; the
    # frontend's grade-back applies a positive review to each. Capped
    # so a runaway LLM response can't dump dozens of cards onto a
    # single topic.
    MAX_SOURCE_CARDS_PER_TOPIC                = 8
    ROOT_DECK_ID                              = "0"

    # Glicko2 reference values used when a card has no recorded rating yet.
    # GLICKO_MAX_RATING_DEVIATION doubles as the denominator that normalises a
    # card's rating deviation into a 0..1 confidence factor.
    GLICKO_MAX_RATING_DEVIATION = 350.0
    GLICKO_DEFAULT_RATING = 1500.0
    # Rating points below base difficulty at which the deficit signal saturates.
    RATING_DEFICIT_NORMALIZER = 500.0
    # Character caps applied to LLM-facing / persisted text fragments.
    MAX_CARD_TEXT_LENGTH = 240
    MAX_TOPIC_NAME_LENGTH = 120

    SYSTEM_PROMPT = (
        "You are an expert tutor identifying conceptual study topics from flashcard performance data. "
        "Given three groups of flashcards — ones the student answered poorly (WEAK), ones they answered "
        "consistently well (STRONG), and ones they keep flipping on (VOLATILE) — infer the underlying "
        "conceptual topics. A topic may be the literal subject of the card OR a foundational concept the "
        "student is missing in order to answer it. Topics must be subject-level concepts (e.g. 'Limits of "
        "trigonometric functions', not 'Q3 from chapter 4'). Use the provided deck-context chain to keep "
        "topic names appropriate to the user's syllabus level.\n\n"
        "Each card you receive is prefixed with an index token like [W1], [W2], [S1], [V1], etc. — 'W' "
        "for WEAK cards, 'S' for STRONG, 'V' for VOLATILE, numbered in the order shown. For every topic "
        "you identify, you MUST also list the index tokens of the cards that drove that topic into its "
        "tier under a 'sourceCardIndices' array. List between one and " + str(MAX_SOURCE_CARDS_PER_TOPIC) + " tokens per topic; only use "
        "tokens that actually appear in the lists you were shown. The student's downstream pipeline uses "
        "these tokens to mark the corresponding cards as recently studied — getting them right is more "
        "important than naming extra topics.\n\n"
        "Return STRICT compact JSON with exactly one key 'topics' — an array of objects with "
        "'name' (string), 'strength' (one of 'WEAK', 'STRONG', 'VOLATILE'), 'reason' (one short "
        "sentence explaining the classification), and 'sourceCardIndices' (array of card index tokens). "
        "Return only a small handful of entries per strength tier — fewer is better when the card "
        "evidence is thin, and skip a tier entirely if it is not supported (e.g. zero VOLATILE when no "
        "card shows a real confusion pattern). No prose outside the JSON."
    )

    def __init__(self, payload: dict = {}):
        super().__init__(payload)
        self.__deck_id                     = payload.get("deckId", "")
        self.__auto_generate_curated_study = bool(payload.get("autoGenerateCuratedStudy", False))
        # `force` lets the entry-dialog Regenerate button and the
        # mid-session feedback regen bypass the LIVE-batch engagement
        # check. Used together with skipAnalysis + regenerateTopics for
        # the COMPLETED_ALL_EASY auto-queue and the Continue branch so
        # the LLM topic-detection pass is skipped and the caller-supplied
        # topic list drives generation directly.
        self.__force                       = bool(payload.get("force", False))
        self.__skip_analysis               = bool(payload.get("skipAnalysis", False))
        self.__regenerate_topics           = payload.get("regenerateTopics") or []
        # Paid-source pass-through. Paid decks now live in the normal
        # decks/cards/studyMaterials sync collections (plaintext server-side),
        # tagged with additionalData.paidDeckId. The agent reads and writes
        # them through the SAME normal sync path as non-paid decks; the only
        # paid-specific behaviour is stamping this id onto every generated
        # StudyMaterial + curated card so the /Sync pull encrypts them for the
        # buyer. It is therefore used ONLY as an output tag, never for reads.
        self.__paid_deck_id                = payload.get("paidDeckId", "") or ""

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

        # Sync-collection docs are wrapped as {userId, data: {<entity>},
        # serverUpdatedAt} — see Dock/Globals/Classes/Database/
        # SyncQueryEngine.bulkUpsert. Every field selector and field
        # access on a deck / card doc therefore goes through `data.*`.
        # Paid decks live in these same collections (plaintext), so this is
        # the read/write path for paid and non-paid decks alike.
        root_deck = await asyncio.to_thread(deck_collection.find_one, {"data.id": self.__deck_id}, {"_id": 0})
        if root_deck is None:
            print(f"[AnalyzeDeckPerformance] Deck {self.__deck_id} not found — exiting.")
            return

        user_id = root_deck.get("userId", "")
        if not user_id:
            print(f"[AnalyzeDeckPerformance] Deck {self.__deck_id} has no userId — exiting.")
            return

        root_deck_data = root_deck.get("data") or {}

        # Re-check the opt-in flag server-side so a stale client request
        # cannot drive an LLM call after the user has un-checked the toggle.
        # Manual Regenerate (`force=True`) bypasses this gate — the
        # autoPerformanceAnalysisEnabled flag governs UNATTENDED behavior
        # only; an explicit user click is an explicit override.
        additional_data = root_deck_data.get("additionalData") or {}
        if not self.__force and additional_data.get(AutoAnalysisDeckFields.AUTO_PERFORMANCE_ANALYSIS_ENABLED) is not True:
            print(f"[AnalyzeDeckPerformance] Deck {self.__deck_id} no longer opted in — exiting.")
            return

        descendant_deck_ids = await self.__collect_descendant_deck_ids(deck_collection, user_id, self.__deck_id)
        deck_ids_in_scope = [self.__deck_id, *descendant_deck_ids]

        # LIVE-batch detection. Three forks:
        #   1) force=False — if the user has already graded at least one
        #      flashcard in the current LIVE batch, bail out entirely so
        #      we don't churn lastAnalysisTopics underneath an active
        #      session. If the batch is untouched, supersede it
        #      (AUTO_REPLACED) and continue with a fresh generation.
        #   2) force=True AND skipAnalysis=False — manual Regenerate
        #      from the entry dialog. Archive the LIVE batch
        #      (REPLACED_BY_REGEN) and re-analyse from scratch.
        #   3) force=True AND skipAnalysis=True — Continue branch from a
        #      mixed-results session, OR the COMPLETED_ALL_EASY
        #      auto-queue. In both cases the frontend has already
        #      managed per-topic archival; the agent must NOT touch the
        #      LIVE batch (only-hard-topic case leaves other topics
        #      LIVE under the same batch tag, all-easy-auto case has
        #      already cleared LAST_CURATED_BATCH_TAG before queueing).
        current_batch_tag = additional_data.get(AutoAnalysisDeckFields.LAST_CURATED_BATCH_TAG)

        if current_batch_tag and not self.__force:
            user_has_engaged = await self.__has_user_engaged_with_batch(card_collection, user_id, deck_ids_in_scope, current_batch_tag)
            if user_has_engaged:
                await self.__mark_skipped_due_to_in_progress(deck_collection)
                print(f"[AnalyzeDeckPerformance] Skipped — user has engaged with active batch {current_batch_tag} on deck {self.__deck_id}.")
                return
            await self.__demote_previous_batch(
                study_materials_collection=database[DatabaseConstants.STUDY_MATERIALS_COLLECTION],
                user_id=user_id,
                deck_ids_in_scope=deck_ids_in_scope,
                batch_tag=current_batch_tag,
                next_state=CuratedBatchReviewStates.SUPERSEDED.name,
                outcome=CuratedSessionOutcomes.AUTO_REPLACED.name,
            )
        elif current_batch_tag and self.__force and not self.__skip_analysis:
            await self.__demote_previous_batch(
                study_materials_collection=database[DatabaseConstants.STUDY_MATERIALS_COLLECTION],
                user_id=user_id,
                deck_ids_in_scope=deck_ids_in_scope,
                batch_tag=current_batch_tag,
                next_state=CuratedBatchReviewStates.ARCHIVED.name,
                outcome=CuratedSessionOutcomes.REPLACED_BY_REGEN.name,
            )

        # Diagnostic — surface the tree walk so a quiet "no cards" exit
        # below isn't a black box. Logs the deck scope size + first few
        # ids; on light decks the truncation is a no-op.
        preview_deck_ids = deck_ids_in_scope[:6]
        print(f"[AnalyzeDeckPerformance] Scope userId={user_id} paidDeckId={self.__paid_deck_id} descendants={len(deck_ids_in_scope) - 1} totalDecks={len(deck_ids_in_scope)} sample={preview_deck_ids} force={self.__force} skipAnalysis={self.__skip_analysis}")

        deck_chain = await self.__build_deck_chain(deck_collection, user_id, self.__deck_id)

        if self.__skip_analysis:
            # Same-topics regen path. The caller already decided which
            # topics to refresh — typically the Continue branch's hard
            # topics, or the COMPLETED_ALL_EASY auto-queue's full topic
            # list. Skip scoring and the LLM; trust the payload.
            topics = self.__normalise_regenerate_topics(self.__regenerate_topics)
            if not topics:
                print(f"[AnalyzeDeckPerformance] skipAnalysis=True but regenerateTopics produced no valid entries — exiting.")
                return
            print(f"[AnalyzeDeckPerformance] skipAnalysis=True — using {len(topics)} caller-supplied topic(s); no LLM call.")
        else:
            total_card_count = await asyncio.to_thread(
                card_collection.count_documents,
                {
                    "userId": user_id,
                    "data.deckId": {"$in": deck_ids_in_scope},
                    "data.additionalData." + CuratedFlashcardFields.B_CURATED: {"$ne": True},
                },
            )
            print(f"[AnalyzeDeckPerformance] Card collection matched {total_card_count} non-curated document(s) for the deck scope.")

            scored_cards = await self.__score_cards_for_decks(card_collection, user_id, deck_ids_in_scope)
            print(f"[AnalyzeDeckPerformance] {len(scored_cards)} card(s) cleared the eligibility floor (progressPoints>={AnalyzeDeckPerformance.MIN_PROGRESS_POINTS_FOR_CARD_ELIGIBILITY}).")
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

            topics = await self.__ask_gemini_for_topics(weakest, strongest, volatile, deck_chain)
            if topics is None:
                print(f"[AnalyzeDeckPerformance] LLM returned no usable topics for deck {self.__deck_id}.")
                return

            # The Insights page reads lastAnalysisTopics and renders it
            # regardless of the curated pipeline outcome — write it
            # eagerly so the user always sees the latest topic snapshot
            # even when curated generation later skips due to no
            # weak/volatile topics.
            analysis_generated_at = datetime.now(timezone.utc).isoformat()
            analysis_summary = {
                "topics":      topics,
                "deckChain":   deck_chain,
                "generatedAt": analysis_generated_at,
            }
            await asyncio.to_thread(
                deck_collection.update_one,
                {"data.id": self.__deck_id},
                {"$set":
                {
                    f"data.additionalData.{AutoAnalysisDeckFields.LAST_ANALYSIS_TOPICS}": analysis_summary,
                    f"data.additionalData.{AutoAnalysisDeckFields.LAST_ANALYZED_AT}":     analysis_generated_at,
                    "data.lifecycle.lastModified":                                        datetime.now(timezone.utc),
                    "serverUpdatedAt":                                                    datetime.now(timezone.utc),
                }}
            )

            tier_counts = {
                TopicStrength.WEAK.name: sum(1 for entry in topics if entry["strength"] == TopicStrength.WEAK.name),
                TopicStrength.STRONG.name: sum(1 for entry in topics if entry["strength"] == TopicStrength.STRONG.name),
                TopicStrength.VOLATILE.name: sum(1 for entry in topics if entry["strength"] == TopicStrength.VOLATILE.name),
            }
            print(f"[AnalyzeDeckPerformance] Stored analysis for deck {self.__deck_id}: {tier_counts[TopicStrength.WEAK.name]} weak / {tier_counts[TopicStrength.STRONG.name]} strong / {tier_counts[TopicStrength.VOLATILE.name]} volatile topic(s).")

        spawnable_topics = [
            entry for entry in topics
            if entry["strength"] in (TopicStrength.WEAK.name, TopicStrength.VOLATILE.name)
        ]
        if not spawnable_topics:
            print(f"[AnalyzeDeckPerformance] No WEAK or VOLATILE topics — nothing to generate for deck {self.__deck_id}.")
            return

        # Two gates for curated child spawning:
        #   1) the payload flag — set by the client (the dispatcher
        #      reads the deck flag; manual Regenerate always sends true).
        #   2) the deck flag — opts the deck IN to unattended curated
        #      generation.
        # Manual Regenerate (`force=True`) is an explicit user click; it
        # overrides the deck-level opt-in the same way it overrides
        # autoPerformanceAnalysisEnabled above. Otherwise both gates
        # must agree before we burn LLM credits on children.
        curated_enabled_on_deck = additional_data.get(AutoAnalysisDeckFields.AUTO_GENERATE_CURATED_STUDY_ENABLED) is True
        curated_gate_satisfied = self.__auto_generate_curated_study and (curated_enabled_on_deck or self.__force)
        if not curated_gate_satisfied:
            print(f"[AnalyzeDeckPerformance] Curated generation not requested (payload={self.__auto_generate_curated_study} deck={curated_enabled_on_deck} force={self.__force}) — skipping child spawn.")
            return

        # Continue-branch reuses the same batch tag so newly generated
        # materials slot back into the LIVE set the user is mid-session
        # on. Every other path (auto-analysis, manual Regenerate,
        # COMPLETED_ALL_EASY auto-queue) starts a fresh batch with a new
        # tag — the frontend will already have cleared
        # LAST_CURATED_BATCH_TAG before queueing those.
        is_continue_branch = self.__skip_analysis and bool(current_batch_tag)
        generated_for_analysis_at = current_batch_tag if is_continue_branch else datetime.now(timezone.utc).isoformat()

        if not is_continue_branch:
            await self.__set_live_batch_tag(deck_collection, generated_for_analysis_at, spawnable_topics)

        await self.__spawn_curated_study_children(user_id, spawnable_topics, deck_chain, generated_for_analysis_at, self.__paid_deck_id, self.__deck_id)

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
                        {"userId": user_id, "data.parent": parent_id},
                        {"_id": 0, "data.id": 1},
                    ),
                )

                for child in children:
                    child_data = child.get("data") or {}
                    child_id   = child_data.get("id")
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
                {"userId": user_id, "data.id": current_deck_id},
                {"_id": 0, "data.id": 1, "data.parent": 1, "data.name": 1},
            )
            if current_doc is None:
                break

            current_doc_data = current_doc.get("data") or {}
            deck_name        = current_doc_data.get("name") or ""
            if deck_name:
                chain_names.insert(0, deck_name)

            current_deck_id = current_doc_data.get("parent") or ""

        return chain_names

    async def __score_cards_for_decks(self, card_collection, user_id: str, deck_ids: list[str]) -> list[dict]:
        if not deck_ids:
            return []

        # Exclude curated flashcards from the scoring pool. Curated cards
        # are generated by GenerateCuratedStudyMaterial as part of the
        # consolidation loop; their progress (lastCuratedGrade) belongs
        # to the curated session's own state machine, not the deck-wide
        # FSRS / Glicko signal. If they fed back into analysis we would
        # be scoring the user's mastery of their own generated content,
        # which would inflate weakness/volatility readings and lead to
        # runaway regen loops on hard topics.
        cards = await asyncio.to_thread(
            list,
            card_collection.find(
                {
                    "userId": user_id,
                    "data.deckId": {"$in": deck_ids},
                    "data.additionalData." + CuratedFlashcardFields.B_CURATED: {"$ne": True},
                },
                {"_id": 0},
            ),
        )
        # Card docs are wrapped {userId, data: <Card>, serverUpdatedAt}
        # by the sync layer — see SyncQueryEngine.bulkUpsert.
        card_data_list = [card.get("data") or {} for card in cards]

        scored: list[dict] = []
        diagnostic_counts = {"never_studied": 0, "kept": 0}

        for card_data in card_data_list:
            scored_entry = AnalyzeDeckPerformance.__score_single_card(card_data)
            if scored_entry is None:
                diagnostic_counts["never_studied"] += 1
                continue
            diagnostic_counts["kept"] += 1
            scored.append(scored_entry)

        print(f"[AnalyzeDeckPerformance] Eligibility breakdown — never_studied={diagnostic_counts['never_studied']}, kept={diagnostic_counts['kept']}")

        return scored

    @staticmethod
    def __score_single_card(card_data: dict) -> dict | None:
        """
        Scores one card's weakness + volatility from its progress points.
        Returns None when the card has no study evidence (empty progress).
        `card_data` is the inner Card JSON unwrapped from the sync `data`
        wrapper.
        """
        progress_block  = card_data.get("progress") or {}
        progress_points = progress_block.get("progressPoints") or []

        # Eligibility floor — the user must have attempted this card at least
        # once. Cards with an empty progress history have nothing to score off.
        if len(progress_points) < AnalyzeDeckPerformance.MIN_PROGRESS_POINTS_FOR_CARD_ELIGIBILITY:
            return None

        latest_point = progress_points[-1]
        fsrs_state   = latest_point.get("fsrs") or {}
        glicko_state = latest_point.get("glicko") or {}
        stability    = AnalyzeDeckPerformance.__coerce_float(fsrs_state.get("stability"), default=0.0)

        r30_value = AnalyzeDeckPerformance.__compute_r30(stability)

        rating_deviation = AnalyzeDeckPerformance.__coerce_float(glicko_state.get("ratingDeviation"), default=AnalyzeDeckPerformance.GLICKO_MAX_RATING_DEVIATION)
        confidence_factor = max(0.0, min(1.0, 1.0 - (rating_deviation / AnalyzeDeckPerformance.GLICKO_MAX_RATING_DEVIATION)))

        current_rating = AnalyzeDeckPerformance.__coerce_float(glicko_state.get("rating"), default=AnalyzeDeckPerformance.GLICKO_DEFAULT_RATING)
        base_difficulty = AnalyzeDeckPerformance.__coerce_float(card_data.get("baseDifficulty"), default=AnalyzeDeckPerformance.GLICKO_DEFAULT_RATING)
        rating_deficit = max(0.0, base_difficulty - current_rating)
        rating_deficit_signal = min(1.0, rating_deficit / AnalyzeDeckPerformance.RATING_DEFICIT_NORMALIZER)

        total_attempts = len(progress_points)

        weakness_score = (1.0 - r30_value) * (0.5 + 0.5 * confidence_factor) + rating_deficit_signal * 0.5

        correctness_history = AnalyzeDeckPerformance.__compute_correctness_history(progress_points)
        volatility_score = AnalyzeDeckPerformance.__compute_volatility_score(correctness_history, rating_deviation, total_attempts)

        return {
            "id":               card_data.get("id"),
            "question":         AnalyzeDeckPerformance.__strip_html(card_data.get("question") or ""),
            "answer":           AnalyzeDeckPerformance.__strip_html(card_data.get("answer") or ""),
            "weaknessScore":    weakness_score,
            "volatilityScore":  volatility_score,
            "r30":              r30_value,
            "rating":           current_rating,
            "ratingDeviation":  rating_deviation,
            "totalAttempts":    total_attempts,
        }

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
        without_tags = re.sub(r"<[^>]+>", " ", html_text)
        return re.sub(r"\s+", " ", without_tags).strip()[:AnalyzeDeckPerformance.MAX_CARD_TEXT_LENGTH]

    @staticmethod
    def __format_card_block(label: str, tier_prefix: str, cards: list[dict]) -> str:
        """
        Renders one tier of cards as a block of bullet lines suitable
        for embedding in the LLM user-prompt. Every card is prefixed
        with an index token (`[W1]`, `[S2]`, …) so the LLM can
        round-trip them in its `sourceCardIndices` answer. `tier_prefix`
        is the single-letter abbreviation for the tier ('W' for WEAK,
        'S' for STRONG, 'V' for VOLATILE).
        """
        if not cards:
            return f"{label}: (no cards in this tier)"

        lines = [f"{label}:"]
        for card_index, card in enumerate(cards):
            index_token = f"{tier_prefix}{card_index + 1}"
            lines.append(
                f"- [{index_token}] (r30={card['r30']:.2f}, rating={card['rating']:.0f}, rd={card['ratingDeviation']:.0f}) "
                f"Q: {card['question']} | A: {card['answer']}"
            )
        return "\n".join(lines)

    @staticmethod
    def __build_card_index_to_id_map(weakest_cards: list[dict], strongest_cards: list[dict], volatile_cards: list[dict]) -> dict[str, str]:
        """
        Pairs each card index token with its real card id. The LLM
        answers in tokens; the translator (`__translate_source_card_indices`)
        uses this map to swap them back into the actual ids the
        frontend / agent will write to Mongo.
        """
        index_to_id: dict[str, str] = {}
        for tier_prefix, cards in (("W", weakest_cards), ("S", strongest_cards), ("V", volatile_cards)):
            for card_index, card in enumerate(cards):
                card_id = card.get("id")
                if isinstance(card_id, str) and card_id:
                    index_to_id[f"{tier_prefix}{card_index + 1}"] = card_id
        return index_to_id

    @staticmethod
    def __translate_source_card_indices(sanitized_topics: list[dict], card_index_to_id: dict[str, str]) -> list[dict]:
        """
        Replaces the LLM's `sourceCardIndices` token list (e.g. ['W1',
        'W3']) on each topic with the canonical `sourceCardIds` list
        (actual card ids). Tokens that don't appear in the map are
        dropped silently — the LLM occasionally hallucinates an index
        token outside the supplied range, and we'd rather lose a few
        than corrupt the downstream grade-back.
        """
        translated: list[dict] = []
        for topic in sanitized_topics:
            raw_indices = topic.get("sourceCardIndices") or []
            resolved_ids: list[str] = []
            seen_ids: set[str] = set()
            for index_token in raw_indices:
                if not isinstance(index_token, str):
                    continue
                card_id = card_index_to_id.get(index_token)
                if card_id is None or card_id in seen_ids:
                    continue
                resolved_ids.append(card_id)
                seen_ids.add(card_id)
            new_topic = dict(topic)
            new_topic.pop("sourceCardIndices", None)
            new_topic["sourceCardIds"] = resolved_ids
            translated.append(new_topic)
        return translated

    async def __ask_gemini_for_topics(self, weakest_cards: list[dict], strongest_cards: list[dict], volatile_cards: list[dict], deck_chain: list[str]) -> list[dict] | None:
        deck_context_line = (
            f"Deck context (root → leaf, root omitted): {' → '.join(deck_chain)}"
            if deck_chain
            else "Deck context: (top-level deck, no parent chain)"
        )

        # Build the token→id map upfront so the same prefix scheme is
        # used both for prompt rendering and for translating the LLM's
        # `sourceCardIndices` back into real ids.
        card_index_to_id = AnalyzeDeckPerformance.__build_card_index_to_id_map(weakest_cards, strongest_cards, volatile_cards)

        user_prompt = (
            f"{deck_context_line}\n\n"
            f"{AnalyzeDeckPerformance.__format_card_block('WEAK — lowest retention / lowest win rate', 'W', weakest_cards)}\n\n"
            f"{AnalyzeDeckPerformance.__format_card_block('STRONG — highest retention / steady wins', 'S', strongest_cards)}\n\n"
            f"{AnalyzeDeckPerformance.__format_card_block('VOLATILE — user keeps flipping (high Glicko RD + mixed recent correctness)', 'V', volatile_cards)}\n\n"
            "Identify a small number of conceptual topics per tier. A weak topic may be a foundational gap "
            "rather than the literal card subject — name what the student is missing. For every topic, "
            "list the index tokens (e.g. ['W1', 'W3']) of the cards above that drove the topic into its "
            "tier under 'sourceCardIndices'. Skip a tier entirely if the cards do not justify it. Return "
            "JSON only."
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
            sanitized = AnalyzeDeckPerformance.__sanitize_topic_entries(raw_topics)
            return AnalyzeDeckPerformance.__translate_source_card_indices(sanitized, card_index_to_id)
        except Exception as parse_error:
            print(f"[AnalyzeDeckPerformance] Failed to parse LLM JSON: {parse_error}")
            return None

    # Index-token validator. Matches the prefix scheme used by
    # __format_card_block and __build_card_index_to_id_map.
    __INDEX_TOKEN_PATTERN = re.compile(r"^[WSV]\d+$")

    @staticmethod
    def __sanitize_topic_entries(raw_entries: list) -> list[dict]:
        """
        Validates each LLM topic entry and stamps it with the canonical
        TopicStrength enum name. Unknown strength values are dropped so
        downstream consumers can rely on the field being one of WEAK /
        STRONG / VOLATILE. Also validates the LLM-supplied
        `sourceCardIndices` list — only tokens matching the prefix
        scheme survive, deduped + clamped at MAX_SOURCE_CARDS_PER_TOPIC.
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

            raw_indices_value = entry.get("sourceCardIndices")
            cleaned_indices: list[str] = []
            seen_indices: set[str] = set()
            if isinstance(raw_indices_value, list):
                for raw_index in raw_indices_value:
                    if not isinstance(raw_index, str):
                        continue
                    normalized_index = raw_index.strip().upper()
                    if not AnalyzeDeckPerformance.__INDEX_TOKEN_PATTERN.match(normalized_index):
                        continue
                    if normalized_index in seen_indices:
                        continue
                    cleaned_indices.append(normalized_index)
                    seen_indices.add(normalized_index)
                    if len(cleaned_indices) >= AnalyzeDeckPerformance.MAX_SOURCE_CARDS_PER_TOPIC:
                        break

            sanitized.append({
                "name":               name_value.strip()[:AnalyzeDeckPerformance.MAX_TOPIC_NAME_LENGTH],
                "strength":           normalized_strength,
                "reason":             (reason_value.strip()[:AnalyzeDeckPerformance.MAX_CARD_TEXT_LENGTH] if isinstance(reason_value, str) else ""),
                "sourceCardIndices":  cleaned_indices,
            })
            per_tier_counts[normalized_strength] += 1

        return sanitized

    async def __spawn_curated_study_children(self, user_id: str, topics_to_cover: list[dict], deck_chain: list[str], generated_for_analysis_at: str, paid_deck_id: str = "", attach_deck_id: str = "") -> None:
        """
        Spawns one GENERATE_CURATED_STUDY_MATERIAL child task per topic
        the user needs help on (WEAK foundational gaps and VOLATILE
        confusion patterns). The `generated_for_analysis_at` timestamp
        flows into each child so every sibling spawn shares the same
        batch tag — that lets the frontend's "Current Batch" filter
        recognise the cohort without any deck-side bookkeeping.

        Per-tier topics are capped by TOP_TOPICS_PER_TIER, so the upper
        bound on children is `TOP_TOPICS_PER_TIER * 2` (WEAK + VOLATILE).

        Continue-branch entries carry an explicit `topicIndex` (from the
        original batch) plus a `hardCards` array of {question, answer}
        pairs the LLM should treat as "the student got these wrong last
        round"; fresh entries enumerate naturally and have no hard-card
        context.
        """
        if not topics_to_cover:
            return

        current_task = await TaskManager.get_current_task()
        if current_task is None:
            return

        spawned_task_ids: list[str] = []

        for enumeration_index, topic_entry in enumerate(topics_to_cover):
            topic_name = topic_entry.get("name", "")
            if not topic_name:
                continue

            # When the entry carries an explicit topicIndex (Continue
            # branch), use it so the regenerated material occupies the
            # same slot in the LIVE batch as the archived one. Otherwise
            # enumerate naturally.
            explicit_topic_index = topic_entry.get("topicIndex")
            effective_topic_index = explicit_topic_index if isinstance(explicit_topic_index, int) else enumeration_index

            hard_cards = topic_entry.get("hardCards") or []
            # Carry the analysis-pass source card ids through to the
            # child so the persisted curated StudyMaterial knows which
            # underlying cards drove its topic. The frontend's
            # COMPLETED_ALL_EASY archive path uses these to apply a
            # positive FSRS review to each, closing the feedback loop
            # that the previous version was missing.
            source_card_ids = topic_entry.get("sourceCardIds") or []
            if not isinstance(source_card_ids, list):
                source_card_ids = []
            else:
                source_card_ids = [value for value in source_card_ids if isinstance(value, str) and value]

            curated_task = TaskDescriptor(
                type=TaskTypes.GENERATE_CURATED_STUDY_MATERIAL,
                execution_target=TaskExecutionTargets.LOCAL,
                user_id=user_id,
                payload={
                    "deckId":                 self.__deck_id,
                    "userId":                 user_id,
                    "topicName":              topic_name,
                    "topicIndex":             effective_topic_index,
                    "topicStrength":          topic_entry.get("strength", TopicStrength.WEAK.name),
                    "reason":                 topic_entry.get("reason", ""),
                    "deckChain":              deck_chain,
                    "generatedForAnalysisAt": generated_for_analysis_at,
                    "hardCards":              hard_cards,
                    "sourceCardIds":          source_card_ids,
                    # Paid-source tag: "" for normal decks. When set the child
                    # writes its generated material/cards through the SAME normal
                    # sync collections, stamping additionalData.paidDeckId on each
                    # so the /Sync pull encrypts them for the buyer. attachDeckId
                    # is the deck the analysis was run on (bundle root or a chosen
                    # sub-deck) that the child attaches the content under.
                    "paidDeckId":             paid_deck_id,
                    "attachDeckId":           attach_deck_id,
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

    async def __has_user_engaged_with_batch(self, card_collection, user_id: str, deck_ids_in_scope: list[str], batch_tag: str) -> bool:
        """
        One Mongo count_documents — does any curated card in this batch
        carry a non-UNGRADED lastCuratedGrade? If so, the user has
        graded at least one flashcard mid-session and a quiet supersede
        would erase their progress; the outer flow bails instead.
        """
        if not batch_tag:
            return False

        graded_card_count = await asyncio.to_thread(
            card_collection.count_documents,
            {
                "userId": user_id,
                "data.deckId": {"$in": deck_ids_in_scope},
                "data.additionalData." + CuratedFlashcardFields.B_CURATED: True,
                "data.additionalData." + CuratedFlashcardFields.GENERATED_FOR_ANALYSIS_AT: batch_tag,
                "data.additionalData." + CuratedFlashcardFields.LAST_CURATED_GRADE: {
                    "$in": [CuratedFlashcardGrade.EASY.name, CuratedFlashcardGrade.HARD.name],
                },
            },
        )
        return graded_card_count > 0

    async def __mark_skipped_due_to_in_progress(self, deck_collection) -> None:
        """
        Stamps the deck with the current timestamp so the entry dialog
        can surface a 'analysis was skipped because you had not yet
        finished the previous curated batch' banner. Cleared on the
        next successful generation via __set_live_batch_tag.
        """
        now_iso  = datetime.now(timezone.utc).isoformat()
        now_dt   = datetime.now(timezone.utc)

        await asyncio.to_thread(
            deck_collection.update_one,
            {"data.id": self.__deck_id},
            {"$set":
            {
                f"data.additionalData.{AutoAnalysisDeckFields.LAST_SKIPPED_DUE_TO_IN_PROGRESS_AT}": now_iso,
                "data.lifecycle.lastModified":                                                      now_dt,
                "serverUpdatedAt":                                                                  now_dt,
            }}
        )

    async def __demote_previous_batch(self, study_materials_collection, user_id: str, deck_ids_in_scope: list[str], batch_tag: str, next_state: str, outcome: str) -> None:
        """
        Centralised batch demotion. Used by:
          - the auto-supersede path (user never touched the prior batch)
            with next_state=SUPERSEDED, outcome=AUTO_REPLACED, and
          - the manual Regenerate path with next_state=ARCHIVED,
            outcome=REPLACED_BY_REGEN.
        Materials in the same batch share generatedForAnalysisAt by
        definition, so one update_many sweeps the entire cohort. Only
        LIVE materials are touched — already-demoted materials in the
        same batch (Continue-branch leftovers) stay put.
        """
        now_dt = datetime.now(timezone.utc)

        result = await asyncio.to_thread(
            study_materials_collection.update_many,
            {
                "userId": user_id,
                "data.deckId": {"$in": deck_ids_in_scope},
                "data.additionalData." + CuratedStudyMaterialFields.B_CURATED: True,
                "data.additionalData." + CuratedStudyMaterialFields.GENERATED_FOR_ANALYSIS_AT: batch_tag,
                "data.additionalData." + CuratedStudyMaterialFields.BATCH_REVIEW_STATE: CuratedBatchReviewStates.LIVE.name,
            },
            {"$set":
            {
                f"data.additionalData.{CuratedStudyMaterialFields.BATCH_REVIEW_STATE}": next_state,
                f"data.additionalData.{CuratedStudyMaterialFields.SESSION_OUTCOME}":    outcome,
                "data.lifecycle.lastModified":                                          now_dt,
                "serverUpdatedAt":                                                      now_dt,
            }}
        )
        print(f"[AnalyzeDeckPerformance] Demoted {result.modified_count} previous-batch material(s) to {next_state}/{outcome} for batch_tag={batch_tag}.")

    async def __set_live_batch_tag(self, deck_collection, batch_tag: str, spawnable_topics: list[dict]) -> None:
        """
        Stamps the deck with the fresh batch's tag + the topic summary
        the entry dialog reads to figure out what the LIVE batch
        contains. Also clears LAST_SKIPPED_DUE_TO_IN_PROGRESS_AT —
        successful generation means the user is no longer in a skipped
        state.
        """
        batch_topics_summary = [
            {"name": entry["name"], "strength": entry["strength"]}
            for entry in spawnable_topics
        ]
        now_dt = datetime.now(timezone.utc)

        await asyncio.to_thread(
            deck_collection.update_one,
            {"data.id": self.__deck_id},
            {
                "$set":
                {
                    f"data.additionalData.{AutoAnalysisDeckFields.LAST_CURATED_BATCH_TAG}":    batch_tag,
                    f"data.additionalData.{AutoAnalysisDeckFields.LAST_CURATED_BATCH_TOPICS}": batch_topics_summary,
                    "data.lifecycle.lastModified":                                              now_dt,
                    "serverUpdatedAt":                                                          now_dt,
                },
                "$unset":
                {
                    f"data.additionalData.{AutoAnalysisDeckFields.LAST_SKIPPED_DUE_TO_IN_PROGRESS_AT}": "",
                },
            },
        )

    def __normalise_regenerate_topics(self, raw_entries: list) -> list[dict]:
        """
        Validates and shapes caller-supplied topics for the skipAnalysis
        branch. Drops malformed entries silently; trims fields to the
        same caps used by the LLM-output sanitiser so downstream sites
        can treat both paths identically. Carries `topicIndex`,
        `hardCards`, and `sourceCardIds` through for the Continue
        branch and the COMPLETED_ALL_EASY auto-queue path.
        """
        if not isinstance(raw_entries, list):
            return []

        valid_strength_names = {strength.name for strength in TopicStrength}
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

            reason_value = entry.get("reason")
            hard_cards_value = entry.get("hardCards") or []
            if not isinstance(hard_cards_value, list):
                hard_cards_value = []

            source_card_ids_value = entry.get("sourceCardIds") or []
            if not isinstance(source_card_ids_value, list):
                source_card_ids_value = []
            else:
                source_card_ids_value = [value for value in source_card_ids_value if isinstance(value, str) and value]

            sanitized.append({
                "name":           name_value.strip()[:AnalyzeDeckPerformance.MAX_TOPIC_NAME_LENGTH],
                "strength":       normalized_strength,
                "reason":         (reason_value.strip()[:AnalyzeDeckPerformance.MAX_CARD_TEXT_LENGTH] if isinstance(reason_value, str) else ""),
                "topicIndex":     entry.get("topicIndex"),
                "hardCards":      hard_cards_value,
                "sourceCardIds":  source_card_ids_value,
            })

        return sanitized
