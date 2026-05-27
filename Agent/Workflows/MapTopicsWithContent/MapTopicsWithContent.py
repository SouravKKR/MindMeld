import asyncio
import json
import os
from typing import List, Tuple

from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.Pools.ModelPool import ModelPool
from Globals.Classes.Automation.Pools.PromptPool import PromptPool
from Globals.Classes.Decorators.ExtractableInformationSource import ExtractableInformationSource
from Globals.Classes.Generic.Persistence import Persistence
from Globals.Classes.Task.AutoGeneration.GeneralGenerationSettings import GeneralGenerationSettings
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Constants.PersistenceConstants import PersistenceConstants
from Globals.Constants.ReputedSources import ReputedSources
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Enumerations.InformationSourceTypes import InformationSourceTypes
from Globals.Utility.ExpandPageRanges import is_full_document_range
from Globals.Utility.JoinPath import join_path
from Globals.Utility.SanitizeFilename import sanitize_filename
from Globals.Utility.StripJsonMarkdown import strip_json_markdown
from Workflows.Workflow import Workflow
from Workflows.FetchWebContent.FetchWebContent import FetchWebContent

from Workflows.MapTopicsWithContent.ExtractText import extract_text
from Workflows.MapTopicsWithContent.ChunkUtils import (
    extract_leaves,
    merge_consecutive_groups,
    CHUNK_SIZE,
)
from Workflows.MapTopicsWithContent.MatchChunksToTopic import match_chunks_to_topics


