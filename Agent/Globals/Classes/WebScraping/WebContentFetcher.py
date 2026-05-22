import asyncio
import hashlib
import os
import time
from typing import List
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser

import httpx
from bs4 import BeautifulSoup
from tenacity import AsyncRetrying, retry_if_exception_type, stop_after_attempt, wait_exponential_jitter

from Globals.Classes.Generic.Persistence import Persistence
from Globals.Classes.WebScraping.FetchedImage import FetchedImage
from Globals.Classes.WebScraping.FetchedPage import FetchedPage
from Globals.Constants.PersistenceConstants import PersistenceConstants
from Globals.Utility.JoinPath import join_path


class WebContentFetcher:

    PAGE_TIMEOUT_SECONDS               = 20.0
    IMAGE_TIMEOUT_SECONDS              = 15.0
    MIN_IMAGE_DIMENSION_PX             = 100
    MAX_PAGE_TEXT_CHARS                = 12000
    IMAGE_ATTEMPT_MULTIPLIER           = 3
    IMAGE_ATTEMPT_BASE_OVERHEAD        = 5
    CONSECUTIVE_IMAGE_FAILURE_STREAK_CAP = 3
    DIRECTORYLIKE_EXTENSIONS           = (".html", ".htm", ".php", ".asp", ".aspx", ".jsp", ".cgi", ".pdf", ".txt", ".xml", ".json")
    SKIP_TAGS                          = ("script", "style", "nav", "footer", "header", "aside", "noscript")
    SKIP_IMAGE_HOST_HINTS   = (
        "doubleclick.net",
        "googletagmanager.com",
        "googletagservices.com",
        "google-analytics.com",
        "facebook.com/tr",
        "facebook.net",
        "scorecardresearch.com",
        "adservice.google.com",
        "ads.",
        "analytics.",
        "tracking.",
        "pixel.",
        "newrelic.com",
    )
    IMAGE_EXTENSION_BY_MIME = {
        "image/png":    ".png",
        "image/jpeg":   ".jpg",
        "image/jpg":    ".jpg",
        "image/gif":    ".gif",
        "image/webp":   ".webp",
        "image/svg+xml":".svg",
        "image/bmp":    ".bmp",
        "image/tiff":   ".tif",
    }

    __domain_locks: dict = {}
    __domain_last_fetched: dict = {}
    __robots_cache: dict = {}
    __robots_lock = asyncio.Lock()
    __page_cache: dict = {}
    __page_cache_locks: dict = {}

    @staticmethod
    def __user_agent() -> str:
        contact_email = os.getenv("WEB_SCRAPE_CONTACT_EMAIL", "contact@mindmeld.local")
        return f"MindMeld/1.0 (educational research; {contact_email})"

    @staticmethod
    def __rate_limit_seconds() -> float:
        try:
            return float(os.getenv("WEB_SCRAPE_DOMAIN_RATE_LIMIT_SECONDS", "0.4"))
        except (ValueError, TypeError):
            return 0.4

    @staticmethod
    def __domain_of(url: str) -> str:
        return (urlparse(url).hostname or "").lower()

    @staticmethod
    async def __get_domain_lock(domain: str) -> asyncio.Lock:
        if domain not in WebContentFetcher.__domain_locks:
            WebContentFetcher.__domain_locks[domain] = asyncio.Lock()
        return WebContentFetcher.__domain_locks[domain]

    @staticmethod
    async def __wait_for_rate_limit(domain: str) -> None:
        rate_limit = WebContentFetcher.__rate_limit_seconds()
        last_fetched = WebContentFetcher.__domain_last_fetched.get(domain, 0.0)
        elapsed = time.time() - last_fetched
        if elapsed < rate_limit:
            await asyncio.sleep(rate_limit - elapsed)
        WebContentFetcher.__domain_last_fetched[domain] = time.time()

    @staticmethod
    async def __is_allowed_by_robots(url: str) -> bool:
        domain = WebContentFetcher.__domain_of(url)
        if not domain:
            return False

        async with WebContentFetcher.__robots_lock:
            if domain not in WebContentFetcher.__robots_cache:
                robots_url = f"{urlparse(url).scheme}://{domain}/robots.txt"
                parser     = RobotFileParser()
                parser.set_url(robots_url)

                try:
                    async with httpx.AsyncClient(timeout=10.0) as client:
                        response = await client.get(robots_url, headers={"User-Agent": WebContentFetcher.__user_agent()})
                        if response.status_code == 200:
                            parser.parse(response.text.splitlines())
                        else:
                            # No robots.txt or unreadable — be permissive but log it
                            parser.parse([])
                except Exception as robots_error:
                    print(f"[WebContentFetcher] Could not fetch robots.txt for {domain}: {robots_error} — treating as permissive.")
                    parser.parse([])

                WebContentFetcher.__robots_cache[domain] = parser

        return WebContentFetcher.__robots_cache[domain].can_fetch(WebContentFetcher.__user_agent(), url)

    @staticmethod
    async def __fetch_url_bytes(url: str, timeout_seconds: float) -> tuple[bytes, str] | None:
        """
        Returns (bytes, content_type) or None on failure.
        Applies robots.txt + per-domain rate limit before requesting.
        Retries 3 times on 5xx/network errors via tenacity; never retries on 4xx.
        """
        domain = WebContentFetcher.__domain_of(url)
        if not domain:
            return None

        allowed = await WebContentFetcher.__is_allowed_by_robots(url)
        if not allowed:
            print(f"[WebContentFetcher] robots.txt disallow for {url} — skipping fetch.")
            return None

        domain_lock = await WebContentFetcher.__get_domain_lock(domain)

        async with domain_lock:
            await WebContentFetcher.__wait_for_rate_limit(domain)

            attempts = 0
            try:
                async for attempt in AsyncRetrying(
                    stop  = stop_after_attempt(3),
                    wait  = wait_exponential_jitter(initial=1.0, max=8.0),
                    retry = retry_if_exception_type((httpx.TransportError, httpx.ReadTimeout, httpx.ConnectTimeout)),
                    reraise = True,
                ):
                    with attempt:
                        attempts += 1
                        async with httpx.AsyncClient(
                            follow_redirects = True,
                            timeout          = timeout_seconds,
                            headers          = {"User-Agent": WebContentFetcher.__user_agent()},
                        ) as client:
                            response = await client.get(url)

                            if response.status_code >= 500:
                                # Retryable
                                raise httpx.TransportError(f"HTTP {response.status_code}")
                            if response.status_code >= 400:
                                # Non-retryable — bail
                                print(f"[WebContentFetcher] HTTP {response.status_code} on {url} — not retrying.")
                                return None

                            content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
                            return (response.content, content_type)
            except Exception as fetch_error:
                print(f"[WebContentFetcher] Final failure on {url} after {attempts} attempt(s): {fetch_error}")
                return None

        return None

    @staticmethod
    def __dimension_from_attr(value) -> int:
        if value is None:
            return None
        try:
            cleaned = str(value).strip().rstrip("px").strip()
            return int(float(cleaned))
        except (ValueError, TypeError):
            return None

    @staticmethod
    def __is_skippable_image_host(image_url: str) -> bool:
        host = WebContentFetcher.__domain_of(image_url)
        return any(skip_hint in host for skip_hint in WebContentFetcher.SKIP_IMAGE_HOST_HINTS)

    @staticmethod
    def __extract_caption_for_image(image_tag) -> str:
        """
        Returns the best caption text for an <img> tag, in priority order:
          1. parent <figure>'s <figcaption>
          2. img alt
          3. parent block's leading paragraph if short (<200 chars)
        """
        figure_parent = image_tag.find_parent("figure")
        if figure_parent is not None:
            figcaption = figure_parent.find("figcaption")
            if figcaption is not None:
                caption_text = figcaption.get_text(separator=" ", strip=True)
                if caption_text:
                    return caption_text

        alt_text = (image_tag.get("alt") or "").strip()
        if alt_text:
            return alt_text

        parent = image_tag.parent
        if parent is not None:
            for sibling in parent.find_all("p", limit=1):
                sibling_text = sibling.get_text(separator=" ", strip=True)
                if sibling_text and len(sibling_text) < 200:
                    return sibling_text

        return ""

    @staticmethod
    def __compute_base_url_for_relative_resolution(soup, page_url: str) -> str:
        """
        Returns the URL that relative image src= values should resolve against.
        Honors <base href> when present. Otherwise, if the page URL has no
        trailing slash AND its last path segment doesn't end in a known file
        extension, append a trailing slash so that `urljoin(base, "x8.png")`
        produces "<page-dir>/x8.png" instead of dropping the last segment
        (the arxiv-html-paper case).
        """
        base_tag = soup.find("base")
        if base_tag and base_tag.get("href"):
            return urljoin(page_url, base_tag.get("href"))

        if page_url.endswith("/"):
            return page_url

        parsed     = urlparse(page_url)
        path       = parsed.path or "/"
        last_segment = path.rsplit("/", 1)[-1].lower()

        if last_segment and not any(last_segment.endswith(extension) for extension in WebContentFetcher.DIRECTORYLIKE_EXTENSIONS):
            return page_url + "/"

        return page_url

    @staticmethod
    async def __extract_and_cache_images(
        soup,
        page_url:     str,
        main_task_id: str,
        image_limit:  int = None,
    ) -> List[FetchedImage]:
        if not main_task_id:
            return []

        cache_directory = join_path(
            "/",
            PersistenceConstants.TASKS_DIRECTORY,
            main_task_id,
            "web_cache",
            "images",
        )

        fetched_images: List[FetchedImage] = []
        seen_local_paths: set = set()
        attempts_made    = 0
        consecutive_failures = 0

        attempt_cap = None
        if image_limit is not None:
            attempt_cap = (image_limit * WebContentFetcher.IMAGE_ATTEMPT_MULTIPLIER) + WebContentFetcher.IMAGE_ATTEMPT_BASE_OVERHEAD

        base_url_for_relatives = WebContentFetcher.__compute_base_url_for_relative_resolution(soup, page_url)
        image_tags = soup.find_all("img")

        for image_tag in image_tags:
            if image_limit is not None and len(fetched_images) >= image_limit:
                break
            if attempt_cap is not None and attempts_made >= attempt_cap:
                print(f"[WebContentFetcher] Image attempt cap ({attempt_cap}) reached for {page_url} — stopping.")
                break
            if consecutive_failures >= WebContentFetcher.CONSECUTIVE_IMAGE_FAILURE_STREAK_CAP:
                # When several image URLs fail in a row, the page's relative-URL
                # base is almost certainly wrong (arxiv's HTML papers are notorious
                # for this — the <img src> values disagree with their own <base>).
                # Bail rather than burn through every <img> on the page.
                print(f"[WebContentFetcher] {consecutive_failures} consecutive image failures on {page_url} — aborting image extraction for this page.")
                break
            raw_src = (image_tag.get("src") or image_tag.get("data-src") or "").strip()
            if not raw_src or raw_src.startswith("data:"):
                continue

            absolute_src = urljoin(base_url_for_relatives, raw_src)
            if WebContentFetcher.__is_skippable_image_host(absolute_src):
                continue

            width_hint  = WebContentFetcher.__dimension_from_attr(image_tag.get("width"))
            height_hint = WebContentFetcher.__dimension_from_attr(image_tag.get("height"))

            if (width_hint is not None and width_hint < WebContentFetcher.MIN_IMAGE_DIMENSION_PX) \
            or (height_hint is not None and height_hint < WebContentFetcher.MIN_IMAGE_DIMENSION_PX):
                continue

            attempts_made += 1
            fetched = await WebContentFetcher.__fetch_url_bytes(absolute_src, WebContentFetcher.IMAGE_TIMEOUT_SECONDS)
            if fetched is None:
                consecutive_failures += 1
                continue

            image_bytes, content_type = fetched
            if not image_bytes or len(image_bytes) < 1024:
                consecutive_failures += 1
                continue

            consecutive_failures = 0

            digest    = hashlib.sha256(image_bytes).hexdigest()
            extension = WebContentFetcher.IMAGE_EXTENSION_BY_MIME.get(content_type, "")
            if not extension:
                # Try the URL path as a last resort
                url_path_ext = os.path.splitext(urlparse(absolute_src).path)[1].lower()
                if url_path_ext in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".tif", ".tiff"):
                    extension = url_path_ext
                else:
                    extension = ".bin"

            local_cache_path = join_path("/", cache_directory, f"{digest}{extension}")

            if local_cache_path in seen_local_paths:
                continue
            seen_local_paths.add(local_cache_path)

            try:
                await Persistence.write(local_cache_path, image_bytes)
            except Exception as write_error:
                print(f"[WebContentFetcher] Could not write image {absolute_src}: {write_error}")
                continue

            caption_text = WebContentFetcher.__extract_caption_for_image(image_tag)

            fetched_images.append(FetchedImage(
                source_url       = absolute_src,
                page_url         = page_url,
                caption_text     = caption_text,
                local_cache_path = local_cache_path,
                content_type     = content_type,
                width_hint       = width_hint,
                height_hint      = height_hint,
            ))

        return fetched_images

    @staticmethod
    async def fetch(url: str, main_task_id: str = None, image_limit: int = None) -> FetchedPage | None:
        """
        Fetches a web page, extracts its readable text, downloads up to image_limit
        relevant images, and returns a FetchedPage. Returns None on failure.

        If main_task_id is None, images are NOT downloaded (text-only mode).
        Per-task page cache dedupes the same URL across parallel topic fetches.
        """
        cache_key = (main_task_id, url)
        existing_lock = WebContentFetcher.__page_cache_locks.get(cache_key)
        if existing_lock is None:
            existing_lock = asyncio.Lock()
            WebContentFetcher.__page_cache_locks[cache_key] = existing_lock

        async with existing_lock:
            if cache_key in WebContentFetcher.__page_cache:
                return WebContentFetcher.__page_cache[cache_key]

            fetched = await WebContentFetcher.__fetch_url_bytes(url, WebContentFetcher.PAGE_TIMEOUT_SECONDS)
            if fetched is None:
                WebContentFetcher.__page_cache[cache_key] = None
                return None

            body_bytes, content_type = fetched

            if "html" not in content_type and "xml" not in content_type:
                try:
                    decoded_text = body_bytes.decode("utf-8", errors="replace")
                except Exception:
                    decoded_text = ""
                plain_page = FetchedPage(url=url, text=decoded_text)
                WebContentFetcher.__page_cache[cache_key] = plain_page
                return plain_page

            soup = BeautifulSoup(body_bytes, "html.parser")

            title_tag = soup.find("title")
            page_title = title_tag.get_text(strip=True) if title_tag else None

            for tag_name in WebContentFetcher.SKIP_TAGS:
                for element in soup(tag_name):
                    element.decompose()

            text_lines = [line.strip() for line in soup.get_text(separator="\n").splitlines() if line.strip()]
            readable_text = "\n".join(text_lines)
            if len(readable_text) > WebContentFetcher.MAX_PAGE_TEXT_CHARS:
                readable_text = readable_text[: WebContentFetcher.MAX_PAGE_TEXT_CHARS] + "\n…[truncated]"

            images: List[FetchedImage] = []
            if main_task_id:
                try:
                    images = await WebContentFetcher.__extract_and_cache_images(
                        soup, url, main_task_id, image_limit=image_limit,
                    )
                except Exception as image_error:
                    print(f"[WebContentFetcher] Image extraction failed for {url}: {image_error}")

            page = FetchedPage(
                url    = url,
                text   = readable_text,
                title  = page_title,
                images = images,
            )
            WebContentFetcher.__page_cache[cache_key] = page
            return page

    @staticmethod
    async def fetch_text_only(url: str) -> str:
        """
        Convenience wrapper that returns just the cleaned readable text or empty string.
        Used by callers (e.g., GeminiProvider) that don't need image extraction.
        """
        page = await WebContentFetcher.fetch(url, main_task_id=None)
        return page.get_text() if page is not None else ""
