import hashlib
import json
import os
import re
from datetime import datetime, timezone
from typing import List
from urllib.parse import urlparse

from Workflows.Workflow import Workflow
from Globals.Classes.Generic.Persistence import Persistence
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Classes.WebScraping.WebScraper import WebScraper
from Globals.Classes.WebScraping.WebContentFetcher import WebContentFetcher
from Globals.Classes.WebScraping.FetchedPage import FetchedPage
from Globals.Constants.PersistenceConstants import PersistenceConstants
from Globals.Constants.ReputedSources import ReputedSources
from Globals.Enumerations.InformationSourceTypes import InformationSourceTypes
from Globals.Utility.JoinPath import join_path


class FetchWebContent(Workflow):
    """
    Per-topic web fetch sub-task. Honors REPUTED / INTERNET source types; never
    touches the textEmbeddings or figures MongoDB collections. All output lives
    in per-task local files under Tasks/<mainTaskId>/web_cache/.
    """

    DEFAULT_PAGE_BUDGET             = 2
    DEFAULT_IMAGE_BUDGET            = 3
    WEB_CACHE_TOPICS_DIR            = "web_cache/topics"
    REPUTED_RESULT_LIMIT_PER_TOPIC  = 5
    INTERNET_RESULT_LIMIT_PER_TOPIC = 5
    MIN_KEYWORD_LENGTH              = 4
    KEYWORD_TOKEN_PATTERN           = re.compile(r"[A-Za-z][A-Za-z\-]+")
    STOPWORD_TOKENS = frozenset({
        "the", "and", "for", "with", "from", "into", "onto", "this", "that",
        "these", "those", "their", "there", "where", "which", "while", "what",
        "when", "than", "then", "have", "been", "being", "your", "yours",
        "unit", "chapter", "section", "part", "module", "lecture", "topic",
        "introduction", "introductory", "overview", "explained", "general",
        "method", "principle", "principles", "concept", "concepts",
        "techniques", "technique", "fundamentals", "foundation", "foundations",
        "advanced", "basic", "basics", "common", "various", "different",
        "examples", "example", "study", "studies",
    })

    def __init__(self, payload = {}):
        super().__init__(payload)
        self.__topic_chain     = payload.get("topicChain", [])
        self.__query           = payload.get("query") or " ".join(self.__topic_chain).strip()
        self.__subject_name    = (payload.get("subjectName") or "").strip()
        self.__enabled_sources = set(payload.get("enabledSources", []))
        self.__page_budget     = int(payload.get("pageBudget", FetchWebContent.DEFAULT_PAGE_BUDGET))
        self.__image_budget    = int(payload.get("imageBudget", FetchWebContent.DEFAULT_IMAGE_BUDGET))
        self.__inline_mode     = bool(payload.get("inlineMode", False))
        self.__main_task_id_override = payload.get("mainTaskId")
        self.__reputed_domains_override = payload.get("reputedDomains")

    @staticmethod
    def __extract_keywords(text_segments: List[str], min_length: int = None) -> set:
        """
        Lowercased, stopword-filtered, length-filtered token set used as the
        relevance signature for the current topic.

        For short subject names (e.g. acronyms like "DAA" / "OS"), pass
        min_length=2 so the token survives the filter — otherwise the subject
        gate would silently drop everything below the default length floor.
        """
        effective_min = min_length if min_length is not None else FetchWebContent.MIN_KEYWORD_LENGTH

        keywords: set = set()
        for segment in text_segments:
            if not segment:
                continue
            for raw_token in FetchWebContent.KEYWORD_TOKEN_PATTERN.findall(segment.lower()):
                if len(raw_token) < effective_min:
                    continue
                if raw_token in FetchWebContent.STOPWORD_TOKENS:
                    continue
                keywords.add(raw_token)
        return keywords

    @staticmethod
    def __score_result_against_keywords(result: dict, keywords: set) -> int:
        """
        Counts how many topic keywords appear in the result's URL slug, title,
        or snippet. Used as a cheap lexical relevance score.
        """
        if not keywords:
            return 0

        haystack_parts = [
            (result.get("url") or "").lower(),
            (result.get("title") or "").lower(),
            (result.get("snippet") or "").lower(),
        ]
        haystack = " ".join(haystack_parts)

        return sum(1 for keyword in keywords if keyword in haystack)

    def __filter_results_by_relevance(self, rich_results: List[dict]) -> List[dict]:
        """
        Keeps only results whose URL/title/snippet share at least one keyword
        with the topic chain AND, when a subject name is known, ALSO contain a
        keyword from the subject. Ranks survivors by (score desc, reputed-priority).
        Drops obvious off-topic hits before we pay for the page fetch.

        Without the subject gate, a "Backtracking" topic under "Algorithms" would
        otherwise admit LLM-safety arxiv papers that also use that word.
        """
        topic_keywords   = FetchWebContent.__extract_keywords(self.__topic_chain)
        subject_keywords = FetchWebContent.__extract_keywords([self.__subject_name], min_length=2)

        if not topic_keywords and not subject_keywords:
            return rich_results

        scored: list = []
        for result in rich_results:
            topic_score   = FetchWebContent.__score_result_against_keywords(result, topic_keywords)
            subject_score = FetchWebContent.__score_result_against_keywords(result, subject_keywords)

            if topic_keywords and topic_score <= 0:
                continue
            if subject_keywords and subject_score <= 0:
                continue

            scored.append((topic_score + subject_score, result))

        scored.sort(
            key=lambda entry: (
                -entry[0],
                ReputedSources.get_priority_rank(entry[1].get("url", "")),
            )
        )

        dropped = len(rich_results) - len(scored)
        if dropped > 0:
            print(f"[FetchWebContent] Relevance gate dropped {dropped}/{len(rich_results)} off-topic result(s) for {self.__topic_chain[-1] if self.__topic_chain else '?'}.")

        return [entry[1] for entry in scored]

    async def run(self, args = {}):
        main_task_id = self.__main_task_id_override or os.getenv("MAIN_TASK_ID")
        if not main_task_id:
            print("[FetchWebContent] No MAIN_TASK_ID — cannot persist web cache. Exiting.")
            return

        if not self.__query:
            print("[FetchWebContent] Empty query — nothing to fetch.")
            return

        if not self.__enabled_sources:
            print("[FetchWebContent] No web source types enabled. Exiting.")
            return

        print(f"[FetchWebContent] Topic chain: {self.__topic_chain}")
        print(f"[FetchWebContent] Enabled sources: {sorted(self.__enabled_sources)}")
        print(f"[FetchWebContent] Query: '{self.__query}', pageBudget={self.__page_budget}, imageBudget={self.__image_budget}")

        scraper = WebScraper()

        rich_results: List[dict] = []

        reputed_domains_to_use = (
            self.__reputed_domains_override
            if isinstance(self.__reputed_domains_override, list) and self.__reputed_domains_override
            else ReputedSources.DOMAINS
        )

        if InformationSourceTypes.REPUTED_EXTERNAL_SOURCES in self.__enabled_sources \
           or int(InformationSourceTypes.REPUTED_EXTERNAL_SOURCES) in self.__enabled_sources \
           or "REPUTED_EXTERNAL_SOURCES" in self.__enabled_sources:
            reputed_results = await scraper.search_scoped_rich(
                self.__query,
                reputed_domains_to_use,
                result_count = FetchWebContent.REPUTED_RESULT_LIMIT_PER_TOPIC,
            )
            rich_results.extend(reputed_results)

        if InformationSourceTypes.ANYWHERE_ON_THE_INTERNET in self.__enabled_sources \
           or int(InformationSourceTypes.ANYWHERE_ON_THE_INTERNET) in self.__enabled_sources \
           or "ANYWHERE_ON_THE_INTERNET" in self.__enabled_sources:
            internet_results = await scraper.search_rich(
                self.__query,
                result_count = FetchWebContent.INTERNET_RESULT_LIMIT_PER_TOPIC,
            )
            rich_results.extend(internet_results)

        seen_urls: set = set()
        deduped_results: list = []
        for result in rich_results:
            url = result.get("url") or ""
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)
            deduped_results.append(result)

        filtered_results = self.__filter_results_by_relevance(deduped_results)
        results_to_fetch = filtered_results[: self.__page_budget * 2]

        print(f"[FetchWebContent] Will fetch up to {len(results_to_fetch)} URL(s) (of {len(filtered_results)} relevant / {len(deduped_results)} total).")

        fetched_pages: List[FetchedPage] = []
        for result in results_to_fetch:
            if len(fetched_pages) >= self.__page_budget:
                break

            url = result.get("url") or ""
            if not url:
                continue

            page = await WebContentFetcher.fetch(
                url,
                main_task_id = main_task_id,
                image_limit  = self.__image_budget,
            )
            if page is None:
                continue

            fetched_pages.append(page)
            print(f"[FetchWebContent] Fetched {url} -> {len(page.get_text())} chars, {len(page.get_images())} image(s).")

        if not fetched_pages:
            print(f"[FetchWebContent] No pages fetched for topic chain {self.__topic_chain}.")
            await self.__write_output(main_task_id, fetched_pages)
            return

        await self.__write_output(main_task_id, fetched_pages)

        if self.__inline_mode:
            return

        task = await TaskManager.get_current_task()
        if task is not None:
            task.set_completion(1.0)
            await TaskManager.set_task(task)

    async def __write_output(self, main_task_id: str, fetched_pages: List[FetchedPage]) -> None:
        topic_chain_hash = hashlib.sha256(
            ("/".join(self.__topic_chain)).encode("utf-8")
        ).hexdigest()[:24]

        output_path = join_path(
            "/",
            PersistenceConstants.TASKS_DIRECTORY,
            main_task_id,
            FetchWebContent.WEB_CACHE_TOPICS_DIR,
            f"{topic_chain_hash}.json",
        )

        trimmed_pages = []
        for page in fetched_pages:
            page_json   = page.to_json()
            full_images = page_json.get("images", []) or []
            ranked_images = sorted(
                full_images,
                key = lambda image: (
                    0 if (image.get("captionText") or "").strip() else 1,
                    0 if image.get("isReputed") else 1,
                ),
            )
            page_json["images"] = ranked_images[: self.__image_budget]
            trimmed_pages.append(page_json)

        document = {
            "topicChain":  self.__topic_chain,
            "query":       self.__query,
            "fetched":     trimmed_pages,
            "fetchedAt":   datetime.now(timezone.utc).isoformat(),
        }

        await Persistence.write(output_path, json.dumps(document, ensure_ascii=False))
        print(f"[FetchWebContent] Wrote {output_path}")
