"""
End-to-end verification harness for the outbound-fetch safety of the web
scraping stack.

Run from the Agent directory:
    .venv/Scripts/python.exe Verification/VerifyWebFetchSafety.py    (Windows)
    .venv/bin/python Verification/VerifyWebFetchSafety.py            (Linux)

Two tiers, so the default run needs no network and no services:

  1. ALWAYS -- SafeUrlValidator's decisions on IP literals, schemes and ports;
     the per-hop redirect validation inside WebContentFetcher (driven against a
     throwaway local HTTP server with the validator stubbed to record every hop
     it is handed); the readable-text extraction; and the GenerateMockTests
     reference-material gating (PDF vs web page vs junk) with the fetch stubbed.
     Also asserts, at source level, that no workflow builds its own HTTP client
     -- that is the regression which opened the SSRF hole in the first place.

  2. NETWORK (opt-in: VERIFY_WEB_FETCH_NETWORK=1) -- resolves real public
     hostnames through SafeUrlValidator. Skipped by default so the harness stays
     runnable offline.
"""

import asyncio
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

# This harness lives in Agent/Verification/, so the Agent package root — the
# directory its `from Globals...` imports and the source-level regression scan
# below are both relative to — is one level up.
AGENT_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENT_DIRECTORY))

from Globals.Classes.WebScraping.SafeUrlValidator import SafeUrlValidator
from Globals.Classes.WebScraping.WebContentFetcher import WebContentFetcher


passed_count = 0
failed_count = 0
skipped_count = 0


def assert_that(condition: bool, description: str) -> None:
    global passed_count, failed_count
    if condition:
        passed_count += 1
        print(f"  PASS  {description}")
    else:
        failed_count += 1
        print(f"  FAIL  {description}")


def skip(description: str) -> None:
    global skipped_count
    skipped_count += 1
    print(f"  SKIP  {description}")


def section(title: str) -> None:
    print(f"\n=== {title} ===")


def assert_rejected(url: str, description: str) -> None:
    try:
        SafeUrlValidator.validate(url)
        assert_that(False, description)
    except SafeUrlValidator.UrlValidationError:
        assert_that(True, description)
    except Exception as unexpected_error:
        assert_that(False, f"{description} (unexpected {type(unexpected_error).__name__}: {unexpected_error})")


def verify_validator_rejections() -> None:
    section("SafeUrlValidator refuses internal and non-web targets (no DNS needed)")

    assert_rejected("http://127.0.0.1:80/Admin", "IPv4 loopback")
    assert_rejected("http://10.0.0.3/", "VPC private range 10/8")
    assert_rejected("http://192.168.1.1/", "private range 192.168/16")
    assert_rejected("http://172.16.0.5/", "private range 172.16/12")
    assert_rejected("http://169.254.169.254/latest/meta-data/", "link-local cloud metadata")
    assert_rejected("http://100.100.100.200/", "Alibaba metadata address")
    assert_rejected("http://0.0.0.0/", "unspecified address")
    assert_rejected("http://[::1]/", "IPv6 loopback")
    assert_rejected("http://[fd00:ec2::254]/", "IPv6 cloud metadata")
    assert_rejected("http://[::ffff:127.0.0.1]/", "IPv4-mapped loopback")
    assert_rejected("file:///etc/passwd", "file scheme")
    assert_rejected("gopher://example.com/", "gopher scheme")
    assert_rejected("http://127.0.0.1:6379/", "non-standard port (Redis)")
    assert_rejected("http://127.0.0.1:27017/", "non-standard port (Mongo)")
    assert_rejected("https://", "no hostname")

    section("SafeUrlValidator accepts a public IP literal")

    try:
        validated = SafeUrlValidator.validate("https://8.8.8.8/paper.pdf")
        assert_that(validated.connect_ip == "8.8.8.8", "public IPv4 literal validates and pins to itself")
        assert_that(validated.port == 443, "https defaults to port 443")
        assert_that(validated.is_ipv6 is False, "IPv4 literal is not flagged as IPv6")
    except SafeUrlValidator.UrlValidationError as validation_error:
        assert_that(False, f"public IPv4 literal validates ({validation_error})")


