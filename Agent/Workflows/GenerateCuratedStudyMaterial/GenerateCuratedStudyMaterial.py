import asyncio
import json
import os
import re
import uuid
from datetime import datetime, timezone
from html import escape as html_escape

from bs4 import BeautifulSoup

from Workflows.Workflow import Workflow
from Globals.Classes.Analysis.CuratedFlashcardFields import CuratedFlashcardFields
from Globals.Classes.Analysis.CuratedStudyMaterialFields import CuratedStudyMaterialFields
from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.Providers.GoogleEnterpriseAiProvider import GoogleEnterpriseAiProvider
from Globals.Classes.Database.DatabaseConnector import DatabaseConnector
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Classes.WebScraping.WebScraper import WebScraper
from Globals.Constants.DatabaseConstants import DatabaseConstants
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Enumerations.CuratedBatchReviewStates import CuratedBatchReviewStates
from Globals.Enumerations.CuratedFlashcardGrade import CuratedFlashcardGrade
from Globals.Enumerations.TopicStrength import TopicStrength
from Globals.Classes.Database.EmbeddingsQueryEngine import EmbeddingsQueryEngine
from Globals.Utility.StripJsonMarkdown import strip_json_markdown


class GenerateCuratedStudyMaterial(Workflow):
    """
    Per-topic curated study material generator. Runs as a child task
    spawned by AnalyzeDeckPerformance for each WEAK or VOLATILE topic the
    user needs help on. Combines best-effort vector search across the
    user's textbook embeddings with a live web search, hands the merged
    context to Gemini 3.1-flash-lite (with grounding enabled), and
    persists a new StudyMaterial under the deck — then generates a set
    of curated flashcards reinforcing that material in the same task.

    Each curated material self-describes via its `additionalData`:
    `bCurated`, `topicName`, `topicStrength`, `generatedForAnalysisAt`
    (the batch tag), `batchReviewState=LIVE`, and `topicIndex`. The
    accompanying flashcards carry their own `bCurated` flag plus a
    `studyMaterialId` link back to their parent.

    Previous-batch demotion is NOT done here — AnalyzeDeckPerformance
    owns the batch lifecycle (archive on force, supersede on
    untouched-auto). Sibling spawns from the same analysis run share a
    `generatedForAnalysisAt` tag and all sit LIVE together.
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
    MAX_FLASHCARDS_PER_TOPIC                       = 8
    MIN_FLASHCARDS_PER_TOPIC                       = 3
    HARD_CARD_FEEDBACK_CHAR_LIMIT                  = 1200
    DEFAULT_BASE_DIFFICULTY                        = 1500

    # Simpler-language framing: curated materials exist to fill a gap
    # the student's standard explanation could not. The prompts below
    # therefore lead with intuition, define every term in plain English
    # even when it sounds redundant, and treat comprehension as more
    # important than rigour. WEAK tier gets the foundational variant;
    # VOLATILE tier gets the disambiguation variant. Both share the
    # simpler-language baseline.

    CITATION_INSTRUCTION_CLAUSE = (
        " When you state a fact drawn from one of the numbered web sources in the user context, append "
        "the matching reference in square brackets immediately after that sentence — for example `[1]` or "
        "`[2, 4]` for multiple sources. Only use numbers that exist in the Sources list; never invent a "
        "number, never cite the textbook excerpts, and never put a bracketed reference inside a code "
        "block or formula."
    )

    SYSTEM_PROMPT_WEAK = (
        "You are a patient tutor writing a foundational study material on a topic the student is weak in. "
        "Use the simplest possible language — assume the student was confused by the standard explanation "
        "in their syllabus. Lead with intuition before formalism. Define every technical term in plain "
        "English even if it sounds redundant. Walk through the idea concretely before any symbol or "
        "formula appears. When a formula matters, present it clearly and explain each symbol in one short "
        "sentence. Include at least one worked example that a struggling student can actually follow. The "
        "goal is comprehension over rigour — better that the student leaves understanding the core idea "
        "than dazzled by terminology. Output a single self-contained HTML fragment (no <html> or <body> "
        "wrappers) with semantic tags (<h2>, <h3>, <p>, <ul>, <ol>, <pre>, <strong>, <em>). Keep tone "
        "warm and encouraging." + CITATION_INSTRUCTION_CLAUSE
    )

    SYSTEM_PROMPT_VOLATILE = (
        "You are a patient tutor writing a clarifying study material on a topic the student keeps flipping "
        "on — they sometimes recall it correctly and sometimes don't, which means a prerequisite concept "
        "or a confusable neighbouring concept is undermining their recall. Use the simplest possible "
        "language — re-explain the cluster of related ideas in plain English, then re-derive the topic "
        "itself from those building blocks. Be explicit about common confusions ('this is NOT to be "
        "confused with X — the difference is …'). Include at least one worked example whose solution "
        "depends on getting this distinction right. Comprehension over rigour. Output a single "
        "self-contained HTML fragment (no <html> or <body> wrappers) with semantic tags (<h2>, <h3>, "
        "<p>, <ul>, <ol>, <pre>, <strong>, <em>). Keep tone warm and encouraging." + CITATION_INSTRUCTION_CLAUSE
    )

    SYSTEM_PROMPT_FLASHCARDS = (
        "You are generating flashcards that test a student's understanding of A SPECIFIC TOPIC — NOT "
        "their memory of the study material itself. The student name of the topic is given in the user "
        "prompt; every flashcard you write must directly probe that topic.\n\n"
        "THE GOLDEN RULE: the material you were just shown may use analogies, real-world examples, "
        "stories, or mnemonics to teach the topic. Those are pedagogical SCAFFOLDING — they exist to "
        "help the student understand the topic. They are NEVER the subject of a flashcard. The student "
        "needs to be tested on the topic itself, not on whether they remember the analogy used to "
        "explain it.\n\n"
        "BAD-VS-GOOD EXAMPLES (study these before writing any cards):\n"
        "  Topic: IaaS vs PaaS vs SaaS (material used a pizza-delivery analogy)\n"
        "    BAD:  What does the pizza dough represent in the IaaS analogy?\n"
        "    GOOD: In IaaS, what does the cloud provider manage and what does the customer manage?\n"
        "  Topic: TCP three-way handshake (material used a phone-call analogy)\n"
        "    BAD:  What does each ring of the phone correspond to in the handshake?\n"
        "    GOOD: Name the three segments exchanged during a TCP three-way handshake in order.\n"
        "  Topic: Photosynthesis light-dependent reactions (material referenced a 'factory' metaphor)\n"
        "    BAD:  In the factory analogy, what does the assembly line stand for?\n"
        "    GOOD: Which molecules are produced by the light-dependent reactions of photosynthesis?\n\n"
        "Each card should test ONE idea cleanly. Avoid prerequisite knowledge the student should "
        "already have. Avoid obscure trivia. Choose the card count yourself between "
        + str(MIN_FLASHCARDS_PER_TOPIC) + " and " + str(MAX_FLASHCARDS_PER_TOPIC) +
        " — fewer high-quality cards beat many shallow ones.\n\n"
        "Return STRICT compact JSON with exactly one key 'flashcards' whose value is an array of "
        "objects with 'question' (short plain-text string) and 'answer' (semantic HTML fragment, no "
        "<html>/<body> wrappers). No prose outside the JSON.\n\n"
        "FINAL REMINDER: every question must reference the topic by name (or a direct synonym). If a "
        "question mentions an analogy keyword that doesn't appear in the topic name, that question is "
        "wrong — rewrite it to ask about the underlying concept instead."
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

        # Continue-branch payload carries hard cards (question/answer
        # pairs) the student just struggled with. The LLM uses these as
        # explicit "the student got these wrong last round" context so
        # the new material and new flashcards address the same confusion
        # from a different angle.
        hard_cards_payload = payload.get("hardCards", [])
        self.__hard_cards  = [entry for entry in hard_cards_payload if isinstance(entry, dict)] if isinstance(hard_cards_payload, list) else []

        # Source card ids — the underlying (non-curated) cards that
        # AnalyzeDeckPerformance attributed to this topic. The frontend's
        # COMPLETED_ALL_EASY archive flow looks these up on the persisted
        # StudyMaterial.additionalData and grades each one Easy so the
        # FSRS / Glicko state reflects the user's curated practice.
        source_card_ids_payload = payload.get("sourceCardIds", [])
        self.__source_card_ids  = [value for value in source_card_ids_payload if isinstance(value, str) and value] if isinstance(source_card_ids_payload, list) else []

        # Paid-source tag: paid decks are now normal decks living in the normal
        # sync collections, stored plaintext server-side. The ONLY paid-specific
        # behaviour that remains is stamping additionalData.paidDeckId onto every
        # generated StudyMaterial + curated card so the /Sync pull encrypts them
        # for the buyer.
        #
        # Read ONLY the paidDeckId field — NEVER fall back to attachDeckId.
        # attachDeckId is "which deck to attach the generated content under" and
        # is ALWAYS set (to the deck id) for every deck, paid or not. Using it as
        # a paidDeckId fallback stamped a bogus paid tag onto every NORMAL deck's
        # curated content; the incremental /Sync then treated that content as
        # licensed, failed to find a content key, and silently dropped it from
        # the pull — so AI-generated curated batches never reached the client.
        # For a genuinely paid deck the caller always supplies a real paidDeckId,
        # so no fallback is ever needed.
        self.__paid_deck_id = payload.get("paidDeckId", "") or ""

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
        cards_collection           = database[DatabaseConstants.CARDS_COLLECTION]
        text_embeddings_collection = database[DatabaseConstants.TEXT_EMBEDDINGS_COLLECTION]

        # Paid and non-paid decks share the same normal read/write path. The
        # deck lives in the normal sync collection wrapped as {userId, data:
        # {...}, serverUpdatedAt} — see Dock SyncQueryEngine.bulkUpsert.
        target_deck = await asyncio.to_thread(deck_collection.find_one, {"data.id": self.__deck_id, "userId": self.__user_id}, {"_id": 0})
        if target_deck is None:
            print(f"[GenerateCuratedStudyMaterial] Deck {self.__deck_id} not found for user {self.__user_id} — exiting.")
            return

        textbook_snippets = await self.__collect_textbook_snippets(text_embeddings_collection)
        web_sources       = await self.__collect_web_snippets()

        merged_context = self.__assemble_context(textbook_snippets, web_sources)

        html_content = await self.__synthesize_html_content(merged_context)
        if not html_content:
            print(f"[GenerateCuratedStudyMaterial] LLM returned no content for topic '{self.__topic_name}' — exiting.")
            return

        html_content = GenerateCuratedStudyMaterial.__inject_citation_links(html_content, web_sources)

        study_material_id = str(uuid.uuid4())
        now_iso           = datetime.now(timezone.utc).isoformat()
        now_datetime      = datetime.now(timezone.utc)

        # The inner StudyMaterial JSON. SESSION_OUTCOME is intentionally left
        # unset at creation — its absence implies the batch is IN_PROGRESS;
        # the controller / AnalyzeDeckPerformance write a terminal outcome
        # when archiving / superseding.
        material_plaintext = {
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
                CuratedStudyMaterialFields.TOPIC_INDEX:               self.__topic_index,
                CuratedStudyMaterialFields.READ_STATE:                "UNREAD",
                CuratedStudyMaterialFields.SOURCE_CARD_IDS:           self.__source_card_ids,
            },
        }

        # Paid decks are normal decks: when a paidDeckId is present, stamp it onto
        # additionalData so the /Sync pull encrypts this material for the buyer.
        if self.__paid_deck_id:
            material_plaintext["additionalData"]["paidDeckId"] = self.__paid_deck_id

        # Sync-collection inserts must be wrapped {userId, data: {...},
        # serverUpdatedAt} — see Dock SyncQueryEngine.bulkUpsert.
        await asyncio.to_thread(
            study_materials_collection.insert_one,
            {"userId": self.__user_id, "serverUpdatedAt": now_datetime, "data": material_plaintext},
        )
        print(f"[GenerateCuratedStudyMaterial] Persisted curated study material {study_material_id} for topic '{self.__topic_name}'.")

        # Eager flashcard generation. The flashcards reference the material's
        # id (`studyMaterialId`), so the material must be persisted first.
        # Failures here log but do not roll back the material.
        await self.__generate_flashcards(cards_collection, study_material_id, html_content, merged_context)

        current_task = await TaskManager.get_current_task()
        if current_task is not None:
            current_task.set_completion(1.0)
            await TaskManager.set_task(current_task)

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

        top_k = GenerateCuratedStudyMaterial.EMBEDDING_TOP_K

        # Global (un-scoped) Atlas $vectorSearch over the textbook corpus — the
        # index defines an informationSourceHash filter field, but curated study
        # intentionally searches across all embedded sources, so no filter is
        # supplied. If the index is missing or still building the aggregation
        # raises and __collect_textbook_snippets swallows it (returns []).
        pipeline = [
            {
                "$vectorSearch":
                {
                    "index": EmbeddingsQueryEngine.VECTOR_INDEX_NAME,
                    "path": "embedding",
                    "queryVector": [float(value) for value in query_vector],
                    "numCandidates": max(top_k * 20, 150),
                    "limit": top_k,
                }
            },
            {
                "$project": {"_id": 0, "content": 1},
            },
        ]

        scored_documents = await asyncio.to_thread(
            list,
            text_embeddings_collection.aggregate(pipeline),
        )

        return [
            document["content"]
            for document in scored_documents
            if isinstance(document.get("content"), str) and document.get("content")
        ]

    async def __collect_web_snippets(self) -> list[dict]:
        """
        Returns a list of `{title, url, snippet}` records so the URL stays
        available for the citation-link injection step later. The snippet
        is trimmed to `WEB_CONTENT_SNIPPET_CHAR_LIMIT`; records with no
        usable snippet OR no URL are dropped because they can't be cited.
        """
        try:
            scraper = WebScraper()
            search_results = await scraper.search_rich(
                self.__topic_name,
                result_count=GenerateCuratedStudyMaterial.WEB_SEARCH_RESULT_LIMIT,
            )
        except Exception as scraper_error:
            print(f"[GenerateCuratedStudyMaterial] Web search failed for topic '{self.__topic_name}': {scraper_error}")
            return []

        web_sources: list[dict] = []
        for result in search_results or []:
            title   = (result.get("title") or "").strip()
            snippet = (result.get("snippet") or "").strip()
            url     = (result.get("url") or "").strip()

            if not snippet or not url:
                continue

            trimmed_snippet = snippet[: GenerateCuratedStudyMaterial.WEB_CONTENT_SNIPPET_CHAR_LIMIT]
            web_sources.append({"title": title, "url": url, "snippet": trimmed_snippet})

        return web_sources

    def __assemble_context(self, textbook_snippets: list[str], web_sources: list[dict]) -> str:
        assembled_blocks: list[str] = []

        if textbook_snippets:
            assembled_blocks.append("=== EXCERPTS FROM THE STUDENT'S OWN TEXTBOOK (do not cite — use only as background) ===")
            for excerpt_index, snippet in enumerate(textbook_snippets, start=1):
                assembled_blocks.append(f"Excerpt {excerpt_index}: {snippet}")

        if web_sources:
            assembled_blocks.append("=== NUMBERED WEB SOURCES (cite as [N] when you draw on one) ===")
            for source_index, source in enumerate(web_sources, start=1):
                source_title   = source.get("title") or "(no title)"
                source_url     = source.get("url") or ""
                source_snippet = source.get("snippet") or ""
                assembled_blocks.append(f"[{source_index}] {source_title} — {source_url}\n    {source_snippet}")

        assembled_text = "\n\n".join(assembled_blocks)
        return assembled_text[: GenerateCuratedStudyMaterial.MAX_CONTEXT_CHARACTERS]

    def __build_hard_cards_clause(self) -> str:
        """
        Turns the Continue-branch hardCards payload into a prompt block
        the LLM treats as 'the student just got these wrong'. Capped at
        HARD_CARD_FEEDBACK_CHAR_LIMIT so a pathological payload cannot
        crowd out the textbook/web context.
        """
        if not self.__hard_cards:
            return ""

        formatted_entries: list[str] = []
        for entry in self.__hard_cards:
            question = (entry.get("question") or "").strip()
            answer   = (entry.get("answer") or "").strip()
            if not question:
                continue
            formatted_entries.append(f"- Q: {question}\n  A: {answer}")

        if not formatted_entries:
            return ""

        block = "\n".join(formatted_entries)
        trimmed_block = block[: GenerateCuratedStudyMaterial.HARD_CARD_FEEDBACK_CHAR_LIMIT]
        return (
            "\n\nThe student JUST attempted the following flashcards on this topic and got them wrong. "
            "Address the underlying confusion these questions reveal — do NOT simply restate the same "
            "answer; explain the gap that led to the wrong response:\n" + trimmed_block + "\n\n"
        )

    # Matches a reference cluster like `[1]`, `[2, 4]`, or `[1,3,5]`.
    # Disallows whitespace immediately inside the outer brackets so the
    # pattern doesn't swallow things like `[ note ]` or markdown link
    # fragments that happen to contain commas.
    CITATION_MARKER_PATTERN = re.compile(r"\[(\d+(?:\s*,\s*\d+)*)\]")

    # Tags whose text content must NOT be touched — code, links,
    # KaTeX/MathML, and script/style. Any [N] inside these stays as
    # literal text.
    CITATION_SKIP_TAGS = frozenset({"a", "code", "pre", "kbd", "samp", "tt", "script", "style", "math"})

    @staticmethod
    def __inject_citation_links(html_content: str, web_sources: list[dict]) -> str:
        """
        Walks the LLM-authored HTML and replaces `[N]` / `[N, M]` citation
        markers with clickable anchor tags pointing at `web_sources[N-1].url`.
        Skips text inside `<a>`, `<code>`, `<pre>`, `<math>`, etc. so code
        examples like `array[1]` and existing links are left alone. A
        marker that references a number outside the valid source range is
        also left untouched — protects against the LLM hallucinating
        `[99]` and from incidental text that just happens to contain
        bracketed digits.
        """
        if not html_content or not web_sources:
            return html_content

        soup = BeautifulSoup(html_content, "html.parser")

        def is_inside_skip_element(node) -> bool:
            ancestor = node.parent
            while ancestor is not None:
                if getattr(ancestor, "name", None) in GenerateCuratedStudyMaterial.CITATION_SKIP_TAGS:
                    return True
                ancestor = ancestor.parent
            return False

        # Snapshot the text-node list first — replace_with mutates the
        # tree mid-iteration and would otherwise revisit our inserted
        # anchors and try to "cite" their own text.
        text_nodes = [node for node in soup.find_all(string=True) if not is_inside_skip_element(node)]

        for text_node in text_nodes:
            original_text = str(text_node)
            if "[" not in original_text:
                continue

            replacement_fragments: list[str] = []
            cursor = 0
            b_replaced_any = False

            for match in GenerateCuratedStudyMaterial.CITATION_MARKER_PATTERN.finditer(original_text):
                number_strings = [chunk.strip() for chunk in match.group(1).split(",")]
                try:
                    citation_numbers = [int(piece) for piece in number_strings]
                except ValueError:
                    continue

                if not all(1 <= citation_number <= len(web_sources) for citation_number in citation_numbers):
                    continue

                # Reject `array[1]`-style usage: if the character right
                # before the bracket is a word character, the [N] is
                # almost certainly an index expression, not a citation.
                if match.start() > 0:
                    preceding_character = original_text[match.start() - 1]
                    if preceding_character.isalnum() or preceding_character == "_":
                        continue

                replacement_fragments.append(html_escape(original_text[cursor:match.start()]))
                replacement_fragments.append("[")
                for index_in_cluster, citation_number in enumerate(citation_numbers):
                    if index_in_cluster > 0:
                        replacement_fragments.append(", ")
                    source = web_sources[citation_number - 1]
                    source_url   = source.get("url") or ""
                    source_title = source.get("title") or source_url
                    replacement_fragments.append(
                        f'<a href="{html_escape(source_url, quote=True)}" '
                        f'class="curated-citation-link" '
                        f'target="_blank" rel="noopener noreferrer" '
                        f'title="{html_escape(source_title, quote=True)}">{citation_number}</a>'
                    )
                replacement_fragments.append("]")
                cursor = match.end()
                b_replaced_any = True

            if not b_replaced_any:
                continue

            replacement_fragments.append(html_escape(original_text[cursor:]))
            replacement_html = "".join(replacement_fragments)
            replacement_soup = BeautifulSoup(replacement_html, "html.parser")
            text_node.replace_with(*list(replacement_soup.contents))

        return str(soup)

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

        topic_framing    = GenerateCuratedStudyMaterial.__build_topic_framing(self.__topic_strength, self.__topic_name)
        hard_cards_clause = self.__build_hard_cards_clause()

        user_prompt = (
            f"{deck_context_clause}"
            f"{topic_framing}\n\n"
            f"{reason_clause}"
            f"{hard_cards_clause}"
            "Write a foundational, simpler-language study material covering this topic. Audience: a "
            "student who has the topic on their syllabus but keeps getting questions wrong. Open with a "
            "one-paragraph plain-English overview, then walk through the foundational ideas before the "
            "harder ones. Include at least one worked example. Use semantic HTML.\n\n"
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

        caller   = AutomationCaller(GoogleEnterpriseAiProvider())
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

    async def __generate_flashcards(self, cards_collection, study_material_id: str, material_html: str, merged_context: str) -> None:
        """
        Asks Gemini to author a small set of flashcards reinforcing the
        material just written. The LLM picks the count (between
        MIN_FLASHCARDS_PER_TOPIC and MAX_FLASHCARDS_PER_TOPIC); the
        server caps and trims defensively. Failures here are logged
        but do not roll back the parent material — a topic with no
        flashcards is still useful as a read-only review.

        Paid and non-paid cards take the same path: curated cards are
        inserted into the normal sync cards collection. The paidDeckId
        tag (when present) is stamped in __build_empty_curated_card_document
        so the /Sync pull encrypts them for the buyer.
        """
        parsed_cards = await self.__call_gemini_for_flashcards(material_html, merged_context)
        if not parsed_cards:
            print(f"[GenerateCuratedStudyMaterial] Flashcard generation produced no cards for topic '{self.__topic_name}'.")
            return

        now_datetime = datetime.now(timezone.utc)
        card_documents: list[dict] = []

        for syllabus_position_in_topic, parsed_card in enumerate(parsed_cards):
            question_text = (parsed_card.get("question") or "").strip()
            answer_text   = (parsed_card.get("answer") or "").strip()

            if not question_text or not answer_text:
                continue

            card_documents.append(self.__build_empty_curated_card_document(
                study_material_id=study_material_id,
                question_text=question_text,
                answer_text=answer_text,
                syllabus_position_in_topic=syllabus_position_in_topic,
                now_datetime=now_datetime,
            ))

        if not card_documents:
            return

        await asyncio.to_thread(cards_collection.insert_many, card_documents)
        print(f"[GenerateCuratedStudyMaterial] Inserted {len(card_documents)} curated flashcard(s) for topic '{self.__topic_name}'.")

    async def __call_gemini_for_flashcards(self, material_html: str, merged_context: str) -> list[dict]:
        """
        Issues the flashcard-generation LLM call. Returns a list of
        {question, answer} dicts capped at MAX_FLASHCARDS_PER_TOPIC.
        Malformed JSON or empty arrays return [].
        """
        hard_cards_clause = self.__build_hard_cards_clause()

        user_prompt = (
            f"TOPIC TO TEST: {self.__topic_name}\n"
            f"Topic strength tier: {self.__topic_strength.name}\n\n"
            f"Every flashcard you write must test the student's understanding of the topic named above. "
            f"The reference material below may use analogies, examples, or stories as teaching aids — "
            f"those are scaffolding, NOT the subject of any question. If a question asks about an "
            f"analogy keyword instead of the topic concept, rewrite it.\n\n"
            f"{hard_cards_clause}"
            f"REFERENCE MATERIAL (use this for the underlying concepts of '{self.__topic_name}', NOT as "
            f"the subject of questions):\n\n{material_html}\n\n"
            f"ADDITIONAL CONTEXT (background only — do NOT pull obscure trivia from here):\n\n"
            f"{merged_context if merged_context else '(no additional context available)'}\n\n"
            f"Now generate flashcards that test '{self.__topic_name}'."
        )

        request = AutomationRequest(
            GenerateCuratedStudyMaterial.MODEL_NAME,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, GenerateCuratedStudyMaterial.SYSTEM_PROMPT_FLASHCARDS),
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    user_prompt,
                    metadata={"response_as_text": True},
                ),
            ]
        )

        caller   = AutomationCaller(GoogleEnterpriseAiProvider())
        response = await caller.call(request, None, retries=2)

        if response is None:
            return []

        try:
            raw_output = response.get_output().get_data()
        except Exception as response_error:
            print(f"[GenerateCuratedStudyMaterial] Failed to read flashcard LLM response: {response_error}")
            return []

        if not isinstance(raw_output, str) or not raw_output.strip():
            return []

        # `strip_json_markdown` already runs json.loads internally —
        # the function name is misleading; it returns the PARSED
        # dict/list (or None on parse failure), NOT a stripped string.
        # The previous version of this site mistakenly called
        # json.loads on the parsed result, which silently raised
        # TypeError and made every flashcard generation return [].
        # See other call sites in Agent/Workflows for the correct
        # pattern.
        parsed_payload = strip_json_markdown(raw_output.strip())
        if parsed_payload is None:
            print(f"[GenerateCuratedStudyMaterial] Flashcard JSON parse failed for topic '{self.__topic_name}' — raw LLM output was not valid JSON.")
            return []

        if not isinstance(parsed_payload, dict):
            print(f"[GenerateCuratedStudyMaterial] Flashcard LLM returned a non-object payload for topic '{self.__topic_name}' (type={type(parsed_payload).__name__}).")
            return []

        raw_cards = parsed_payload.get("flashcards", [])
        if not isinstance(raw_cards, list):
            print(f"[GenerateCuratedStudyMaterial] Flashcard LLM payload missing 'flashcards' array for topic '{self.__topic_name}'.")
            return []

        return raw_cards[: GenerateCuratedStudyMaterial.MAX_FLASHCARDS_PER_TOPIC]

    def __build_empty_curated_card_document(self, study_material_id: str, question_text: str, answer_text: str, syllabus_position_in_topic: int, now_datetime: datetime) -> dict:
        """
        Builds a Mongo card document for a curated flashcard. Mirrors
        the wrapping the sync layer uses ({userId, data, serverUpdatedAt})
        and matches the Card model's field shape (progress + lifecycle
        sub-objects, additionalData with curated metadata). Progress
        starts empty — curated cards never enter FSRS, so they never
        accumulate progress points the way regular cards do.
        """
        card_id = str(uuid.uuid4())

        # Paid decks are normal decks: when a paidDeckId is present, stamp it onto
        # the card's additionalData so the /Sync pull encrypts it for the buyer.
        additional_data = {
            CuratedFlashcardFields.B_CURATED:                  True,
            CuratedFlashcardFields.STUDY_MATERIAL_ID:          study_material_id,
            CuratedFlashcardFields.TOPIC_NAME:                 self.__topic_name,
            CuratedFlashcardFields.GENERATED_FOR_ANALYSIS_AT:  self.__generated_for_analysis_at,
            CuratedFlashcardFields.LAST_CURATED_GRADE:         CuratedFlashcardGrade.UNGRADED.name,
            CuratedFlashcardFields.SYLLABUS_POSITION_IN_TOPIC: syllabus_position_in_topic,
        }
        if self.__paid_deck_id:
            additional_data["paidDeckId"] = self.__paid_deck_id

        return {
            "userId":          self.__user_id,
            "serverUpdatedAt": now_datetime,
            "data":
            {
                "id":             card_id,
                "deckId":         self.__deck_id,
                "question":       question_text,
                "answer":         answer_text,
                "tags":           [],
                "baseDifficulty": GenerateCuratedStudyMaterial.DEFAULT_BASE_DIFFICULTY,
                "progress":
                {
                    "progressPoints": [],
                },
                "lifecycle":
                {
                    "creationDate":       now_datetime,
                    "lastModified":       now_datetime,
                    "views":              0,
                    "attempts":           0,
                    "timeSpentInSeconds": 0,
                },
                "additionalData": additional_data,
            },
        }
