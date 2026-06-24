from typing import List

from ddgs import DDGS

from Globals.Classes.WebScraping.ScrapeFilter import ScrapeFilter
from Globals.Constants.ReputedSources import ReputedSources
from Globals.Enumerations.ScrapeFilterTypes import ScrapeFilterTypes


class WebScraper:

    DEFAULT_MAX_RESULTS_PER_PASS = 10
    MAX_SITE_OPERATORS_PER_QUERY = 10
    DEFAULT_MAX_IMAGE_RESULTS    = 6
    IMAGE_URL_EXTENSIONS         = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg")

    def __init__(self):
        pass

    async def search(self, query: str, filters: list = None) -> List[str]:
        """
        Single-pass DDGS search. Applies the standard filter set verbatim.
        Returns a list of URLs ordered by reputed-domain priority then first-seen.
        """
        filters = filters or []
        return await self.__single_pass_search(query, filters, scoped_domains=None)

    async def search_scoped(
        self,
        query:        str,
        domains:      List[str],
        result_count: int = None,
    ) -> List[str]:
        """
        Domain-scoped single-pass DDGS search. Builds a single OR-of-site: query
        against the provided pre-filtered domain list. The caller is responsible
        for keeping the list to <= MAX_SITE_OPERATORS_PER_QUERY entries; longer
        lists are truncated rather than fanned out into multiple queries.

        domains: ordered list — earlier entries rank higher in the result set.
        result_count: hard cap on returned URLs.

        Returns URLs ordered by reputed-domain priority (per ReputedSources.DOMAINS).
        """
        effective_count = result_count or WebScraper.DEFAULT_MAX_RESULTS_PER_PASS

        if not domains:
            return await self.search(query, filters=[ScrapeFilter(ScrapeFilterTypes.RESULT_COUNT, str(effective_count))])

        capped_domains = domains[: WebScraper.MAX_SITE_OPERATORS_PER_QUERY]
        filters = [ScrapeFilter(ScrapeFilterTypes.RESULT_COUNT, str(effective_count))]
        return await self.__single_pass_search(query, filters, scoped_domains=capped_domains)

    async def search_rich(self, query: str, result_count: int = None) -> List[dict]:
        """
        Like search() but returns rich result dicts (url, title, snippet) so the
        caller can apply lexical relevance filtering before paying the cost of a
        full page fetch.
        """
        effective_count = result_count or WebScraper.DEFAULT_MAX_RESULTS_PER_PASS
        return self.__run_ddgs_rich(query, effective_count)

    async def search_images(self, query: str, result_count: int = None) -> List[dict]:
        """
        DDGS image search. Returns a deduped list of image result dicts
        ({imageUrl, thumbnailUrl, sourceUrl, title}) for the AskAi feature —
        the Pro / Pro Plus prompt embeds the direct URLs inline and the
        result view also renders them as a thumbnail strip. Only http(s)
        URLs that point at a real image file (by extension) survive, so a
        hostile or non-image link never reaches the browser. Failures
        degrade to [] rather than aborting the reply.
        """
        effective_count = result_count or WebScraper.DEFAULT_MAX_IMAGE_RESULTS
        return self.__run_ddgs_images(query, effective_count)

    async def search_scoped_rich(
        self,
        query:        str,
        domains:      List[str],
        result_count: int = None,
    ) -> List[dict]:
        """
        Domain-scoped rich search. Same shape as search_rich. Returns dicts.
        """
        effective_count = result_count or WebScraper.DEFAULT_MAX_RESULTS_PER_PASS
        if not domains:
            return await self.search_rich(query, result_count=effective_count)

        capped_domains = domains[: WebScraper.MAX_SITE_OPERATORS_PER_QUERY]
        site_clauses   = " OR ".join(f"site:{domain}" for domain in capped_domains)
        composed_query = f"{query.strip()} ({site_clauses})"
        return self.__run_ddgs_rich(composed_query, effective_count)

    async def __single_pass_search(
        self,
        query:          str,
        filters:        list,
        scoped_domains: List[str] = None,
    ) -> List[str]:
        max_results      = WebScraper.DEFAULT_MAX_RESULTS_PER_PASS
        target_extension = None
        suffix_to_query: list = []

        for filter_entry in filters:
            if not filter_entry.is_valid() and filter_entry.get_filter_type() != ScrapeFilterTypes.RESULT_COUNT:
                continue

            filter_type = filter_entry.get_filter_type()
            value       = filter_entry.get_value()

            if filter_type == ScrapeFilterTypes.EXTENSION:
                target_extension = value.lower().strip(".")
                suffix_to_query.append(f"filetype:{target_extension}")
            elif filter_type == ScrapeFilterTypes.RESULT_COUNT:
                try:
                    max_results = int(value)
                except (ValueError, TypeError):
                    pass
            elif filter_type == ScrapeFilterTypes.SITE:
                suffix_to_query.append(f"site:{value}")
            elif filter_type == ScrapeFilterTypes.EXCLUDE_WORD:
                suffix_to_query.append(f"-{value}")
            elif filter_type == ScrapeFilterTypes.EXACT_PHRASE:
                suffix_to_query.append(f'"{value}"')
            elif filter_type == ScrapeFilterTypes.TITLE:
                suffix_to_query.append(f"intitle:{value}")
            elif filter_type == ScrapeFilterTypes.URL_MATCH:
                suffix_to_query.append(f"inurl:{value}")

        composed_query_parts = [query.strip()]
        composed_query_parts.extend(suffix_to_query)

        if scoped_domains:
            site_clauses = " OR ".join(f"site:{domain}" for domain in scoped_domains)
            composed_query_parts.append(f"({site_clauses})")

        composed_query = " ".join(part for part in composed_query_parts if part)

        pass_links = self.__run_ddgs(composed_query, max_results, target_extension)
        reputed_count = sum(1 for link in pass_links if ReputedSources.is_reputed_domain(link))
        print(f"[WebScraper] pass \"{composed_query}\" -> {len(pass_links)} URLs ({reputed_count} reputed)")

        url_to_first_seen: dict = {}
        for ordinal_index, url in enumerate(pass_links):
            if url not in url_to_first_seen:
                url_to_first_seen[url] = ordinal_index

        ranked = sorted(
            url_to_first_seen.items(),
            key=lambda entry: (ReputedSources.get_priority_rank(entry[0]), entry[1]),
        )

        return [url for url, _ in ranked]

    def __run_ddgs_rich(self, query: str, max_results: int) -> List[dict]:
        rich_results: List[dict] = []
        seen: set = set()

        try:
            with DDGS() as ddgs:
                results_generator = ddgs.text(
                    query,
                    region     = "wt-wt",
                    safesearch = "moderate",
                    max_results= max_results,
                )

                for result in results_generator:
                    url = result.get("href", "") or result.get("url", "")
                    if not url or url in seen:
                        continue
                    seen.add(url)

                    rich_results.append({
                        "url":     url,
                        "title":   result.get("title", "") or "",
                        "snippet": result.get("body", "") or "",
                    })

                    if len(rich_results) >= max_results:
                        break
        except Exception as search_error:
            print(f"[WebScraper] DDGS error on query \"{query}\": {search_error}")

        reputed_count = sum(1 for entry in rich_results if ReputedSources.is_reputed_domain(entry["url"]))
        print(f"[WebScraper] rich pass \"{query}\" -> {len(rich_results)} URLs ({reputed_count} reputed)")
        return rich_results

    def __run_ddgs_images(self, query: str, max_results: int) -> List[dict]:
        image_results: List[dict] = []
        seen: set = set()

        try:
            with DDGS() as ddgs:
                results_generator = ddgs.images(
                    query,
                    region     = "wt-wt",
                    safesearch = "moderate",
                    max_results= max_results * 3,
                )

                for result in results_generator:
                    image_url = result.get("image", "") or ""
                    if not image_url or image_url in seen:
                        continue
                    if not WebScraper.__is_direct_image_url(image_url):
                        continue
                    seen.add(image_url)

                    image_results.append({
                        "imageUrl":     image_url,
                        "thumbnailUrl": result.get("thumbnail", "") or "",
                        "sourceUrl":    result.get("url", "") or "",
                        "title":        result.get("title", "") or "",
                    })

                    if len(image_results) >= max_results:
                        break
        except Exception as search_error:
            print(f"[WebScraper] DDGS image error on query \"{query}\": {search_error}")

        print(f"[WebScraper] image pass \"{query}\" -> {len(image_results)} images")
        return image_results

    @staticmethod
    def __is_direct_image_url(image_url: str) -> bool:
        """
        True only for an http(s) URL whose path ends in a real image
        extension. DDGS occasionally returns redirect / tracking links or
        HTML pages under the "image" key; those would render as a broken
        thumbnail, so they're dropped here before reaching the browser.
        """
        lowered = image_url.lower()
        if not lowered.startswith(("http://", "https://")):
            return False
        path_without_query = lowered.split("?")[0]
        return path_without_query.endswith(WebScraper.IMAGE_URL_EXTENSIONS)

    def __run_ddgs(self, query: str, max_results: int, target_extension: str) -> List[str]:
        links: List[str] = []
        seen:  set       = set()

        try:
            with DDGS() as ddgs:
                results_generator = ddgs.text(
                    query,
                    region     = "wt-wt",
                    safesearch = "moderate",
                    max_results= max_results * 2 if target_extension else max_results,
                )

                for result in results_generator:
                    url = result.get("href", "") or result.get("url", "")
                    if not url or url in seen:
                        continue
                    seen.add(url)

                    if target_extension:
                        clean_url = url.split("?")[0].lower()
                        blocked_extensions = (".html", ".htm", ".php", ".asp", ".aspx")
                        if any(clean_url.endswith(blocked) for blocked in blocked_extensions):
                            continue

                    links.append(url)

                    if len(links) >= max_results:
                        break
        except Exception as search_error:
            print(f"[WebScraper] DDGS error on query \"{query}\": {search_error}")

        return links