class RedirectChainHandler(BaseHTTPRequestHandler):
    """Serves /hop-0 -> /hop-1 -> /final, then a short body."""

    def do_GET(self):
        match = re.match(r"^/hop-(\d+)$", self.path)
        if match is not None:
            hop_index = int(match.group(1))
            next_path = f"/hop-{hop_index + 1}" if hop_index < 1 else "/final"
            self.send_response(302)
            self.send_header("Location", next_path)
            self.end_headers()
            return

        body = b"<html><head><title>T</title></head><body><nav>skip me</nav><p>final body</p></body></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        return


def verify_every_redirect_hop_is_validated() -> None:
    section("Every redirect hop is validated, and the connection is pinned")

    server = HTTPServer(("127.0.0.1", 0), RedirectChainHandler)
    server_port = server.server_address[1]
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    validated_urls = []
    original_validate = SafeUrlValidator.validate

    def recording_permissive_validate(url: str):
        # Stubbed permissive so the loopback test server is reachable; the point
        # of this test is that validate() is consulted for EVERY hop, which is
        # what stops a public URL from redirecting into the private network.
        validated_urls.append(url)
        return SafeUrlValidator.ValidatedTarget(
            scheme = "http",
            host = "127.0.0.1",
            port = server_port,
            connect_ip = "127.0.0.1",
            is_ipv6 = False,
        )

    original_allowed_ports = SafeUrlValidator.ALLOWED_PORTS
    original_default_ports = SafeUrlValidator.DEFAULT_PORT_BY_SCHEME

    try:
        SafeUrlValidator.validate = staticmethod(recording_permissive_validate)
        SafeUrlValidator.ALLOWED_PORTS = (80, 443, server_port)
        SafeUrlValidator.DEFAULT_PORT_BY_SCHEME = {"http": server_port, "https": 443}

        WebContentFetcher._WebContentFetcher__robots_cache.clear()

        fetched = asyncio.run(
            WebContentFetcher.fetch_document_bytes(f"http://127.0.0.1:{server_port}/hop-0")
        )

        assert_that(fetched is not None, "the redirect chain resolves to a body")

        # robots.txt + /hop-0 + /hop-1 + /final == 4 validated URLs.
        hop_urls = [url for url in validated_urls if "robots.txt" not in url]
        assert_that(len(hop_urls) == 3, f"validate() ran on every hop (got {len(hop_urls)}, expected 3)")
        assert_that(hop_urls[0].endswith("/hop-0"), "the first hop is the original URL")
        assert_that(hop_urls[-1].endswith("/final"), "the last hop is the final redirect target")

        if fetched is not None:
            body_bytes, content_type = fetched
            assert_that(content_type == "text/html", "content type is reported back to the caller")

            readable_text = WebContentFetcher.extract_readable_text(body_bytes)
            assert_that("final body" in readable_text, "extract_readable_text returns the page text")
            assert_that("skip me" not in readable_text, "extract_readable_text strips nav/chrome tags")
            assert_that(WebContentFetcher.extract_readable_text(b"") == "", "extract_readable_text tolerates empty bytes")

        # The HTML page path (flashcards / study material reading an ordinary
        # article) must be unchanged by the shared-helper refactor.
        WebContentFetcher._WebContentFetcher__page_cache.clear()
        page = asyncio.run(WebContentFetcher.fetch(f"http://127.0.0.1:{server_port}/final"))
        assert_that(page is not None, "fetch() still returns a page for an ordinary HTML URL")
        assert_that(page is not None and page.get_title() == "T", "fetch() still reads the page title")
        assert_that(page is not None and "final body" in page.get_text(), "fetch() still extracts the readable text")
        assert_that(page is not None and "skip me" not in page.get_text(), "fetch() still strips nav/chrome tags")
    finally:
        SafeUrlValidator.validate = original_validate
        SafeUrlValidator.ALLOWED_PORTS = original_allowed_ports
        SafeUrlValidator.DEFAULT_PORT_BY_SCHEME = original_default_ports
        WebContentFetcher._WebContentFetcher__robots_cache.clear()
        server.shutdown()
        server.server_close()


