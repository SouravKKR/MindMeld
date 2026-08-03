import math
import os
import json

from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.AutomationResponse import AutomationResponse
from Globals.Classes.Automation.Pools.ModelPool import ModelPool
from Globals.Classes.Automation.Pools.PromptPool import PromptPool
from Globals.Classes.Generic.Persistence import Persistence
from Globals.Classes.Task.AutoGeneration.MockTestGenerationSettings import MockTestGenerationSettings
from Globals.Classes.Task.TaskDescriptor import TaskDescriptor
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Classes.WebScraping.WebContentFetcher import WebContentFetcher
from Globals.Classes.WebScraping.WebScraper import WebScraper
from Globals.Classes.WebScraping.ScrapeFilter import ScrapeFilter
from Globals.Constants.PersistenceConstants import PersistenceConstants
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Enumerations.AutomationLevels import AutomationLevels
from Globals.Enumerations.InformationSourceTypes import InformationSourceTypes
from Globals.Enumerations.ScrapeFilterTypes import ScrapeFilterTypes
from Globals.Enumerations.TaskExecutionTargets import TaskExecutionTargets
from Globals.Enumerations.TaskTypes import TaskTypes
from Globals.Utility.JoinPath import join_path
from Globals.Utility.SanitizeFilename import sanitize_filename
from Globals.Utility.StripJsonMarkdown import strip_json_markdown
from Workflows.MapTopicsWithContent.ChunkUtils import extract_leaves
from Workflows.Workflow import Workflow
from Globals.Utility.RedactSourceName import redact_source_name


# PYQ harvest is capped to bound LLM cost. ~50 questions across 5 PDFs is
# enough seed material to give the rephrase pass meaningful variety.
PYQ_POOL_MAX_QUESTIONS = 50
PYQ_HARVEST_MAX_PDFS   = 5


# questionsRepeatChance returned by the LLM is capped at this value.
# Even board exams should not reuse 100% of questions.
MAX_REPEAT_CHANCE = 0.7


