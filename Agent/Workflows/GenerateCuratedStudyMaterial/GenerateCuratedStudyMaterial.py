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


class GenerateCuratedStudyMaterial(Workflow):
    """
    Per-weak-topic curated study material generator. Combines best-effort
    vector search across the user's textbook embeddings with a live web
    search, hands the merged context to Gemini 3.1-flash-lite (with
    grounding enabled), and persists a new StudyMaterial under the deck
    whose weakness triggered the run. The new material's id is appended
    to the deck's additionalData.curatedStudyMaterialIds so the home page
    can surface it as a "curated" item.
    """

    MODEL_NAME                                     = "gemini-3.1-flash-lite"
    EMBEDDING_MODEL_NAME                           = "nomic-ai/nomic-embed-text-v1"
    EMBEDDING_QUERY_PREFIX                         = "search_query: "
    EMBEDDING_DOC_FETCH_LIMIT                      = 1500
    EMBEDDING_TOP_K                                = 8
    WEB_SEARCH_RESULT_LIMIT                        = 5
    WEB_CONTENT_SNIPPET_CHAR_LIMIT                 = 600
    MAX_CONTEXT_CHARACTERS                         = 14000
    CURATED_STUDY_MATERIAL_IDS_FIELD               = "curatedStudyMaterialIds"
    ARCHIVED_CURATED_STUDY_MATERIAL_IDS_FIELD      = "archivedCuratedStudyMaterialIds"
    PENDING_BATCH_REVIEW_MATERIAL_IDS_FIELD        = "pendingBatchReviewMaterialIds"
    STUDY_MATERIAL_STANDARD_DETAIL_LEVEL           = 1

    SYSTEM_PROMPT = (
        "You are a patient tutor writing a foundational study material on a topic the student is weak in. "
        "Start from the basics. Define every term. Walk through worked examples. If a formula matters, "
        "show it clearly and explain each symbol. If a diagram would help, describe it precisely in "
        "words or with an inline SVG snippet. Output a single self-contained HTML fragment (no <html> "
        "or <body> wrappers) with semantic tags (<h2>, <h3>, <p>, <ul>, <ol>, <pre>, <strong>, "
        "<em>). Keep tone warm and encouraging."
    )

    def __init__(self, payload: dict = {}):
        super().__init__(payload)
        self.__deck_id        = payload.get("deckId", "")
        self.__user_id        = payload.get("userId", "")
        self.__topic_name     = payload.get("topicName", "")
        self.__weakness_index = int(payload.get("weaknessIndex", 0))
        self.__reason         = payload.get("reason", "")
        deck_chain_payload    = payload.get("deckChain", [])
        self.__deck_chain     = [str(name) for name in deck_chain_payload if isinstance(name, str) and name.strip()] if isinstance(deck_chain_payload, list) else []

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

        target_deck = await asyncio.to_thread(deck_collection.find_one, {"id": self.__deck_id, "userId": self.__user_id}, {"_id": 0})
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

        study_material_document = {
            "id":               study_material_id,
            "userId":           self.__user_id,
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
        }

        await asyncio.to_thread(study_materials_collection.insert_one, study_material_document)

        await self.__update_deck_curated_ids(deck_collection, target_deck, study_material_id)

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

    async def __synthesize_html_content(self, merged_context: str) -> str | None:
        reason_clause = f"The student has been struggling with this topic — recent flashcard performance suggests: {self.__reason}\n\n" if self.__reason else ""

        deck_context_clause = (
            f"This material is for a card in: {' → '.join(self.__deck_chain)}. Keep the topic name and "
            f"depth appropriate to this syllabus location.\n\n"
            if self.__deck_chain
            else ""
        )

        user_prompt = (
            f"{deck_context_clause}"
            f"Topic the student is weak in: {self.__topic_name}\n\n"
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
                AutomationContent(AutomationContentTypes.SYSTEM, GenerateCuratedStudyMaterial.SYSTEM_PROMPT),
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

    async def __update_deck_curated_ids(self, deck_collection, target_deck: dict, study_material_id: str) -> None:
        existing_additional_data = target_deck.get("additionalData") or {}

        existing_live_ids = existing_additional_data.get(GenerateCuratedStudyMaterial.CURATED_STUDY_MATERIAL_IDS_FIELD)
        if not isinstance(existing_live_ids, list):
            existing_live_ids = []

        existing_pending_review_ids = existing_additional_data.get(GenerateCuratedStudyMaterial.PENDING_BATCH_REVIEW_MATERIAL_IDS_FIELD)
        if not isinstance(existing_pending_review_ids, list):
            existing_pending_review_ids = []

        # When a fresh batch lands while a previous batch is still live, the
        # previous batch is preserved in `pendingBatchReviewMaterialIds` so
        # the client can prompt the user to archive / keep / delete them.
        new_pending_review_ids = list(existing_pending_review_ids)
        for previous_live_id in existing_live_ids:
            if previous_live_id != study_material_id and previous_live_id not in new_pending_review_ids:
                new_pending_review_ids.append(previous_live_id)

        new_live_ids = list(existing_live_ids) if study_material_id in existing_live_ids else [*existing_live_ids, study_material_id]

        # Drop the previous-batch ids out of the live list so the home page
        # only highlights the freshest batch. They remain reachable via the
        # pending-batch-review modal.
        new_live_ids = [material_id for material_id in new_live_ids if material_id == study_material_id or material_id not in new_pending_review_ids]

        await asyncio.to_thread(
            deck_collection.update_one,
            {"id": self.__deck_id, "userId": self.__user_id},
            {"$set":
            {
                f"additionalData.{GenerateCuratedStudyMaterial.CURATED_STUDY_MATERIAL_IDS_FIELD}":          new_live_ids,
                f"additionalData.{GenerateCuratedStudyMaterial.PENDING_BATCH_REVIEW_MATERIAL_IDS_FIELD}":   new_pending_review_ids,
                "lifecycle.lastModified":                                                                   datetime.now(timezone.utc),
            }}
        )