def verify_redirect_into_private_network_is_refused() -> None:
    section("A public URL that redirects into the private network is refused")

    server = HTTPServer(("127.0.0.1", 0), RedirectChainHandler)
    server_port = server.server_address[1]
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    original_validate = SafeUrlValidator.validate
    original_allowed_ports = SafeUrlValidator.ALLOWED_PORTS
    original_default_ports = SafeUrlValidator.DEFAULT_PORT_BY_SCHEME
    hop_count = {"value": 0}

    def first_hop_public_then_real_validate(url: str):
        # First hop pretends to be a public site (so the fetch starts), every
        # later hop goes through the REAL validator -- which is exactly the
        # redirect-to-internal attack.
        hop_count["value"] += 1
        if hop_count["value"] == 1:
            return SafeUrlValidator.ValidatedTarget(
                scheme = "http",
                host = "127.0.0.1",
                port = server_port,
                connect_ip = "127.0.0.1",
                is_ipv6 = False,
            )
        return original_validate(url)

    try:
        SafeUrlValidator.validate = staticmethod(first_hop_public_then_real_validate)
        SafeUrlValidator.ALLOWED_PORTS = (80, 443, server_port)
        SafeUrlValidator.DEFAULT_PORT_BY_SCHEME = {"http": server_port, "https": 443}

        WebContentFetcher._WebContentFetcher__robots_cache.clear()
        WebContentFetcher._WebContentFetcher__robots_cache["127.0.0.1"] = _permissive_robots_parser()

        fetched = asyncio.run(
            WebContentFetcher.fetch_document_bytes(f"http://127.0.0.1:{server_port}/hop-0")
        )

        assert_that(fetched is None, "the fetch returns None once a hop lands on a private address")
    finally:
        SafeUrlValidator.validate = original_validate
        SafeUrlValidator.ALLOWED_PORTS = original_allowed_ports
        SafeUrlValidator.DEFAULT_PORT_BY_SCHEME = original_default_ports
        WebContentFetcher._WebContentFetcher__robots_cache.clear()
        server.shutdown()
        server.server_close()


def _permissive_robots_parser():
    from urllib.robotparser import RobotFileParser
    parser = RobotFileParser()
    parser.parse([])
    return parser


