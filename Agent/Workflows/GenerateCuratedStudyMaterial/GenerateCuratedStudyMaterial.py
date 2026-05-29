import asyncio
import math
import os
import uuid
from datetime import datetime, timezone

from Workflows.Workflow import Workflow
from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.Providers.GeminiProvider import GeminiProvider
from Globals.Classes.Database.DatabaseConnector import DatabaseConnector
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Classes.WebScraping.WebScraper import WebScraper
from Globals.Constants.DatabaseConstants import DatabaseConstants
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Enumerations.TopicStrength import TopicStrength
from Globals.Enumerations.CuratedBatchReviewStates import CuratedBatchReviewStates
from Globals.Classes.Analysis.CuratedStudyMaterialFields import CuratedStudyMaterialFields


class GenerateCuratedStudyMaterial(Workflow):
    """
    Per-topic curated study material generator. Runs as a child task
    spawned by AnalyzeDeckPerformance for each WEAK or VOLATILE topic the
    user needs help on. Combines best-effort vector search across the
    user's textbook embeddings with a live web search, hands the merged
    context to Gemini 3.1-flash-lite (with grounding enabled), and
    persists a new StudyMaterial under the deck.

    Each curated material self-describes via its `additionalData`:
    `bCurated`, `topicName`, `topicStrength`, `generatedForAnalysisAt`
    (the batch tag), and `batchReviewState`. The previous batch's
    materials for this deck are demoted from LIVE to PENDING_REVIEW so
    the on-login batch-review modal can surface them next time.
    """

    MODEL_NAME                                     = "gemini-3.1-flash-lite"
    EMBEDDING_MODEL_NAME                           = "nomic-ai/nomic-embed-text-v1"
    EMBEDDING_QUERY_PREFIX                         = "search_query: "
    EMBEDDING_DOC_FETCH_LIMIT                      = 1500
    EMBEDDING_TOP_K                                = 8
    WEB_SEARCH_RESULT_LIMIT                        = 5
    WEB_CONTENT_SNIPPET_CHAR_LIMIT                 = 600
    MAX_CONTEXT_CHARACTERS                         = 14000
    STUDY_MATERIAL_STANDARD_DETAIL_LEVEL           = 1

    SYSTEM_PROMPT_WEAK = (
        "You are a patient tutor writing a foundational study material on a topic the student is weak in. "
        "Start from the basics. Define every term. Walk through worked examples. If a formula matters, "
        "show it clearly and explain each symbol. If a diagram would help, describe it precisely in "
        "words or with an inline SVG snippet. Output a single self-contained HTML fragment (no <html> "
        "or <body> wrappers) with semantic tags (<h2>, <h3>, <p>, <ul>, <ol>, <pre>, <strong>, "
        "<em>). Keep tone warm and encouraging."
    )

    SYSTEM_PROMPT_VOLATILE = (
        "You are a patient tutor writing a clarifying study material on a topic the student keeps flipping "
        "on — they sometimes recall it correctly and sometimes don't, which means a prerequisite concept "
        "or a confusable neighbouring concept is undermining their recall. Surface the cluster of related "
        "ideas this topic sits in so the student can tell them apart, then re-derive the topic itself from "
        "those building blocks. Be explicit about common confusions (e.g. 'this is NOT to be confused with "
        "X — the difference is …'). Include at least one worked example whose solution depends on getting "
        "this distinction right. Output a single self-contained HTML fragment (no <html> or <body> "
        "wrappers) with semantic tags (<h2>, <h3>, <p>, <ul>, <ol>, <pre>, <strong>, <em>). Keep tone "
        "warm and encouraging."
    )

    def __init__(self, payload: dict = {}):
        super().__init__(payload)
        self.__deck_id     = payload.get("deckId", "")
        self.__user_id     = payload.get("userId", "")
        self.__topic_name  = payload.get("topicName", "")
        # Accept either `topicIndex` (new) or `weaknessIndex` (legacy) so
        # in-flight tasks queued before the rename still apply.
        topic_index_value = payload.get("topicIndex", payload.get("weaknessIndex", 0))
        try:
            self.__topic_index = int(topic_index_value)
        except (TypeError, ValueError):
            self.__topic_index = 0
        self.__reason      = payload.get("reason", "")
        deck_chain_payload = payload.get("deckChain", [])
        self.__deck_chain  = [str(name) for name in deck_chain_payload if isinstance(name, str) and name.strip()] if isinstance(deck_chain_payload, list) else []
        self.__generated_for_analysis_at = payload.get("generatedForAnalysisAt", "") or ""

        topic_strength_raw = payload.get("topicStrength", TopicStrength.WEAK.name)
        try:
            self.__topic_strength = TopicStrength[topic_strength_raw] if isinstance(topic_strength_raw, str) else TopicStrength.WEAK
        except KeyError:
            self.__topic_strength = TopicStrength.WEAK

    async def run(self, args: dict = {}):
        if not self.__deck_id or not self.__user_id or not self.__topic_name:
            print("[GenerateCuratedStudyMaterial] Missing deckId, userId, or topicName — exiting.")
            return

        database = await DatabaseConnector.get_database()
        if database is None:
            print("[GenerateCuratedStudyMaterial] No database connection — exiting.")
            return

        deck_collection            = database[DatabaseConstants.DECKS_COLLECTION]
        study_materials_collection = database[DatabaseConstants.STUDY_MATERIALS_COLLECTION]
        text_embeddings_collection = database[DatabaseConstants.TEXT_EMBEDDINGS_COLLECTION]

        # Sync-collection docs are wrapped {userId, data: {...},
        # serverUpdatedAt} — see Dock SyncQueryEngine.bulkUpsert.
        target_deck = await asyncio.to_thread(deck_collection.find_one, {"data.id": self.__deck_id, "userId": self.__user_id}, {"_id": 0})
        if target_deck is None:
            print(f"[GenerateCuratedStudyMaterial] Deck {self.__deck_id} not found for user {self.__user_id} — exiting.")
            return

        textbook_snippets = await self.__collect_textbook_snippets(text_embeddings_collection)
        web_snippets      = await self.__collect_web_snippets()

        merged_context = self.__assemble_context(textbook_snippets, web_snippets)

        html_content = await self.__synthesize_html_content(merged_context)
        if not html_content:
            print(f"[GenerateCuratedStudyMaterial] LLM returned no content for topic '{self.__topic_name}' — exiting.")
            return

        study_material_id = str(uuid.uuid4())
        now_iso           = datetime.now(timezone.utc).isoformat()
        now_datetime      = datetime.now(timezone.utc)

        # Sync-collection inserts must be wrapped {userId, data: {...},
        # serverUpdatedAt} — see Dock SyncQueryEngine.bulkUpsert. The
        # nested `data` block carries the StudyMaterial payload that
        # the sync pull will hand straight to the client.
        study_material_document = {
            "userId":          self.__user_id,
            "serverUpdatedAt": now_datetime,
            "data":
            {
                "id":               study_material_id,
                "deckId":           self.__deck_id,
                "content":          html_content,
                "syllabusPosition": 0,
                "detailLevel":      GenerateCuratedStudyMaterial.STUDY_MATERIAL_STANDARD_DETAIL_LEVEL,
                "lifecycle":
                {
                    "creationDate":      now_datetime,
                    "lastModified":      now_datetime,
                    "views":             0,
                    "attempts":          0,
                    "timeSpentInSeconds": 0,
                },
                "additionalData":
                {
                    CuratedStudyMaterialFields.B_CURATED:                 True,
                    CuratedStudyMaterialFields.TOPIC_NAME:                self.__topic_name,
                    CuratedStudyMaterialFields.TOPIC_STRENGTH:            self.__topic_strength.name,
                    CuratedStudyMaterialFields.GENERATED_FOR_ANALYSIS_AT: self.__generated_for_analysis_at,
                    CuratedStudyMaterialFields.BATCH_REVIEW_STATE:        CuratedBatchReviewStates.LIVE.name,
                },
            },
        }

        await asyncio.to_thread(study_materials_collection.insert_one, study_material_document)

        await self.__demote_previous_batch(study_materials_collection)

        current_task = await TaskManager.get_current_task()
        if current_task is not None:
            current_task.set_completion(1.0)
            await TaskManager.set_task(current_task)

        print(f"[GenerateCuratedStudyMaterial] Persisted curated study material {study_material_id} for topic '{self.__topic_name}'.")

    async def __collect_textbook_snippets(self, text_embeddings_collection) -> list[str]:
        try:
            return await self.__vector_search_textbook(text_embeddings_collection)
        except Exception as vector_search_error:
            print(f"[GenerateCuratedStudyMaterial] Vector search failed for topic '{self.__topic_name}': {vector_search_error}")
            return []

    async def __vector_search_textbook(self, text_embeddings_collection) -> list[str]:
        from sentence_transformers import SentenceTransformer

        embedding_query = GenerateCuratedStudyMaterial.EMBEDDING_QUERY_PREFIX + self.__topic_name

        def encode_query():
            model = SentenceTransformer(
                GenerateCuratedStudyMaterial.EMBEDDING_MODEL_NAME,
                trust_remote_code=True,
                device="cpu",
            )
            return model.encode([embedding_query], convert_to_numpy=True)[0].tolist()

        query_vector = await asyncio.to_thread(encode_query)

        candidate_documents = await asyncio.to_thread(
            list,
            text_embeddings_collection.find(
                {"embedding": {"$exists": True, "$ne": None}},
                {"_id": 0, "content": 1, "embedding": 1},
            ).limit(GenerateCuratedStudyMaterial.EMBEDDING_DOC_FETCH_LIMIT),
        )

        if not candidate_documents:
            return []

        scored: list[tuple[float, str]] = []
        for candidate in candidate_documents:
            embedding_vector = candidate.get("embedding")
            content_text     = candidate.get("content")

            if not isinstance(embedding_vector, list) or not isinstance(content_text, str) or not content_text:
                continue

            similarity = GenerateCuratedStudyMaterial.__cosine_similarity(query_vector, embedding_vector)
            scored.append((similarity, content_text))

        scored.sort(key=lambda entry: entry[0], reverse=True)
        return [content for _, content in scored[: GenerateCuratedStudyMaterial.EMBEDDING_TOP_K]]

    @staticmethod
    def __cosine_similarity(first_vector: list[float], second_vector: list[float]) -> float:
        if not first_vector or not second_vector or len(first_vector) != len(second_vector):
            return 0.0

        dot_product = 0.0
        first_magnitude = 0.0
        second_magnitude = 0.0
        for first_value, second_value in zip(first_vector, second_vector):
            dot_product      += first_value * second_value
            first_magnitude  += first_value * first_value
            second_magnitude += second_value * second_value

        if first_magnitude == 0.0 or second_magnitude == 0.0:
            return 0.0

        return dot_product / (math.sqrt(first_magnitude) * math.sqrt(second_magnitude))

    async def __collect_web_snippets(self) -> list[str]:
        try:
            scraper = WebScraper()
            search_results = await scraper.search_rich(
                self.__topic_name,
                result_count=GenerateCuratedStudyMaterial.WEB_SEARCH_RESULT_LIMIT,
            )
        except Exception as scraper_error:
            print(f"[GenerateCuratedStudyMaterial] Web search failed for topic '{self.__topic_name}': {scraper_error}")
            return []

        snippets: list[str] = []
        for result in search_results or []:
            title = (result.get("title") or "").strip()
            snippet = (result.get("snippet") or "").strip()
            url = (result.get("url") or "").strip()

            if not snippet:
                continue

            trimmed_snippet = snippet[: GenerateCuratedStudyMaterial.WEB_CONTENT_SNIPPET_CHAR_LIMIT]
            snippets.append(f"[{title}] {trimmed_snippet} (source: {url})")

        return snippets

    def __assemble_context(self, textbook_snippets: list[str], web_snippets: list[str]) -> str:
        assembled_blocks: list[str] = []

        if textbook_snippets:
            assembled_blocks.append("=== EXCERPTS FROM THE STUDENT'S OWN TEXTBOOK ===")
            for excerpt_index, snippet in enumerate(textbook_snippets, start=1):
                assembled_blocks.append(f"Excerpt {excerpt_index}: {snippet}")

        if web_snippets:
            assembled_blocks.append("=== EXCERPTS FROM RECENT WEB SEARCH ===")
            for web_index, snippet in enumerate(web_snippets, start=1):
                assembled_blocks.append(f"Web result {web_index}: {snippet}")

        assembled_text = "\n\n".join(assembled_blocks)
        return assembled_text[: GenerateCuratedStudyMaterial.MAX_CONTEXT_CHARACTERS]

    @staticmethod
    def __build_system_prompt(topic_strength: TopicStrength) -> str:
        """
        Returns the system prompt appropriate for the topic-strength
        tier. WEAK topics (foundational gaps) get the patient-tutor
        prompt; VOLATILE topics (the student keeps flipping on) get the
        disambiguation-focused prompt that surfaces neighbouring
        concepts the student confuses. Any unknown tier falls back to
        the WEAK prompt.
        """
        if topic_strength == TopicStrength.VOLATILE:
            return GenerateCuratedStudyMaterial.SYSTEM_PROMPT_VOLATILE
        return GenerateCuratedStudyMaterial.SYSTEM_PROMPT_WEAK

    @staticmethod
    def __build_topic_framing(topic_strength: TopicStrength, topic_name: str) -> str:
        """
        Frames the topic line in the user prompt according to tier so the
        LLM has both the system-level guidance and the per-prompt cue.
        Keeps the wording aligned with the system prompt's framing.
        """
        if topic_strength == TopicStrength.VOLATILE:
            return f"Topic the student keeps flipping on (volatile / confused): {topic_name}"
        return f"Topic the student is weak in: {topic_name}"

    async def __synthesize_html_content(self, merged_context: str) -> str | None:
        reason_clause = f"Recent flashcard performance suggests: {self.__reason}\n\n" if self.__reason else ""

        deck_context_clause = (
            f"This material is for a card in: {' → '.join(self.__deck_chain)}. Keep the topic name and "
            f"depth appropriate to this syllabus location.\n\n"
            if self.__deck_chain
            else ""
        )

        topic_framing = GenerateCuratedStudyMaterial.__build_topic_framing(self.__topic_strength, self.__topic_name)

        user_prompt = (
            f"{deck_context_clause}"
            f"{topic_framing}\n\n"
            f"{reason_clause}"
            "Write a foundational study material covering this topic. Audience: a student who has the "
            "topic on their syllabus but keeps getting questions wrong. Open with a one-paragraph "
            "definition, then walk through the foundational ideas before the harder ones. Include at "
            "least one worked example. Use semantic HTML.\n\n"
            f"Context drawn from the student's own material and the public web (cite-by-paraphrasing where "
            f"useful, never quote verbatim):\n\n{merged_context if merged_context else '(no additional context available — rely on general knowledge)'}"
        )

        request = AutomationRequest(
            GenerateCuratedStudyMaterial.MODEL_NAME,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, GenerateCuratedStudyMaterial.__build_system_prompt(self.__topic_strength)),
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    user_prompt,
                    metadata={"enable_search": True, "response_as_text": True},
                ),
            ]
        )

        caller = AutomationCaller(GeminiProvider())
        response = await caller.call(request, None, retries=2)

        if response is None:
            return None

        try:
            raw_output = response.get_output().get_data()
        except Exception as response_error:
            print(f"[GenerateCuratedStudyMaterial] Failed to read LLM response: {response_error}")
            return None

        if not isinstance(raw_output, str) or not raw_output.strip():
            return None

        return raw_output.strip()

    async def __demote_previous_batch(self, study_materials_collection) -> None:
        """
        Any curated material on this deck that is still marked LIVE and
        belongs to an older analysis batch (different
        `generatedForAnalysisAt`) is demoted to PENDING_REVIEW so the
        client's on-login batch-review modal can surface it. Materials
        belonging to the same batch as the one we just inserted are
        left LIVE — sibling spawns from one analysis run share a batch
        tag.

        Mongo docs are wrapped {userId, data: {...}, serverUpdatedAt}
        by the sync layer (see SyncQueryEngine.bulkUpsert), so every
        nested-entity selector needs the `data.` prefix.
        """
        b_curated_field      = f"data.additionalData.{CuratedStudyMaterialFields.B_CURATED}"
        review_state_field   = f"data.additionalData.{CuratedStudyMaterialFields.BATCH_REVIEW_STATE}"
        batch_tag_field      = f"data.additionalData.{CuratedStudyMaterialFields.GENERATED_FOR_ANALYSIS_AT}"

        match_query = {
            "userId":           self.__user_id,
            "data.deckId":      self.__deck_id,
            b_curated_field:    True,
            review_state_field: CuratedBatchReviewStates.LIVE.name,
            batch_tag_field:    {"$ne": self.__generated_for_analysis_at},
        }

        now_datetime = datetime.now(timezone.utc)
        await asyncio.to_thread(
            study_materials_collection.update_many,
            match_query,
            {"$set":
            {
                review_state_field:            CuratedBatchReviewStates.PENDING_REVIEW.name,
                "data.lifecycle.lastModified": now_datetime,
                "serverUpdatedAt":             now_datetime,
            }},
        )
