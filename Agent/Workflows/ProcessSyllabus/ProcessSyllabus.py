import json
import os
from typing import List

from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.AutomationResponse import AutomationResponse
from Globals.Classes.Automation.Pools.ModelPool import ModelPool
from Globals.Classes.Automation.Pools.PromptPool import PromptPool
from Globals.Classes.Automation.Providers.DocumentProcessingProvider import DocumentProcessingProvider
from Globals.Classes.Decorators.ExtractableInformationSource import ExtractableInformationSource
from Globals.Classes.Generic.Persistence import Persistence
from Globals.Classes.Task.AutoGeneration.GeneralGenerationSettings import GeneralGenerationSettings
from Globals.Classes.Task.TaskDescriptor import TaskDescriptor
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Constants.PersistenceConstants import PersistenceConstants
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Enumerations.InformationSourceTypes import InformationSourceTypes
from Globals.Enumerations.TaskTypes import TaskTypes
from Globals.Utility.ExpandPageRanges import is_full_document_range
from Globals.Utility.JoinPath import join_path
from Globals.Utility.StripJsonMarkdown import strip_json_markdown

from Workflows.ProcessSyllabus.CleanHeadings import clean_headings
from Workflows.ProcessSyllabus.CoverageSummaryGenerator import CoverageSummaryGenerator
from Workflows.ProcessSyllabus.ExtractStructure import extract_structure
from Workflows.ProcessSyllabus.HeadingsToOutline import headings_to_outline
from Workflows.MapTopicsWithContent.ChunkUtils import extract_leaves
from Workflows.Workflow import Workflow
from Globals.Classes.Generation.PaidDeckActionLog import PaidDeckActionLog
from Globals.Utility.RedactSourceName import redact_source_name