def verify_reference_material_gating() -> None:
    section("GenerateMockTests reference-material gating (PDF vs page vs junk)")

    try:
        from Globals.Classes.Automation.AutomationContent import AutomationContent
        from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
        from Workflows.GenerateMockTests.GenerateMockTests import GenerateMockTests
    except Exception as import_error:
        skip(f"GenerateMockTests could not be imported ({import_error})")
        return

    build_reference_part = GenerateMockTests._GenerateMockTests__build_reference_part
    count_documents = GenerateMockTests._GenerateMockTests__count_documents

    pdf_bytes = b"%PDF-1.7\nfake question paper body"
    html_bytes = b"<html><body><nav>menu</nav><p>Question 1: define entropy.</p></body></html>"

    responses = {}
    original_fetch_document_bytes = WebContentFetcher.fetch_document_bytes

    async def stubbed_fetch_document_bytes(url: str):
        return responses.get(url)

    try:
        WebContentFetcher.fetch_document_bytes = staticmethod(stubbed_fetch_document_bytes)

        responses["https://example.com/paper.pdf"] = (pdf_bytes, "application/pdf")
        responses["https://example.com/mislabelled"] = (pdf_bytes, "application/octet-stream")
        responses["https://example.com/pyq-page"] = (html_bytes, "text/html")
        responses["https://example.com/logo.png"] = (b"\x89PNG fake", "image/png")
        responses["https://example.com/empty-page"] = (b"<html><body><nav>menu</nav></body></html>", "text/html")

        pdf_part = asyncio.run(build_reference_part("https://example.com/paper.pdf", allow_web_pages=False))
        assert_that(pdf_part is not None and pdf_part.get_content_type() == AutomationContentTypes.DOCUMENT,
                    "a PDF becomes a DOCUMENT part on the question-paper search leg")

        mislabelled_part = asyncio.run(build_reference_part("https://example.com/mislabelled", allow_web_pages=False))
        assert_that(mislabelled_part is not None and mislabelled_part.get_content_type() == AutomationContentTypes.DOCUMENT,
                    "a PDF mislabelled as octet-stream is still recognised by its magic bytes")

        page_on_search_leg = asyncio.run(build_reference_part("https://example.com/pyq-page", allow_web_pages=False))
        assert_that(page_on_search_leg is None,
                    "an HTML page from the filetype:pdf search is dropped as noise")

        page_on_pinned_leg = asyncio.run(build_reference_part("https://example.com/pyq-page", allow_web_pages=True))
        assert_that(page_on_pinned_leg is not None and page_on_pinned_leg.get_content_type() == AutomationContentTypes.TEXT,
                    "a user-pinned HTML page becomes a TEXT part (the GeeksforGeeks case)")
        assert_that(page_on_pinned_leg is not None and "define entropy" in page_on_pinned_leg.get_data(),
                    "the pinned page's readable text is carried through")
        assert_that(page_on_pinned_leg is not None and "menu" not in page_on_pinned_leg.get_data(),
                    "the pinned page's nav chrome is stripped")
        assert_that(page_on_pinned_leg is not None and "https://example.com/pyq-page" in page_on_pinned_leg.get_data(),
                    "the pinned page's TEXT part is labelled with its source URL")

        image_part = asyncio.run(build_reference_part("https://example.com/logo.png", allow_web_pages=True))
        assert_that(image_part is None, "an image is dropped even on the pinned leg")

        empty_part = asyncio.run(build_reference_part("https://example.com/empty-page", allow_web_pages=True))
        assert_that(empty_part is None, "a page with no readable text is dropped")

        blocked_part = asyncio.run(build_reference_part("http://127.0.0.1:3000/Admin", allow_web_pages=True))
        assert_that(blocked_part is None, "a URL the fetcher refuses yields no content part")

        mixed_parts = [
            AutomationContent(AutomationContentTypes.DOCUMENT, pdf_bytes),
            AutomationContent(AutomationContentTypes.TEXT, "page text"),
            AutomationContent(AutomationContentTypes.DOCUMENT, pdf_bytes),
        ]
        assert_that(count_documents(mixed_parts) == 2, "pdf_count counts only DOCUMENT parts")
        assert_that(count_documents([]) == 0, "pdf_count of an empty list is zero")

        verify_attempt_cap(GenerateMockTests)
    finally:
        WebContentFetcher.fetch_document_bytes = original_fetch_document_bytes