class MapTopicsWithContent(Workflow):

    WEB_SOURCE_TYPES = (
        InformationSourceTypes.ANYWHERE_ON_THE_INTERNET,
        InformationSourceTypes.REPUTED_EXTERNAL_SOURCES,
        InformationSourceTypes.AI_GENERATED,
    )

    WEB_FETCH_CONCURRENCY        = 6
    WEB_FETCH_PAGE_BUDGET        = 2
    WEB_FETCH_IMAGE_BUDGET       = 3
    REPUTED_DOMAIN_SHORTLIST_MAX = 8

    def __init__(self, payload = {}):
        super().__init__(payload)
        self.__general_generation_settings: GeneralGenerationSettings = GeneralGenerationSettings.from_json(payload)

    async def __update_progress(self, completion: float):
        task = await TaskManager.get_current_task()
        task.set_completion(completion)
        await TaskManager.set_task(task)

    @staticmethod
    def __ranges_to_extract(extractable_source: ExtractableInformationSource) -> List[Tuple[int, int | None]]:
        """
        Returns a list of (start_page, end_page-or-None) tuples for extract_text.
        Empty list / [0,0] in pageRanges means "full document" -> [(1, None)].
        """
        page_ranges = extractable_source.get_page_ranges()
        if not page_ranges:
            return [(1, None)]

        ranges: List[Tuple[int, int | None]] = []
        for page_range in page_ranges:
            if is_full_document_range(page_range):
                return [(1, None)]
            start_page = max(1, page_range.get_start_page())
            end_page   = max(start_page, page_range.get_end_page())
            ranges.append((start_page, end_page))
        return ranges

    async def __extract_text_from_provided_document(self, extractable_source: ExtractableInformationSource) -> str:
        information_source = extractable_source.get_information_source()
        textbook_path      = join_path("/", information_source.get_directory_path(), information_source.get_hash())

        try:
            pdf_bytes = await Persistence.read(textbook_path)
        except Exception as read_error:
            print(f"[MapTopicsWithContent] Could not read '{information_source.get_name()}': {read_error}")
            return ""

        parts = []
        for (start_page, end_page) in self.__ranges_to_extract(extractable_source):
            print(f"\n--- Extracting text from '{information_source.get_name()}' (pages {start_page}–{end_page or 'end'}) ---")
            try:
                extracted_text = extract_text(pdf_bytes, start_page=start_page, end_page=end_page)
                if extracted_text.strip():
                    parts.append(extracted_text)
            except Exception as extract_error:
                print(f"[MapTopicsWithContent] extract_text failed for '{information_source.get_name()}': {extract_error}")
                continue

        return "\n\n".join(parts)

    async def run(self):
        from sentence_transformers import SentenceTransformer, CrossEncoder
        # ExtractText (called below via __pdf_text_for_source) reaches into
        # fitz. Silence MuPDF before the first PDF touches the parser.
        from Globals.Classes.Generic.MuPdfBootstrap import MuPdfBootstrap
        MuPdfBootstrap.silence_parser_warnings()

        main_task_id = os.getenv("MAIN_TASK_ID")

        # ── 1. Load syllabus taxonomy written by ProcessSyllabus ──────────────
        syllabus_path = join_path("/", PersistenceConstants.TASKS_DIRECTORY, main_task_id, PersistenceConstants.SYLLABUS_FILE_NAME)

        print(f"Loading syllabus from {syllabus_path}...")

        syllabus_bytes = await Persistence.read(syllabus_path)
        taxonomy       = json.loads(syllabus_bytes.decode("utf-8"))

        leaves         = extract_leaves(taxonomy)
        topic_strings  = [leaf["topic"] for leaf in leaves]
        print(f"Loaded {len(leaves)} leaf topics from syllabus.")
        await self.__update_progress(0.05)

        # ── 2. Iterate over ALL provided document sources (multi-source fix) ──
        extractable_information_sources = self.__general_generation_settings.get_information_sources() or []

        document_sources = [
            extractable_source for extractable_source in extractable_information_sources
            if extractable_source.get_information_source().get_source_type() == InformationSourceTypes.PROVIDED_DOCUMENTS
        ]

        enabled_web_source_types = [
            int(extractable_source.get_information_source().get_source_type())
            for extractable_source in extractable_information_sources
            if extractable_source.get_information_source().get_source_type() in MapTopicsWithContent.WEB_SOURCE_TYPES
        ]

        if enabled_web_source_types:
            reputed_shortlist = await self.__select_relevant_reputed_domains(leaves)
            await self.__dispatch_web_fetches(main_task_id, leaves, enabled_web_source_types, reputed_shortlist)
            await self.__update_progress(0.20)

        combined_text_parts = []
        for extractable_source in document_sources:
            extracted = await self.__extract_text_from_provided_document(extractable_source)
            if extracted.strip():
                combined_text_parts.append(extracted)

        full_text = "\n\n".join(combined_text_parts)

        if not full_text.strip() and not enabled_web_source_types:
            print("[MapTopicsWithContent] No text extracted from any document source and no web sources enabled.")
            await self.__update_progress(1.0)
            return

        await self.__update_progress(0.25)

        # ── 3. If we have document text, run topic-to-content matching ────────
        topic_buckets: dict = {topic_index: [] for topic_index in range(len(leaves))}

        if full_text.strip():
            print(f"\nLoading bi-encoder ({ModelPool.MAP_TOPICS_BIENCODER_MODEL}) ...")
            bi_encoder = SentenceTransformer(ModelPool.MAP_TOPICS_BIENCODER_MODEL, trust_remote_code=True)

            print("Encoding topics ...")
            topic_embeddings = bi_encoder.encode(
                [f"search_query: {topic}" for topic in topic_strings],
                convert_to_tensor=True,
                show_progress_bar=True,
            )
            await self.__update_progress(0.40)

            print(f"\nLoading cross-encoder ({ModelPool.MAP_TOPICS_CROSSENCODER_MODEL}) ...")
            cross_encoder = CrossEncoder(ModelPool.MAP_TOPICS_CROSSENCODER_MODEL)

            print("\n--- Semantic chunk matching ---")
            topic_buckets = match_chunks_to_topics(
                full_text, leaves, topic_strings, topic_embeddings,
                bi_encoder, cross_encoder, CHUNK_SIZE,
            )

        await self.__update_progress(0.65)

        # ── 4. Persist topic files (with web-source hints when applicable) ────
        print("\n--- Saving results ---")
        saved_count = await self.__save_results(topic_buckets, leaves, main_task_id, enabled_web_source_types)
        await self.__update_progress(1.0)

        print(f"\nDone. {saved_count} topic files written.")

    async def __save_results(
        self,
        topic_buckets:           dict,
        leaves:                  list,
        main_task_id:            str,
        enabled_web_source_types: list,
    ) -> int:
        # ── First pass: assemble all chunks (PDF + web) per topic so we can compute
        #    a denominator that actually reflects the full corpus. The earlier
        #    formula was based on PDF chunks only, which broke down catastrophically
        #    in description-only mode where total_chunks was ~0 and weights summed
        #    to far more than 1 (causing 6900% progress bars downstream).
        topic_payloads: list = []

        for topic_index, chunk_list in topic_buckets.items():
            leaf      = leaves[topic_index]
            topic_str = leaf["topic"]
            hierarchy = leaf["path"]

            content_chunks = []
            if chunk_list:
                chunk_list.sort(key=lambda item: item["chunkIndex"])
                groups = merge_consecutive_groups(chunk_list)
                content_chunks = [
                    "\n[--- Next Chunk ---]\n".join(item["content"] for item in group)
                    for group in groups
                ]

            web_chunk_count = 0
            if enabled_web_source_types:
                web_chunks = await self.__try_load_web_chunks(main_task_id, hierarchy + [topic_str])
                content_chunks.extend(web_chunks)
                web_chunk_count = len(web_chunks)

            if not content_chunks and not enabled_web_source_types:
                continue

            topic_payloads.append({
                "topicIndex":      topic_index,
                "topicChain":      hierarchy + [topic_str],
                "hierarchy":       hierarchy,
                "topicStr":        topic_str,
                "contentChunks":   content_chunks,
                "pdfChunkCount":   len(chunk_list),
                "webChunkCount":   web_chunk_count,
            })

        # ── Compute the proper denominator across ALL topics (PDF + web). Guarantee
        #    sum(weights) == 1.0 by dividing each topic's chunk count by the global
        #    total. Falls back to uniform weights when no chunks exist anywhere.
        total_chunks_global = sum(
            payload["pdfChunkCount"] + payload["webChunkCount"]
            for payload in topic_payloads
        )

        if total_chunks_global <= 0:
            uniform_weight = 1.0 / len(topic_payloads) if topic_payloads else 0.0
            for payload in topic_payloads:
                payload["weight"] = uniform_weight
        else:
            for payload in topic_payloads:
                topic_chunk_count = payload["pdfChunkCount"] + payload["webChunkCount"]
                payload["weight"] = topic_chunk_count / total_chunks_global

        saved_count = 0
        for payload in topic_payloads:
            output_object = {
                "topicChain":             payload["topicChain"],
                "chunks":                 payload["contentChunks"],
                "weight":                 payload["weight"],
                "enabledWebSourceTypes":  enabled_web_source_types,
            }

            safe_unit  = sanitize_filename(payload["hierarchy"][0]) if payload["hierarchy"] else "Uncategorised"
            safe_topic = sanitize_filename(payload["topicStr"])

            file_path = join_path(
                "/",
                PersistenceConstants.TASKS_DIRECTORY,
                main_task_id,
                PersistenceConstants.MAPPED_TOPICS_DIRECTORY,
                safe_unit,
                f"{safe_topic}.json",
            )

            await Persistence.write(file_path, json.dumps(output_object, ensure_ascii=False))
            saved_count += 1

        return saved_count

    async def __select_relevant_reputed_domains(self, leaves: list) -> list:
        """
        Single LLM call that takes the syllabus's leaf topics and returns a small
        shortlist of relevant reputed domains. This collapses the per-topic web
        search from ~30 DDGS queries (every domain × every paraphrase) into ONE
        DDGS query against ≤8 already-relevant domains.

        Returns the shortlist (verbatim entries from ReputedSources.DOMAINS).
        On any failure, falls back to the top 6 ReputedSources.DOMAINS entries
        (LibreTexts, OpenStax, …) so the pipeline still makes forward progress.
        """
        candidate_domains = list(ReputedSources.DOMAINS)
        fallback_shortlist = candidate_domains[: MapTopicsWithContent.REPUTED_DOMAIN_SHORTLIST_MAX - 2]

        subject_name = (self.__general_generation_settings.get_subject_name() or "").strip() or "the subject"
        exam_name    = (self.__general_generation_settings.get_exam_name() or "").strip()
        exam_context = f"Exam context: {exam_name}." if exam_name else "Exam context: none specified."

        topic_lines = "\n".join(
            f"- {' > '.join(leaf['path'] + [leaf['topic']])}"
            for leaf in leaves[:80]
        )

        candidate_block = "\n".join(f"- {domain}" for domain in candidate_domains)

        model_string, provider_class = ModelPool.RELEVANT_DOMAINS_SELECTOR_MODEL
        caller = AutomationCaller(provider_class())

        request = AutomationRequest(
            model_string,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, PromptPool.RELEVANT_DOMAINS_SYSTEM),
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    PromptPool.RELEVANT_DOMAINS_USER
                        .replace("{subject_name}", subject_name)
                        .replace("{exam_context}", exam_context)
                        .replace("{topic_list}", topic_lines)
                        .replace("{candidate_domains}", candidate_block),
                ),
            ],
        )

        try:
            response = await caller.call(request, validator=None)
        except Exception as call_error:
            print(f"[MapTopicsWithContent] Domain-selection LLM call failed: {call_error}. Falling back to top domains.")
            return fallback_shortlist

        if response is None:
            print("[MapTopicsWithContent] Domain-selection LLM returned no response. Falling back to top domains.")
            return fallback_shortlist

        raw_text = response.get_output(0).get_data()
        parsed   = strip_json_markdown(raw_text)

        candidate_set = set(candidate_domains)
        picked: list = []

        if isinstance(parsed, dict):
            raw_domains = parsed.get("domains", [])
            if isinstance(raw_domains, list):
                for domain_entry in raw_domains:
                    if not isinstance(domain_entry, str):
                        continue
                    cleaned = domain_entry.strip().lower().lstrip("/")
                    if cleaned.startswith("http://"):
                        cleaned = cleaned[len("http://") :]
                    elif cleaned.startswith("https://"):
                        cleaned = cleaned[len("https://") :]
                    cleaned = cleaned.split("/")[0]
                    if cleaned in candidate_set and cleaned not in picked:
                        picked.append(cleaned)
                    if len(picked) >= MapTopicsWithContent.REPUTED_DOMAIN_SHORTLIST_MAX:
                        break

        if not picked:
            print("[MapTopicsWithContent] Domain-selection LLM gave no usable domains. Falling back to top domains.")
            return fallback_shortlist

        print(f"[MapTopicsWithContent] Reputed domain shortlist ({len(picked)}): {picked}")
        return picked

    async def __dispatch_web_fetches(
        self,
        main_task_id:              str,
        leaves:                    list,
        enabled_web_source_types:  list,
        reputed_domain_shortlist:  list,
    ) -> None:
        """
        Runs one FetchWebContent inline per leaf topic, with bounded concurrency.
        Each invocation writes Tasks/<id>/web_cache/topics/<hash>.json containing
        both text and locally-cached image references. Downstream workers
        (this same workflow's chunk loader and PrepareImages) read those files.
        """
        print(f"[MapTopicsWithContent] Dispatching web fetches for {len(leaves)} topic(s) "
              f"(sources={enabled_web_source_types}, reputed_domains={reputed_domain_shortlist}).")

        semaphore = asyncio.Semaphore(MapTopicsWithContent.WEB_FETCH_CONCURRENCY)

        # Subject grounds the query so a "Backtracking" leaf under an Algorithms
        # subject doesn't pull in LLM-safety papers or astroparticle-physics work
        # that happen to use the same word.
        subject_name = (self.__general_generation_settings.get_subject_name() or "").strip()

        async def fetch_one(leaf):
            topic_chain = leaf["path"] + [leaf["topic"]]
            query_terms = topic_chain[-3:] if len(topic_chain) > 3 else topic_chain
            base_query  = " ".join(query_terms).strip()
            query       = f"{subject_name} {base_query}".strip() if subject_name else base_query

            fetcher = FetchWebContent({
                "topicChain":      topic_chain,
                "query":           query,
                "subjectName":     subject_name,
                "enabledSources":  enabled_web_source_types,
                "pageBudget":      MapTopicsWithContent.WEB_FETCH_PAGE_BUDGET,
                "imageBudget":     MapTopicsWithContent.WEB_FETCH_IMAGE_BUDGET,
                "inlineMode":      True,
                "mainTaskId":      main_task_id,
                "reputedDomains":  reputed_domain_shortlist,
            })

            async with semaphore:
                try:
                    await fetcher.run()
                except Exception as fetch_error:
                    print(f"[MapTopicsWithContent] Web fetch failed for {topic_chain}: {fetch_error}")

        await asyncio.gather(*[fetch_one(leaf) for leaf in leaves], return_exceptions=False)

        print(f"[MapTopicsWithContent] Web fetches complete.")

    async def __try_load_web_chunks(self, main_task_id: str, topic_chain: list) -> list:
        """
        Best-effort load of pre-fetched web cache for a topic. Returns an empty list
        when no FETCH_WEB_CONTENT task has been run yet. Downstream workers can also
        re-read the cache themselves; this method is only an inline-injection helper.
        """
        import hashlib

        topic_chain_hash = hashlib.sha256(
            ("/".join(topic_chain)).encode("utf-8")
        ).hexdigest()[:24]

        cache_path = join_path(
            "/",
            PersistenceConstants.TASKS_DIRECTORY,
            main_task_id,
            "web_cache",
            "topics",
            f"{topic_chain_hash}.json",
        )

        try:
            cache_bytes = await Persistence.read(cache_path)
            cache_doc   = json.loads(cache_bytes.decode("utf-8"))
        except Exception:
            return []

        fetched_pages = cache_doc.get("fetched", []) or []
        if not fetched_pages:
            return []

        chunks = []
        for page in fetched_pages:
            page_text = (page.get("text") or "").strip()
            if not page_text:
                continue
            domain = page.get("domain") or "web"
            chunks.append(f"[Web: {domain}]\n{page_text}")
        return chunks