class GenerateMockTests(Workflow):

    NUM_GROUPS = 5

    # Cap the unique-question pool the worker generates at 2× the per-test
    # count. With high `numberOfTests` × low `questionsRepeatChance` the
    # original formula could fan out into a ~600-question pool for a
    # 4-test NEET (200 × 4 × 0.5 ≈ 400 + base 200 = 600), inflating LLM
    # cost and risking quota. The tests still get their full count via
    # the worker's repeat-fill logic; we just stop generating endless
    # *unique* extras nobody will see.
    MAX_POOL_TO_PER_TEST_RATIO = 2

    # Reference-material content gating. A question paper is a PDF; anything
    # else the PDF search returns is a landing or error page. Some servers
    # mislabel a real PDF (octet-stream, or even text/html), so the magic
    # prefix is checked alongside the declared type.
    PDF_CONTENT_TYPES = ("application/pdf", "application/x-pdf")
    PDF_MAGIC_PREFIX = b"%PDF-"
    WEB_PAGE_CONTENT_TYPES = ("text/html", "application/xhtml+xml", "text/plain")

    # A failed fetch yields no content part, so counting only successes would let
    # a list of dead URLs drive one request each. Attempts are capped per leg,
    # independently of whatever the server-side source cap happens to be.
    REFERENCE_ATTEMPT_MULTIPLIER = 2
    REFERENCE_ATTEMPT_BASE_OVERHEAD = 3

    def __init__(self, payload={}):
        super().__init__(payload)
        self.__payload = payload

        settings_payload = payload.get("mockTestGenerationSettings", payload)
        self.__settings = MockTestGenerationSettings.from_json(settings_payload)

        self.__exam_name    = payload.get("examName", "")
        self.__subject_name = payload.get("subjectName", "the subject")

    async def __update_progress(self, completion: float):
        task = await TaskManager.get_current_task()
        task.set_completion(completion)
        await TaskManager.set_task(task)

    @staticmethod
    def __balance_into_groups(topic_entries: list[dict], num_groups: int) -> list[list[dict]]:
        sorted_entries = sorted(topic_entries, key=lambda entry: entry["weight"], reverse=True)
        groups = [[] for _ in range(num_groups)]
        group_weights = [0.0] * num_groups

        for entry in sorted_entries:
            min_weight_index = group_weights.index(min(group_weights))
            groups[min_weight_index].append(entry)
            group_weights[min_weight_index] += entry["weight"]

        return groups

    @staticmethod
    def __largest_remainder_allocate(weights: list[float], total: int) -> list[int]:
        if not weights or total == 0:
            return [0] * len(weights)

        total_weight = sum(weights)
        if total_weight == 0:
            return [0] * len(weights)

        quotas     = [(w / total_weight) * total for w in weights]
        floors     = [int(q) for q in quotas]
        remainders = [(quotas[i] - floors[i], i) for i in range(len(floors))]
        remainder_needed = total - sum(floors)

        remainders.sort(key=lambda x: x[0], reverse=True)
        for i in range(remainder_needed):
            floors[remainders[i][1]] += 1

        return floors

    def __allocate_types_globally(self, type_values, type_keys, topic_paths, topic_counts):
        # Build a per-topic per-type question breakdown that honours the
        # question-type weightage ACROSS THE WHOLE POOL. The type split is
        # computed once against the grand total (so every weighted type earns
        # its proportional share), then each type's quota is spread across the
        # topics in proportion to each topic's own question count.
        #
        # Doing this globally — rather than letting each worker split types for
        # its own topics in isolation — is what prevents the later question
        # types from being starved: when individual topics (or a single
        # worker's slice) are smaller than the number of types, a local split
        # can only ever cover the first few types, and the same bias repeats
        # everywhere, leaving the pool dominated by the first types.
        #
        # Column sums (per type) match the weighted global allocation; row sums
        # (per topic) stay close to each topic's intended share; the grand
        # total is preserved exactly.
        result = {path: {} for path in topic_paths}

        total = sum(topic_counts)
        if total == 0:
            return result

        global_type_counts = self.__largest_remainder_allocate(type_values, total)
        topic_weights      = [float(count) for count in topic_counts]

        for type_index, type_key in enumerate(type_keys):
            type_total = global_type_counts[type_index]
            if type_total == 0:
                continue

            per_topic_counts = self.__largest_remainder_allocate(topic_weights, type_total)
            for topic_index, topic_type_count in enumerate(per_topic_counts):
                if topic_type_count > 0:
                    result[topic_paths[topic_index]][type_key] = topic_type_count

        return result

    def __blueprint_validator(self, response: AutomationResponse) -> bool:
        try:
            text   = response.get_output().get_data()
            parsed = json.loads(strip_json_markdown(text))
            if "format" in parsed and "difficultyDistribution" in parsed and "questionsRepeatChance" in parsed:
                return True
        except Exception as e:
            print(f"[GenerateMockTests] Blueprint validation failed: {e}")
        return False

    @staticmethod
    def __instructions_validator(response: AutomationResponse) -> bool:
        try:
            text   = response.get_output().get_data()
            parsed = json.loads(strip_json_markdown(text))
            if "instructions" in parsed and "duration" in parsed:
                return isinstance(parsed["duration"], (int, float))
        except Exception:
            pass
        return False

    def __collect_specific_urls(self) -> list[str]:
        """
        Returns the URLs from any SPECIFIC_URL_ON_THE_INTERNET sources the
        user added — these are honoured verbatim alongside the search-based
        PDF discovery. Lets a user pin a specific PYQ archive without
        relying on the agent's search heuristics.
        """
        specific_urls = []
        sources = self.__settings.get_information_sources() or []

        for extractable in sources:
            information_source = extractable.get_information_source() if hasattr(extractable, "get_information_source") else None
            if not information_source:
                continue
            if information_source.get_source_type() != InformationSourceTypes.SPECIFIC_URL_ON_THE_INTERNET:
                continue

            url = (information_source.get_name() or "").strip()
            if url:
                specific_urls.append(url)

        return specific_urls

    @staticmethod
    def __is_pdf(body_bytes: bytes, content_type: str) -> bool:
        if content_type in GenerateMockTests.PDF_CONTENT_TYPES:
            return True

        return body_bytes[: len(GenerateMockTests.PDF_MAGIC_PREFIX)] == GenerateMockTests.PDF_MAGIC_PREFIX

    @staticmethod
    def __count_documents(content_parts: list) -> int:
        """Number of DOCUMENT (PDF) parts — what the prompts report as pdf_count."""
        return sum(1 for part in content_parts if part.get_content_type() == AutomationContentTypes.DOCUMENT)

    @staticmethod
    async def __build_reference_part(url: str, allow_web_pages: bool) -> AutomationContent | None:
        """
        Fetches one reference URL and turns it into an LLM content part, or
        returns None when it is unreachable, refused as unsafe, or of a type
        that cannot seed exam questions.

        A PDF becomes a DOCUMENT part. When allow_web_pages is True an HTML
        page becomes a TEXT part carrying its extracted readable text — HTML
        bytes handed over as a DOCUMENT part are unreadable to the model, so
        the conversion is what makes a pinned web page useful at all. When
        allow_web_pages is False, only PDFs survive.
        """
        fetched = await WebContentFetcher.fetch_document_bytes(url)
        if fetched is None:
            print(f"[GenerateMockTests] Skipping '{url}' — not fetched (unreachable, or refused as unsafe).")
            return None

        body_bytes, content_type = fetched

        if GenerateMockTests.__is_pdf(body_bytes, content_type):
            return AutomationContent(AutomationContentTypes.DOCUMENT, body_bytes)

        if not allow_web_pages:
            print(f"[GenerateMockTests] Skipping '{url}' — '{content_type}' is not a question-paper PDF.")
            return None

        if content_type not in GenerateMockTests.WEB_PAGE_CONTENT_TYPES:
            print(f"[GenerateMockTests] Skipping '{url}' — unusable content type '{content_type}'.")
            return None

        readable_text = WebContentFetcher.extract_readable_text(body_bytes)
        if not readable_text.strip():
            print(f"[GenerateMockTests] Skipping '{url}' — page carried no readable text.")
            return None

        return AutomationContent(
            AutomationContentTypes.TEXT,
            f"--- START REFERENCE PAGE: {url} ---\n{readable_text}\n--- END REFERENCE PAGE ---",
        )

    async def __procure_reference_material(self, max_documents: int) -> list[AutomationContent]:
        """
        Builds the LLM content parts that seed the exam blueprint and the PYQ
        pool. Two legs, deliberately treated differently:

          1. User-pinned SPECIFIC_URL_ON_THE_INTERNET sources — the user told us
             exactly where to look, and plenty of previous-year material lives
             on ordinary web pages, so PDFs AND HTML pages are both accepted.
          2. The `filetype:pdf` search for previous-year papers — anything
             non-PDF coming back from that search is a landing or error page
             rather than a question paper, so it is dropped as noise.

        Every fetch goes through WebContentFetcher.fetch_document_bytes, which
        validates the URL and each redirect hop with SafeUrlValidator, pins the
        connection to the address it validated, and caps the download. That is
        what stops a pasted URL from aiming the worker at an internal address.
        """
        content_parts: list[AutomationContent] = []
        attempt_cap = (max_documents * GenerateMockTests.REFERENCE_ATTEMPT_MULTIPLIER) + GenerateMockTests.REFERENCE_ATTEMPT_BASE_OVERHEAD

        # ── 1. Honour user-pinned URLs first ──────────────────────────────────
        # Fetched before falling back to search so the search cannot drown out
        # the user's explicit intent.
        attempts_made = 0
        for url in self.__collect_specific_urls():
            if len(content_parts) >= max_documents:
                break
            if attempts_made >= attempt_cap:
                print(f"[GenerateMockTests] Pinned-URL attempt cap ({attempt_cap}) reached — stopping.")
                break

            attempts_made += 1
            print(f"[GenerateMockTests] Downloading user-pinned URL: {url}")
            reference_part = await GenerateMockTests.__build_reference_part(url, allow_web_pages=True)
            if reference_part is not None:
                content_parts.append(reference_part)

        if len(content_parts) >= max_documents:
            return content_parts

        # ── 2. Search for additional question-paper PDFs ──────────────────────
        scraper = WebScraper()
        query = f"{self.__exam_name} {self.__subject_name} previous year question papers"

        filters = [
            ScrapeFilter(ScrapeFilterTypes.EXTENSION, "pdf"),
            ScrapeFilter(ScrapeFilterTypes.RESULT_COUNT, str(max_documents * 3))
        ]

        print(f"[GenerateMockTests] Searching web for baseline PDFs: '{query}'")
        links = await scraper.search(query, filters)

        if not links:
            print("[GenerateMockTests] No PDF links found during scraping.")
            return content_parts

        attempts_made = 0
        for link in links:
            if len(content_parts) >= max_documents:
                break
            if attempts_made >= attempt_cap:
                print(f"[GenerateMockTests] Search-result attempt cap ({attempt_cap}) reached — stopping.")
                break

            attempts_made += 1
            print(f"  -> Downloading: {link}")
            reference_part = await GenerateMockTests.__build_reference_part(link, allow_web_pages=False)
            if reference_part is not None:
                content_parts.append(reference_part)

        return content_parts

    def __has_web_information_source(self) -> bool:
        """
        Returns True if the user's information sources include at least one
        WEB-type entry. PYQ harvest is gated on this (per the design — users
        with no web sources don't opt in to internet-based seeding).
        """
        web_source_types = {
            InformationSourceTypes.ANYWHERE_ON_THE_INTERNET,
            InformationSourceTypes.SPECIFIC_URL_ON_THE_INTERNET,
            InformationSourceTypes.REPUTED_EXTERNAL_SOURCES,
        }

        sources = self.__settings.get_information_sources() or []
        for extractable in sources:
            information_source = extractable.get_information_source() if hasattr(extractable, "get_information_source") else None
            if not information_source:
                continue
            source_type = information_source.get_source_type()
            if source_type in web_source_types:
                return True

        return False

    def __has_question_paper_source(self) -> bool:
        """Returns True if the user added at least one QUESTION_PAPER source."""
        sources = self.__settings.get_information_sources() or []
        for extractable in sources:
            information_source = extractable.get_information_source() if hasattr(extractable, "get_information_source") else None
            if information_source and information_source.get_source_type() == InformationSourceTypes.QUESTION_PAPER:
                return True
        return False

    async def __extract_question_paper_pdf_bytes(self) -> list[bytes]:
        """
        Reads the uploaded bytes of every QUESTION_PAPER information source so
        their questions can seed the PYQ pool directly — no exam name or web
        source required (covers courses whose papers aren't online). The bytes
        feed the same __extract_pyq_from_reference_material path the web
        harvest uses, wrapped as DOCUMENT parts by the caller.
        """
        pdf_bytes_list = []
        sources = self.__settings.get_information_sources() or []

        for extractable in sources:
            information_source = extractable.get_information_source() if hasattr(extractable, "get_information_source") else None
            if not information_source:
                continue
            if information_source.get_source_type() != InformationSourceTypes.QUESTION_PAPER:
                continue
            try:
                pdf_path  = join_path("/", information_source.get_directory_path(), information_source.get_hash())
                pdf_bytes = await Persistence.read(pdf_path)
                if pdf_bytes:
                    pdf_bytes_list.append(pdf_bytes)
            except Exception as read_error:
                print(f"[GenerateMockTests] Failed to read question paper '{redact_source_name(information_source.get_name())}': {read_error}")
                continue

        return pdf_bytes_list

    @staticmethod
    def __pyq_validator(response: AutomationResponse) -> bool:
        try:
            text   = response.get_output().get_data()
            parsed = json.loads(strip_json_markdown(text))
            return isinstance(parsed, list)
        except Exception:
            return False

    async def __harvest_pyq_questions(self) -> list[dict]:
        """
        Downloads previous-year question paper PDFs and asks an LLM to
        extract structured question objects. Returns up to
        PYQ_POOL_MAX_QUESTIONS entries shaped:
            {question, answer, type, difficulty, topicHint}

        Gated by run() on examName + at least one WEB info source.
        """
        reference_parts = await self.__procure_reference_material(PYQ_HARVEST_MAX_PDFS)
        if not reference_parts:
            print("[GenerateMockTests] PYQ harvest: no reference material downloaded — pool will be empty.")
            return []

        return await self.__extract_pyq_from_reference_material(reference_parts)

    async def __extract_pyq_from_reference_material(self, reference_parts: list[AutomationContent]) -> list[dict]:
        """
        Extracts up to PYQ_POOL_MAX_QUESTIONS structured question objects from
        the given reference parts (PDF documents and/or extracted page text)
        via the LLM. Shared by the web-harvest path and the user-uploaded
        QUESTION_PAPER path. Entries:
            {question, answer, type, difficulty, topicHint}
        """
        if not reference_parts:
            return []

        model_string, provider_class = ModelPool.EXAM_QUESTION_TYPE_DETERMINER_MODEL
        caller = AutomationCaller(provider_class())

        user_prompt = PromptPool.PYQ_EXTRACTION_USER.format(
            exam_name = self.__exam_name,
            subject_name = self.__subject_name,
            pdf_count = GenerateMockTests.__count_documents(reference_parts),
            max_questions = PYQ_POOL_MAX_QUESTIONS,
        )

        request_contents = [
            AutomationContent(AutomationContentTypes.SYSTEM, PromptPool.PYQ_EXTRACTION_SYSTEM),
            AutomationContent(AutomationContentTypes.TEXT, user_prompt),
        ]
        request_contents.extend(reference_parts)

        print(f"[GenerateMockTests] PYQ harvest: extracting questions from {len(reference_parts)} source(s) via LLM...")
        response = await caller.call(
            AutomationRequest(model_string, request_contents),
            self.__pyq_validator,
            retries=2,
        )

        if response is None:
            print("[GenerateMockTests] PYQ harvest: LLM extraction failed — pool will be empty.")
            return []

        try:
            parsed = json.loads(strip_json_markdown(response.get_output().get_data()))
        except Exception as parse_error:
            print(f"[GenerateMockTests] PYQ harvest: unparsable response ({parse_error}) — pool will be empty.")
            return []

        if not isinstance(parsed, list):
            return []

        # Coerce to the expected shape; drop entries missing the required
        # fields so the worker doesn't have to defensive-check each one.
        pool = []
        for entry in parsed:
            if not isinstance(entry, dict):
                continue
            question_text = (entry.get("question") or "").strip()
            if not question_text:
                continue
            pool.append({
                "question": question_text,
                "answer": (entry.get("answer") or "").strip(),
                "type": (entry.get("type") or "").strip().upper(),
                "difficulty": (entry.get("difficulty") or "").strip().upper(),
                "topicHint": (entry.get("topicHint") or "").strip(),
            })
            if len(pool) >= PYQ_POOL_MAX_QUESTIONS:
                break

        print(f"[GenerateMockTests] PYQ harvest: {len(pool)} question(s) extracted.")
        return pool

    DEFAULT_FORMAT = {
        "MULTIPLE_CHOICE":                 1.0,
        "MULTIPLE_CORRECT":                1.0,
        "OBJECTIVE_SINGLE_WORD_OR_PHRASE": 1.0,
        "SHORT_SUBJECTIVE":                1.0,
        "MEDIUM_SUBJECTIVE":               1.0,
        "LONG_SUBJECTIVE":                 1.0,
    }

    DEFAULT_DIFFICULTY_DISTRIBUTION = {
        "VERY_EASY": 0.10,
        "EASY":      0.20,
        "MEDIUM":    0.40,
        "HARD":      0.20,
        "VERY_HARD": 0.10,
    }

    DEFAULT_TOTAL_QUESTIONS = 30

    @staticmethod
    def __filter_positive_weights(weights: dict) -> dict:
        return {key: float(value) for key, value in weights.items() if float(value) > 0}

    @staticmethod
    def __blend_weights_halfway(primary: dict, secondary: dict) -> dict:
        if not secondary:
            return dict(primary)
        if not primary:
            return dict(secondary)

        all_keys = set(primary.keys()) | set(secondary.keys())
        blended  = {}
        for key in all_keys:
            blended[key] = 0.5 * float(primary.get(key, 0.0)) + 0.5 * float(secondary.get(key, 0.0))
        return blended

    def __build_manual_difficulty(self) -> dict:
        return {
            "VERY_EASY": float(self.__settings.get_very_easy_questions()),
            "EASY":      float(self.__settings.get_easy_questions()),
            "MEDIUM":    float(self.__settings.get_medium_questions()),
            "HARD":      float(self.__settings.get_hard_questions()),
            "VERY_HARD": float(self.__settings.get_very_hard_questions()),
        }

    async def __resolve_blueprint(self) -> dict:
        # ── Per-setting AUTOMATIC/MANUAL resolution that mirrors the
        #    independent-decision pattern used in FlashcardGenerationWorker.
        #    Each of {format, difficultyDistribution, totalQuestions} is
        #    decided on its own; the blueprint LLM is consulted only if at
        #    least one is AUTOMATIC AND an exam name is set.
        b_auto_count      = self.__settings.get_num_questions_method() == AutomationLevels.AUTOMATIC
        b_auto_types      = self.__settings.get_question_types_method() == AutomationLevels.AUTOMATIC
        b_auto_difficulty = self.__settings.get_difficulty_method()    == AutomationLevels.AUTOMATIC
        b_has_exam_name   = bool(self.__exam_name and self.__exam_name.strip())

        manual_format     = None if b_auto_types      else self.__filter_positive_weights(self.__settings.get_question_types_with_weights())
        manual_difficulty = None if b_auto_difficulty else self.__filter_positive_weights(self.__build_manual_difficulty())
        manual_total      = None if b_auto_count      else int(self.__settings.get_num_questions_per_test())

        b_need_llm = (b_auto_count or b_auto_types or b_auto_difficulty) and b_has_exam_name
        resolved_blueprint = None

        if b_need_llm:
            resolved_blueprint = await self.__call_blueprint_llm()

        # ── Per-setting merge (manual wins; types blended 50/50 with the
        #    LLM-derived weights when both manual + exam are present, matching
        #    FlashcardGenerationWorker's exam-grounding rule).
        if manual_format is not None:
            if resolved_blueprint and resolved_blueprint.get("format"):
                final_format = self.__blend_weights_halfway(manual_format, resolved_blueprint["format"])
            else:
                final_format = dict(manual_format)
        elif resolved_blueprint and resolved_blueprint.get("format"):
            final_format = dict(resolved_blueprint["format"])
        else:
            final_format = dict(self.DEFAULT_FORMAT)

        final_format = self.__filter_positive_weights(final_format)
        if not final_format:
            final_format = dict(self.DEFAULT_FORMAT)

        if manual_difficulty is not None:
            final_difficulty = dict(manual_difficulty)
        elif resolved_blueprint and resolved_blueprint.get("difficultyDistribution"):
            final_difficulty = dict(resolved_blueprint["difficultyDistribution"])
        else:
            final_difficulty = dict(self.DEFAULT_DIFFICULTY_DISTRIBUTION)

        final_difficulty = self.__filter_positive_weights(final_difficulty)
        if not final_difficulty:
            final_difficulty = dict(self.DEFAULT_DIFFICULTY_DISTRIBUTION)

        if manual_total is not None:
            final_total = manual_total
        elif resolved_blueprint and resolved_blueprint.get("totalQuestions"):
            final_total = int(resolved_blueprint["totalQuestions"])
        else:
            final_total = self.DEFAULT_TOTAL_QUESTIONS

        if resolved_blueprint and "questionsRepeatChance" in resolved_blueprint:
            repeat_chance = float(resolved_blueprint["questionsRepeatChance"])
        else:
            repeat_chance = 0.5

        blueprint = {
            "format":                 final_format,
            "difficultyDistribution": final_difficulty,
            "questionsRepeatChance":  repeat_chance,
            "totalQuestions":         final_total,
        }

        print(f"[GenerateMockTests] Blueprint resolved: {json.dumps(blueprint, indent=2)}")
        return blueprint

    async def __call_blueprint_llm(self):
        reference_parts = []
        if self.__exam_name and self.__exam_name.strip():
            max_documents = min(15, 3 * self.__settings.get_number_of_tests())
            reference_parts = await self.__procure_reference_material(max_documents)

        model_string, provider_class = ModelPool.EXAM_QUESTION_TYPE_DETERMINER_MODEL
        provider = provider_class()
        caller   = AutomationCaller(provider)

        user_prompt = PromptPool.MOCK_TEST_BLUEPRINT_USER.format(
            exam_name    = self.__exam_name if self.__exam_name else "Unknown Exam",
            subject_name = self.__subject_name,
            pdf_count    = GenerateMockTests.__count_documents(reference_parts)
        )

        request_contents = [
            AutomationContent(AutomationContentTypes.SYSTEM, PromptPool.MOCK_TEST_BLUEPRINT_SYSTEM),
            AutomationContent(AutomationContentTypes.TEXT,   user_prompt, metadata={"google_search": True})
        ]

        request_contents.extend(reference_parts)

        print("[GenerateMockTests] Calling LLM to extract Exam Blueprint...")
        response = await caller.call(
            AutomationRequest(model_string, request_contents),
            self.__blueprint_validator,
            retries=3
        )

        if response is None:
            print("[GenerateMockTests] [WARNING] Blueprint LLM failed — falling back to per-setting defaults.")
            return None

        try:
            parsed = json.loads(strip_json_markdown(response.get_output().get_data()))
        except Exception as parse_error:
            print(f"[GenerateMockTests] [WARNING] Blueprint LLM response unparsable ({parse_error}) — falling back to per-setting defaults.")
            return None

        if "totalQuestions" not in parsed and "format" in parsed:
            try:
                parsed["totalQuestions"] = int(sum(float(value) for value in parsed["format"].values()))
            except Exception:
                pass

        return parsed

    async def __resolve_instructions(self, blueprint: dict) -> tuple[str, int]:
        model_string, provider_class = ModelPool.EXAM_QUESTION_TYPE_DETERMINER_MODEL
        provider = provider_class()
        caller   = AutomationCaller(provider)

        type_breakdown = ", ".join(
            f"{count} {type_key}"
            for type_key, count in blueprint["format"].items()
        )

        user_prompt = (
            PromptPool.MOCK_TEST_INSTRUCTIONS_USER
            .replace("{exam_name}",       self.__exam_name if self.__exam_name else "General Practice Test")
            .replace("{subject_name}",    self.__subject_name)
            .replace("{total_questions}", str(blueprint["totalQuestions"]))
            .replace("{type_breakdown}",  type_breakdown)
        )

        request = AutomationRequest(
            model_string,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, PromptPool.MOCK_TEST_INSTRUCTIONS_SYSTEM),
                AutomationContent(AutomationContentTypes.TEXT,   user_prompt, metadata={"google_search": True})
            ]
        )

        print("[GenerateMockTests] Calling LLM to resolve exam instructions and duration...")
        response = await caller.call(request, self.__instructions_validator, retries=2)

        if response is None:
            print("[GenerateMockTests] [WARNING] Instructions LLM failed — defaulting to empty.")
            return ("", 0)

        parsed       = json.loads(strip_json_markdown(response.get_output().get_data()))
        instructions = parsed.get("instructions", "")
        duration     = int(parsed.get("duration", 0))

        print(f"[GenerateMockTests] Instructions resolved. Duration: {duration} min.")
        return (instructions, duration)

    async def run(self, args={}):
        main_task_id = os.getenv("MAIN_TASK_ID")
        current_task = await TaskManager.get_current_task()

        if not main_task_id:
            raise Exception("MAIN_TASK_ID environment variable not set.")

        # log() prints to stdout AND accumulates lines.
        # flush_log() writes to GCS so logs are readable via MoveToDatabase.js
        # even when stdout is not forwarded to the Node.js console.
        log_lines = []

        def log(message: str):
            print(message)
            log_lines.append(message)

        async def flush_log():
            try:
                log_path = join_path(
                    "/", PersistenceConstants.TASKS_DIRECTORY, main_task_id, "GenerateMockTests.log"
                )
                await Persistence.write(log_path, "\n".join(log_lines))
            except Exception as log_err:
                print(f"[GenerateMockTests] Could not write log file: {log_err}")

        log(f"[GenerateMockTests] Starting for task {main_task_id}")
        await self.__update_progress(0.05)

        # ── 0. PYQ pool — exam-style question seeds the worker rephrases/derives
        #       from. Two sources, unioned:
        #       (a) User-uploaded QUESTION_PAPER sources — extracted directly, no
        #           examName/web needed (covers courses whose papers aren't
        #           online). Taken FIRST so they win the cap over web seeds.
        #       (b) Web harvest — only when examName is set AND a web info source
        #           is present (templates with additionalWebSources auto-satisfy).
        pyq_pool: list[dict] = []

        try:
            question_paper_pdfs = await self.__extract_question_paper_pdf_bytes()
            if question_paper_pdfs:
                log(f"[GenerateMockTests] Extracting PYQ seeds from {len(question_paper_pdfs)} uploaded question paper(s)...")
                question_paper_parts = [
                    AutomationContent(AutomationContentTypes.DOCUMENT, pdf_bytes)
                    for pdf_bytes in question_paper_pdfs
                ]
                pyq_pool.extend(await self.__extract_pyq_from_reference_material(question_paper_parts))
                log(f"[GenerateMockTests] Question-paper PYQ seeds: {len(pyq_pool)}")
        except Exception as paper_error:
            log(f"[GenerateMockTests] Question-paper extraction failed (continuing): {paper_error}")

        if len(pyq_pool) < PYQ_POOL_MAX_QUESTIONS and (self.__exam_name and self.__exam_name.strip()) and self.__has_web_information_source():
            try:
                pyq_pool.extend(await self.__harvest_pyq_questions())
                log(f"[GenerateMockTests] PYQ pool size after web harvest: {len(pyq_pool)}")
            except Exception as harvest_error:
                log(f"[GenerateMockTests] PYQ web harvest failed (continuing without seeds): {harvest_error}")
        elif not pyq_pool:
            log("[GenerateMockTests] Skipping PYQ harvest (need a Question Paper source, or examName + web info source).")

        # Cap, keeping the uploaded-paper seeds (already at the front) preferentially.
        pyq_pool = pyq_pool[:PYQ_POOL_MAX_QUESTIONS]
        await flush_log()

        # ── 1. Resolve blueprint ───────────────────────────────────────────────
        blueprint = await self.__resolve_blueprint()

        blueprint["questionsRepeatChance"] = min(
            float(blueprint.get("questionsRepeatChance", 0.5)),
            MAX_REPEAT_CHANCE
        )

        await self.__update_progress(0.20)

        # ── 2. Resolve instructions + duration ────────────────────────────────
        # If the user (or applied template) configured an explicit duration
        # in MockTestGenerationSettings, honour it and skip the LLM call
        # entirely — saves a request + lets templates lock duration to the
        # real exam length (JEE Mains = 180 min, KCET = 80 min, etc.). We
        # still call the instructions LLM since the instructions text is
        # not yet template-driven, but pass duration=0 so it focuses on
        # the prose alone.
        configured_duration = int(self.__settings.get_duration_minutes() or 0)
        instructions, llm_duration = await self.__resolve_instructions(blueprint)
        duration = configured_duration if configured_duration > 0 else llm_duration
        if configured_duration > 0:
            print(f"[GenerateMockTests] Using configured duration {configured_duration} min (settings override).")
        await self.__update_progress(0.30)

        # ── 3. Compute baseline per-test totals (Blueprint.json is written
        #       AFTER per-deck pool sizing in step 5, so the recursive flag
        #       and the final pool size land on disk together).
        num_tests             = self.__settings.get_number_of_tests()
        total_questions       = blueprint["totalQuestions"]
        repeat_chance         = blueprint["questionsRepeatChance"]
        required_per_deck     = total_questions + round(
            total_questions * (num_tests - 1) * (1.0 - repeat_chance)
        )
        recursive             = bool(self.__settings.get_recursive())
        skip_root             = bool(self.__settings.get_skip_root_deck())

        log(
            f"[GenerateMockTests] {num_tests} test(s), {total_questions} Q each, "
            f"repeatChance={repeat_chance:.2f}, recursive={recursive}, skipRootDeck={skip_root}."
        )
        await flush_log()

        await self.__update_progress(0.38)

        # ── 4. Load mapped topics via syllabus ────────────────────────────────
        syllabus_path = join_path(
            "/", PersistenceConstants.TASKS_DIRECTORY, main_task_id, PersistenceConstants.SYLLABUS_FILE_NAME
        )

        syllabus_bytes = await Persistence.read(syllabus_path)
        taxonomy       = json.loads(syllabus_bytes.decode("utf-8"))
        leaves         = extract_leaves(taxonomy)
        log(f"[GenerateMockTests] Loaded {len(leaves)} leaf topic(s) from syllabus.")

        # MapTopicsWithContent intentionally skips topics that have neither
        # PDF chunks nor enabled web sources (no content to feed an LLM), so
        # those mapped-topic JSON files do not exist. That is the expected
        # case — not an error — and reading them produces noisy 404s. Use
        # Persistence.exists() to silently skip; only log a single summary.
        topic_entries          = []
        skipped_missing_count  = 0
        for leaf in leaves:
            topic_str = leaf["topic"]
            hierarchy = leaf["path"]

            safe_unit  = sanitize_filename(hierarchy[0]) if hierarchy else "Uncategorised"
            safe_topic = sanitize_filename(topic_str)

            file_path = join_path(
                "/",
                PersistenceConstants.TASKS_DIRECTORY,
                main_task_id,
                PersistenceConstants.MAPPED_TOPICS_DIRECTORY,
                safe_unit,
                f"{safe_topic}.json",
            )

            if not await Persistence.exists(file_path):
                skipped_missing_count += 1
                continue

            try:
                file_bytes   = await Persistence.read(file_path)
                topic_object = json.loads(file_bytes.decode("utf-8"))
                weight       = float(topic_object.get("weight", 0.0))
            except Exception as load_error:
                log(f"[GenerateMockTests] Failed to read mapped topic '{topic_str}' at '{file_path}': {load_error}")
                continue

            topic_chain = list(hierarchy) + [topic_str]
            topic_entries.append({"path": file_path, "weight": weight, "chain": topic_chain})

        if skipped_missing_count > 0:
            log(f"[GenerateMockTests] Skipped {skipped_missing_count} leaf topic(s) with no mapped content (expected — content-less topics are not written by MapTopicsWithContent).")

        log(f"[GenerateMockTests] {len(topic_entries)} mapped topic(s) loaded.")

        if not topic_entries:
            log("[ERROR] No mapped topic files found. Blueprint.json written but no workers will be spawned.")
            await flush_log()
            return

        # Normalize weights (matches GenerateFlashcards behaviour — no weight filter).
        # If all weights are 0, distribute equally for correct group balancing.
        total_weight_sum = sum(e["weight"] for e in topic_entries)
        if total_weight_sum == 0:
            equal_weight = 1.0 / len(topic_entries)
            for entry in topic_entries:
                entry["weight"] = equal_weight
            log(f"[GenerateMockTests] All topic weights were 0 — normalized to {equal_weight:.4f} each.")

        await self.__update_progress(0.45)

        # ── 5. Allocate per-leaf question counts ───────────────────────────────
        # Non-recursive: distribute the standard pool evenly across all leaves
        # (matches the prior behavior). Recursive: every target deck (parent +
        # each subdeck in the generated tree, minus the root when skip-root is
        # on) must end up with at least `required_per_deck` questions. For each
        # leaf, take the max requirement across the decks that contain it so
        # the smallest-leaf-count deck is satisfied.
        topic_paths_in_order = [entry["path"] for entry in topic_entries]
        topic_chains_in_order = [entry["chain"] for entry in topic_entries]

        if recursive:
            target_deck_prefixes = set()
            target_deck_prefixes.add(())  # () represents the parent (root) deck

            for chain in topic_chains_in_order:
                for prefix_length in range(1, len(chain) + 1):
                    target_deck_prefixes.add(tuple(chain[:prefix_length]))

            if skip_root:
                target_deck_prefixes.discard(())

            leaves_under_count = {}
            for deck_prefix in target_deck_prefixes:
                prefix_length = len(deck_prefix)
                if prefix_length == 0:
                    leaves_under_count[deck_prefix] = len(topic_chains_in_order)
                else:
                    leaves_under_count[deck_prefix] = sum(
                        1 for chain in topic_chains_in_order
                        if len(chain) >= prefix_length and tuple(chain[:prefix_length]) == deck_prefix
                    )

            per_leaf_counts = []
            for chain in topic_chains_in_order:
                max_required = 0
                for deck_prefix in target_deck_prefixes:
                    prefix_length = len(deck_prefix)
                    contains_leaf = (
                        prefix_length == 0
                        or (len(chain) >= prefix_length and tuple(chain[:prefix_length]) == deck_prefix)
                    )
                    if not contains_leaf:
                        continue
                    deck_leaf_count = leaves_under_count[deck_prefix]
                    if deck_leaf_count == 0:
                        continue
                    needed_for_this_deck = math.ceil(required_per_deck / deck_leaf_count)
                    if needed_for_this_deck > max_required:
                        max_required = needed_for_this_deck
                per_leaf_counts.append(max(1, max_required))

            raw_total_to_generate = sum(per_leaf_counts)
            num_target_decks = max(1, len(target_deck_prefixes))
            pool_ceiling = max(
                total_questions,
                total_questions * GenerateMockTests.MAX_POOL_TO_PER_TEST_RATIO * num_target_decks,
            )

            if raw_total_to_generate > pool_ceiling:
                scale_factor = pool_ceiling / raw_total_to_generate
                per_leaf_counts = [max(1, int(count * scale_factor)) for count in per_leaf_counts]
                log(
                    f"[GenerateMockTests] Pool size capped (recursive): wanted {raw_total_to_generate} "
                    f"unique questions to cover {num_target_decks} target deck(s), scaling down to fit "
                    f"the {pool_ceiling}-question safety ceiling. Tests share questions via repeat-fill "
                    f"above this cap."
                )

            total_to_generate = sum(per_leaf_counts)
            topic_question_counts = per_leaf_counts

            log(
                f"[GenerateMockTests] Recursive allocation: {num_target_decks} target deck(s), "
                f"requiredPerDeck={required_per_deck}, totalToGenerate={total_to_generate}, "
                f"per-leaf min={min(per_leaf_counts) if per_leaf_counts else 0}, "
                f"max={max(per_leaf_counts) if per_leaf_counts else 0}."
            )
        else:
            raw_total_to_generate = required_per_deck
            pool_ceiling = max(total_questions, total_questions * GenerateMockTests.MAX_POOL_TO_PER_TEST_RATIO)
            total_to_generate = min(raw_total_to_generate, pool_ceiling)

            if total_to_generate < raw_total_to_generate:
                log(
                    f"[GenerateMockTests] Pool size capped: requested {raw_total_to_generate} unique "
                    f"questions, generating {total_to_generate} ({GenerateMockTests.MAX_POOL_TO_PER_TEST_RATIO}x "
                    f"per-test). Tests share questions via repeat-fill above this cap."
                )

            topic_equal_weights = [1.0] * len(topic_entries)
            topic_question_counts = self.__largest_remainder_allocate(topic_equal_weights, total_to_generate)

            log(
                f"[GenerateMockTests] Allocating {total_to_generate} question(s) evenly across "
                f"{len(topic_entries)} topic(s) (LRM): "
                f"min={min(topic_question_counts) if topic_question_counts else 0}, "
                f"max={max(topic_question_counts) if topic_question_counts else 0}."
            )

        topic_question_count_by_path = dict(zip(topic_paths_in_order, topic_question_counts))

        # Pre-compute a GLOBAL per-topic per-type question breakdown from the
        # blueprint's type weightage so the per-type distribution is honoured
        # across the entire pool. Workers consume their slice of this map
        # instead of splitting types locally (which starves later types when a
        # worker's topics are small). See __allocate_types_globally.
        blueprint_format        = blueprint.get("format", {}) or {}
        type_keys_in_order      = list(blueprint_format.keys())
        type_values_in_order    = [float(blueprint_format[type_key]) for type_key in type_keys_in_order]
        topic_type_count_by_path = self.__allocate_types_globally(
            type_values_in_order,
            type_keys_in_order,
            topic_paths_in_order,
            topic_question_counts,
        )

        # ── 5b. Persist Blueprint.json with the FINAL totals + recursive flags ─
        # MoveToDatabase reads this to know how many tests to assemble per deck
        # and whether to bucket questions across the deck subtree.
        blueprint_data = {
            **blueprint,
            "numberOfTests":            num_tests,
            "totalQuestionsToGenerate": total_to_generate,
            "examName":                 self.__exam_name,
            "subjectName":              self.__subject_name,
            "instructions":             instructions,
            "duration":                 duration,
            "recursive":                recursive,
            "skipRootDeck":             skip_root,
        }

        blueprint_path = join_path(
            "/", PersistenceConstants.TASKS_DIRECTORY, main_task_id, PersistenceConstants.BLUEPRINT_FILE_NAME
        )
        await Persistence.write(blueprint_path, json.dumps(blueprint_data, ensure_ascii=False))
        log(f"[GenerateMockTests] Blueprint.json written to {blueprint_path}")
        await flush_log()

        # ── 6. Balance topics into worker groups ───────────────────────────────
        groups           = self.__balance_into_groups(topic_entries, self.NUM_GROUPS)
        non_empty_groups = [g for g in groups if g]

        # ── 7. Create worker tasks — each group's question count is the sum
        #       of its topics' pre-allocated counts (preserving even-per-topic
        #       distribution while still fanning out parallelism).
        worker_task_ids = []

        for group in non_empty_groups:
            group_topic_paths = [entry["path"] for entry in group]
            group_topic_counts = {path: topic_question_count_by_path[path] for path in group_topic_paths}
            group_num_questions = sum(group_topic_counts.values())

            if group_num_questions == 0:
                continue

            group_topic_type_counts = {path: topic_type_count_by_path.get(path, {}) for path in group_topic_paths}

            worker_payload = {
                "paths": group_topic_paths,
                "totalWeight": sum(e["weight"] for e in group),
                "numQuestions": group_num_questions,
                "topicQuestionCounts": group_topic_counts,
                "topicTypeCounts": group_topic_type_counts,
                "examName": self.__exam_name,
                "subjectName": self.__subject_name,
                "mockTestGenerationSettings": self.__payload,
                "blueprint": blueprint,
                "pyqPool": pyq_pool,
            }

            worker_task = TaskDescriptor(
                type = TaskTypes.MOCK_TEST_GENERATION_WORKER,
                execution_target = TaskExecutionTargets.LOCAL,
                payload = worker_payload,
                next_task_ids = [],
                parent_task_id = current_task.get_id()
            )

            await TaskManager.set_task(worker_task)
            worker_task_ids.append(worker_task.get_id())

        current_task.set_next_task_ids(worker_task_ids)
        await TaskManager.set_task(current_task)

        log(f"[GenerateMockTests] Spawned {len(worker_task_ids)} worker task(s).")
        await flush_log()
        await self.__update_progress(0.50)