def verify_attempt_cap(generate_mock_tests_class) -> None:
    """
    A list of dead URLs must not translate into one request each: failures
    produce no content part, so only an explicit attempt cap bounds the fan-out.
    """
    from Globals.Classes.WebScraping.WebScraper import WebScraper

    attempted_urls = []

    async def failing_fetch_document_bytes(url: str):
        attempted_urls.append(url)
        return None

    async def empty_search(self, query, filters=None):
        return []

    original_search = WebScraper.search
    original_fetch = WebContentFetcher.fetch_document_bytes

    # Built without __init__ so the harness needs no task payload or settings.
    workflow = object.__new__(generate_mock_tests_class)
    workflow._GenerateMockTests__exam_name = "GATE"
    workflow._GenerateMockTests__subject_name = "Algorithms"

    original_collect = generate_mock_tests_class._GenerateMockTests__collect_specific_urls
    dead_urls = [f"https://example.com/dead-{url_index}.pdf" for url_index in range(50)]

    try:
        WebContentFetcher.fetch_document_bytes = staticmethod(failing_fetch_document_bytes)
        WebScraper.search = empty_search
        generate_mock_tests_class._GenerateMockTests__collect_specific_urls = lambda self: dead_urls

        max_documents = 5
        expected_cap = (max_documents * generate_mock_tests_class.REFERENCE_ATTEMPT_MULTIPLIER) + generate_mock_tests_class.REFERENCE_ATTEMPT_BASE_OVERHEAD

        parts = asyncio.run(workflow._GenerateMockTests__procure_reference_material(max_documents))

        assert_that(parts == [], "dead URLs produce no reference material")
        assert_that(
            len(attempted_urls) == expected_cap,
            f"50 dead pinned URLs are capped at {expected_cap} fetch attempts (made {len(attempted_urls)})",
        )
    finally:
        WebContentFetcher.fetch_document_bytes = original_fetch
        WebScraper.search = original_search
        generate_mock_tests_class._GenerateMockTests__collect_specific_urls = original_collect


def verify_no_workflow_builds_its_own_http_client() -> None:
    section("Regression guard: no workflow builds its own HTTP client")

    offenders = []
    allowed_files = {
        AGENT_DIRECTORY / "Globals" / "Classes" / "WebScraping" / "WebContentFetcher.py",
        AGENT_DIRECTORY / "Globals" / "Classes" / "Automation" / "Providers" / "GoogleEnterpriseAiProvider.py",
    }

    client_pattern = re.compile(r"httpx\.(AsyncClient|Client|get|post|stream)|requests\.(get|post)|aiohttp\.ClientSession")

    for python_file in AGENT_DIRECTORY.rglob("*.py"):
        if ".venv" in python_file.parts or python_file.name == Path(__file__).name:
            continue
        if python_file in allowed_files:
            continue

        try:
            source_text = python_file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        if client_pattern.search(source_text) is not None:
            offenders.append(str(python_file.relative_to(AGENT_DIRECTORY)))

    assert_that(
        len(offenders) == 0,
        f"only WebContentFetcher (and the LLM provider) construct HTTP clients{'' if not offenders else ' -- offenders: ' + ', '.join(offenders)}",
    )


def verify_network_tier() -> None:
    section("Network tier (opt-in: VERIFY_WEB_FETCH_NETWORK=1)")

    if os.getenv("VERIFY_WEB_FETCH_NETWORK") != "1":
        skip("real public hostname resolves and validates")
        skip("a hostname that does not resolve is refused")
        return

    try:
        validated = SafeUrlValidator.validate("https://www.geeksforgeeks.org/")
        assert_that(validated.host == "www.geeksforgeeks.org", "real public hostname resolves and validates")
    except SafeUrlValidator.UrlValidationError as validation_error:
        assert_that(False, f"real public hostname resolves and validates ({validation_error})")

    assert_rejected("https://this-host-should-not-exist.invalid/", "a hostname that does not resolve is refused")


def main() -> int:
    print(f"Verifying web-fetch safety (Agent at {AGENT_DIRECTORY})")

    verify_validator_rejections()
    verify_every_redirect_hop_is_validated()
    verify_redirect_into_private_network_is_refused()
    verify_reference_material_gating()
    verify_no_workflow_builds_its_own_http_client()
    verify_network_tier()

    print("\n=== Summary ===")
    print(f"  passed:  {passed_count}")
    print(f"  failed:  {failed_count}")
    print(f"  skipped: {skipped_count}")

    return 0 if failed_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