class ProcessSyllabus(Workflow):

    BANNED_KEYS = {"name", "subtopics", "content", "chapters", "items", "topics"}

    def __init__(self, payload):
        super().__init__(payload)
        self.__general_generation_settings: GeneralGenerationSettings = GeneralGenerationSettings.from_json(payload)

    async def __update_progress(self, completion: float):
        task = await TaskManager.get_current_task()
        task.set_completion(completion)
        await TaskManager.set_task(task)

    @staticmethod
    def __syllabus_json_validator(response: AutomationResponse) -> bool:
        try:
            output = response.get_output()
            if output is None:
                return False

            data = output.get_data()
            if data is None:
                return False

            if isinstance(data, dict):
                parsed = data
            elif isinstance(data, str):
                if not data.strip():
                    return False
                parsed = strip_json_markdown(data)
                if parsed is None:
                    return False
            else:
                return False

            if not isinstance(parsed, dict) or len(parsed) == 0:
                return False

            return ProcessSyllabus.__validate_node(parsed)

        except (AttributeError, IndexError):
            return False

    @staticmethod
    def __validate_node(node) -> bool:
        if isinstance(node, list):
            return len(node) > 0 and all(isinstance(item, str) for item in node)
        if isinstance(node, dict):
            if len(node) == 0:
                return False
            for key, value in node.items():
                if key.lower() in ProcessSyllabus.BANNED_KEYS:
                    return False
                if not ProcessSyllabus.__validate_node(value):
                    return False
            return True
        return False

    @staticmethod
    def __parse_response_to_dict(response: AutomationResponse) -> dict | None:
        if response is None:
            return None
        try:
            data = response.get_output().get_data()
        except (AttributeError, IndexError):
            return None
        if isinstance(data, dict):
            return data
        if isinstance(data, str):
            parsed = strip_json_markdown(data)
            return parsed if isinstance(parsed, dict) else None
        return None

    @staticmethod
    def __compute_extraction_ranges(extractable_source: ExtractableInformationSource) -> List[tuple]:
        page_ranges = extractable_source.get_page_ranges()
        if not page_ranges:
            return [(0, 0)]

        ranges = []
        for page_range in page_ranges:
            if is_full_document_range(page_range):
                return [(0, 0)]
            ranges.append((page_range.get_start_page(), page_range.get_end_page()))
        return ranges

    async def __extract_syllabus_from_curriculum_document(self, extractable_source: ExtractableInformationSource) -> dict | None:
        information_source     = extractable_source.get_information_source()
        document_path          = join_path("/", information_source.get_directory_path(), information_source.get_hash())

        document_provider = DocumentProcessingProvider()
        document_caller   = AutomationCaller(document_provider)

        extracted_text_parts = []

        for (start_page, end_page) in self.__compute_extraction_ranges(extractable_source):
            extraction_request = AutomationRequest(
                None,
                [
                    AutomationContent(AutomationContentTypes.DOCUMENT, document_path),
                    AutomationContent(
                        AutomationContentTypes.TASK_DESCRIPTOR,
                        TaskDescriptor(
                            type=TaskTypes.EXTRACT_DOCUMENT_CONTENT,
                            payload={
                                "start_page": start_page,
                                "end_page":   end_page,
                            },
                        ),
                    ),
                ],
            )

            extraction_response = await document_caller.call(extraction_request, None)
            if extraction_response is None:
                continue

            try:
                part_text = extraction_response.get_output().get_data()
                if part_text:
                    extracted_text_parts.append(part_text)
            except (AttributeError, IndexError):
                continue

        combined_text = "\n\n".join(extracted_text_parts).strip()
        if not combined_text:
            return None

        syllabus_model_string, syllabus_provider_class = ModelPool.SYLLABUS_PROCESSING_MODEL
        syllabus_caller = AutomationCaller(syllabus_provider_class())

        syllabus_request = AutomationRequest(
            syllabus_model_string,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, PromptPool.SYLLABUS_PROCESSING_SYSTEM),
                AutomationContent(AutomationContentTypes.TEXT, PromptPool.SYLLABUS_PROCESSING_USER + combined_text),
            ],
        )

        syllabus_response = await syllabus_caller.call(syllabus_request, ProcessSyllabus.__syllabus_json_validator)
        return ProcessSyllabus.__parse_response_to_dict(syllabus_response)

    async def __extract_syllabus_from_provided_document(self, extractable_source: ExtractableInformationSource) -> dict | None:
        information_source = extractable_source.get_information_source()
        textbook_path      = join_path("/", information_source.get_directory_path(), information_source.get_hash())

        try:
            pdf_bytes = await Persistence.read(textbook_path)
        except Exception as read_error:
            print(f"[ProcessSyllabus] Could not read textbook '{redact_source_name(information_source.get_name())}': {read_error}")
            return None

        accumulated_headings = []
        for (start_page, end_page) in self.__compute_extraction_ranges(extractable_source):
            headings = extract_structure(pdf_bytes, start_page, end_page)
            accumulated_headings.extend(headings)

        if not accumulated_headings:
            print(f"[ProcessSyllabus] No headings extracted from '{redact_source_name(information_source.get_name())}'.")
            return None

        cleaned_headings = clean_headings(accumulated_headings)
        outline_text     = headings_to_outline(cleaned_headings)

        syllabus_model_string, syllabus_provider_class = ModelPool.SYLLABUS_PROCESSING_MODEL
        syllabus_caller = AutomationCaller(syllabus_provider_class())

        syllabus_request = AutomationRequest(
            syllabus_model_string,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, PromptPool.SYLLABUS_PROCESSING_FROM_RAW_TEXTBOOK_SYSTEM),
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    PromptPool.SYLLABUS_PROCESSING_FROM_RAW_TEXTBOOK_USER
                        .replace("{subject_name}", self.__general_generation_settings.get_subject_name())
                    + outline_text
                    + "\n-- OUTLINE END --",
                ),
            ],
        )

        syllabus_response = await syllabus_caller.call(syllabus_request, ProcessSyllabus.__syllabus_json_validator)
        return ProcessSyllabus.__parse_response_to_dict(syllabus_response)

    async def __extract_syllabus_from_description(self) -> dict | None:
        description = (self.__general_generation_settings.get_description() or "").strip()
        if not description:
            return None

        subject_name = self.__general_generation_settings.get_subject_name() or "the subject"
        exam_name    = self.__general_generation_settings.get_exam_name() or ""
        exam_context = f"This is being prepared for the {exam_name} exam." if exam_name else "No specific exam target."

        syllabus_model_string, syllabus_provider_class = ModelPool.SYLLABUS_PROCESSING_MODEL
        syllabus_caller = AutomationCaller(syllabus_provider_class())

        syllabus_request = AutomationRequest(
            syllabus_model_string,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, PromptPool.SYLLABUS_FROM_DESCRIPTION_SYSTEM),
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    PromptPool.SYLLABUS_FROM_DESCRIPTION_USER
                        .replace("{subject_name}", subject_name)
                        .replace("{exam_context}", exam_context)
                        .replace("{description}", description),
                ),
            ],
        )

        syllabus_response = await syllabus_caller.call(syllabus_request, ProcessSyllabus.__syllabus_json_validator)
        return ProcessSyllabus.__parse_response_to_dict(syllabus_response)

    async def __merge_syllabi(self, partial_syllabi: List[dict]) -> dict | None:
        if not partial_syllabi:
            return None
        if len(partial_syllabi) == 1:
            return partial_syllabi[0]

        syllabi_block = "\n\n".join(
            f"-- SOURCE {index + 1} --\n{json.dumps(partial, ensure_ascii=False, indent=2)}"
            for index, partial in enumerate(partial_syllabi)
        )

        subject_name = self.__general_generation_settings.get_subject_name() or "the subject"

        merge_model_string, merge_provider_class = ModelPool.SYLLABUS_PROCESSING_MODEL
        merge_caller = AutomationCaller(merge_provider_class())

        merge_request = AutomationRequest(
            merge_model_string,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, PromptPool.SYLLABUS_MERGE_SYSTEM),
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    PromptPool.SYLLABUS_MERGE_USER
                        .replace("{syllabus_count}", str(len(partial_syllabi)))
                        .replace("{subject_name}", subject_name)
                        .replace("{syllabi_block}", syllabi_block),
                ),
            ],
        )

        merge_response = await merge_caller.call(merge_request, ProcessSyllabus.__syllabus_json_validator)
        merged = ProcessSyllabus.__parse_response_to_dict(merge_response)

        if merged is None:
            print("[ProcessSyllabus] Merge LLM call failed — concatenating partial syllabi as fallback.")
            merged = {}
            for index, partial in enumerate(partial_syllabi):
                key = f"Source {index + 1}"
                merged[key] = partial

        return merged

    def __collect_syllabus_candidates(self) -> tuple:
        information_sources = self.__general_generation_settings.get_information_sources() or []

        curriculum_sources = [
            extractable_source for extractable_source in information_sources
            if extractable_source.get_information_source().get_source_type() == InformationSourceTypes.CURRICULUM_OR_SYLLABUS
        ]
        document_sources = [
            extractable_source for extractable_source in information_sources
            if extractable_source.get_information_source().get_source_type() == InformationSourceTypes.PROVIDED_DOCUMENTS
        ]

        return curriculum_sources, document_sources

    async def run(self):
        # Every ProcessSyllabus path hits fitz (the TOC / heading / structure
        # extractors). Silence MuPDF's C-level warnings here so the agent log
        # stays clean for the rest of the run.
        from Globals.Classes.Generic.MuPdfBootstrap import MuPdfBootstrap
        MuPdfBootstrap.silence_parser_warnings()

        main_task_id                  = os.getenv("MAIN_TASK_ID")
        syllabus_file_destination_path = join_path(
            "/",
            PersistenceConstants.TASKS_DIRECTORY,
            main_task_id,
            PersistenceConstants.SYLLABUS_FILE_NAME,
        )

        curriculum_sources, document_sources = self.__collect_syllabus_candidates()

        print(f"[ProcessSyllabus] Curriculum sources: {len(curriculum_sources)}, Document sources: {len(document_sources)}")

        # Checkpoint-resume: the syllabus defines every downstream topic path, so
        # it MUST stay stable across a resume — re-deriving it via the LLM could
        # yield a different structure and orphan all already-generated items. If
        # Syllabus.json already exists, reuse it verbatim and skip extraction/merge.
        if await Persistence.exists(syllabus_file_destination_path):
            print("[ProcessSyllabus] Syllabus already exists — reusing it (resume); skipping extraction and merge.")
            # The syllabus is reused, but the coverage summaries may not have been
            # written yet (a run interrupted between the two writes). Generating
            # them is idempotent and gated on its own file, so this is safe to
            # re-enter and is what makes the resume path whole.
            await self.__generate_coverage_summaries_if_paid_deck_mode(main_task_id, syllabus_file_destination_path)
            await self.__update_progress(1.0)
            return

        await self.__update_progress(0.05)

        partial_syllabi: List[dict] = []
        completed_extractions       = 0
        total_extractions           = max(1, len(curriculum_sources) + len(document_sources))

        for extractable_source in curriculum_sources:
            extracted = await self.__extract_syllabus_from_curriculum_document(extractable_source)
            if extracted is not None:
                partial_syllabi.append(extracted)
            completed_extractions += 1
            await self.__update_progress(0.05 + 0.55 * (completed_extractions / total_extractions))

        for extractable_source in document_sources:
            extracted = await self.__extract_syllabus_from_provided_document(extractable_source)
            if extracted is not None:
                partial_syllabi.append(extracted)
            completed_extractions += 1
            await self.__update_progress(0.05 + 0.55 * (completed_extractions / total_extractions))

        # If we got nothing from sources, fall back to description-only generation.
        if not partial_syllabi:
            description_syllabus = await self.__extract_syllabus_from_description()
            if description_syllabus is None:
                raise Exception(
                    "Could not derive a syllabus. Provide at least one syllabus/textbook source or a non-empty description."
                )
            partial_syllabi.append(description_syllabus)

        await self.__update_progress(0.70)

        merged_syllabus = await self.__merge_syllabi(partial_syllabi)
        if merged_syllabus is None:
            raise Exception("Syllabus merge failed and no fallback was usable.")

        await self.__update_progress(0.90)

        await Persistence.write(
            syllabus_file_destination_path,
            json.dumps(merged_syllabus, ensure_ascii=False),
        )

        print(f"[ProcessSyllabus] Persisted unified syllabus ({len(partial_syllabi)} partial syllabi merged).")

        await self.__generate_coverage_summaries_if_paid_deck_mode(main_task_id, syllabus_file_destination_path)

        await self.__update_progress(1.0)

    async def __generate_coverage_summaries_if_paid_deck_mode(self, main_task_id: str, syllabus_file_path: str) -> None:
        """
        Paid-deck extension to this workflow. Normal-mode runs return immediately
        and their Syllabus.json is byte-identical to what it was before this
        existed — the summaries are an ADDITIONAL file, never a change to the
        taxonomy shape that DeckHierarchyBuilder and MapTopicsWithContent parse.

        In paid-deck mode there is no document to retrieve from, so the coverage
        summary is the only specification the writers get. Without it the run
        would produce a plausible overview of each topic and silently omit the
        derivations, constants and diagrams that make it worth selling.
        """
        if self.__general_generation_settings.get_paid_deck_mode() is not True:
            return

        coverage_summaries_path = join_path(
            "/",
            PersistenceConstants.TASKS_DIRECTORY,
            main_task_id,
            PersistenceConstants.COVERAGE_SUMMARIES_FILE_NAME,
        )

        if await Persistence.exists(coverage_summaries_path):
            print("[ProcessSyllabus] Coverage summaries already exist — reusing them (resume).")
            return

        syllabus_bytes = await Persistence.read(syllabus_file_path)
        taxonomy = json.loads(syllabus_bytes.decode("utf-8"))
        leaves = extract_leaves(taxonomy)

        if not leaves:
            print("[ProcessSyllabus] Syllabus has no leaf topics — no coverage summaries to generate.")
            return

        print(f"[ProcessSyllabus] Paid-deck mode: generating coverage summaries for {len(leaves)} topic(s)...")
        await self.__update_progress(0.92)

        action_log = PaidDeckActionLog(main_task_id, "ProcessSyllabus")

        await self.__record_source_declarations(action_log)

        generator = CoverageSummaryGenerator(
            subject_name = self.__general_generation_settings.get_subject_name(),
            exam_name = self.__general_generation_settings.get_exam_name(),
            additional_instructions = self.__general_generation_settings.get_additional_instructions(),
            action_log = action_log,
        )
        coverage_summaries = await generator.generate(leaves)

        await Persistence.write(
            coverage_summaries_path,
            json.dumps(coverage_summaries, ensure_ascii=False),
        )

        produced_count = sum(
            1 for topic in coverage_summaries["topics"]
            if topic["coverageSummary"] != CoverageSummaryGenerator.EMPTY_SUMMARY_NOTE
        )
        print(
            f"[ProcessSyllabus] Persisted coverage summaries: "
            f"{produced_count}/{len(coverage_summaries['topics'])} topic(s) summarised."
        )

    async def __record_source_declarations(self, action_log: PaidDeckActionLog) -> None:
        """
        Writes the source declaration into the action trail: what was uploaded,
        its content hash, and the type it was declared as.

        This is the line the audit report leans on hardest — it is the positive
        evidence for what entered the pipeline, alongside the negative evidence
        that the mode accepted no other source type.
        """
        curriculum_sources, _ = self.__collect_syllabus_candidates()

        for extractable_source in curriculum_sources:
            information_source = extractable_source.get_information_source()
            await action_log.record_source_declaration(
                source_name = information_source.get_name(),
                content_hash = information_source.get_hash(),
                declared_source_type_name = InformationSourceTypes(information_source.get_source_type()).name,
            )
