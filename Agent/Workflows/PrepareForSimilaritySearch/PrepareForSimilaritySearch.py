from Workflows.Workflow import Workflow
from Globals.Classes.Decorators.ExtractableInformationSource import ExtractableInformationSource
from Globals.Classes.Generic.Persistence import Persistence
from Globals.Classes.Database.EmbeddingsQueryEngine import EmbeddingsQueryEngine
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Enumerations.InformationSourceTypes import InformationSourceTypes
from Globals.Utility.JoinPath import join_path
from Globals.Utility.ExpandPageRanges import expand_page_ranges

from Workflows.PrepareForSimilaritySearch.EmbedPages import load_model, embed_pages
from Globals.Utility.RedactSourceName import redact_source_name


class PrepareForSimilaritySearch(Workflow):

    EMBEDDABLE_SOURCE_TYPES = (
        InformationSourceTypes.PROVIDED_DOCUMENTS,
        InformationSourceTypes.CURRICULUM_OR_SYLLABUS,
    )

    def __init__(self, payload = {}):
        super().__init__(payload)
        self.__source: ExtractableInformationSource = ExtractableInformationSource.from_json(payload)

    async def __update_progress(self, completion: float):
        task = await TaskManager.get_current_task()
        task.set_completion(completion)
        await TaskManager.set_task(task)

    async def run(self, args = {}):
        # The reader import is function-local so the PDFium native binding load
        # stays gated behind "this workflow is actually about to run". For
        # non-PDF source types we exit before it fires.
        information_source = self.__source.get_information_source()
        source_type        = information_source.get_source_type()

        # ── Source-type guard: only upload-backed sources are embedded ─────────
        if source_type not in PrepareForSimilaritySearch.EMBEDDABLE_SOURCE_TYPES:
            print(
                f"[PrepareForSimilaritySearch] Skipping source '{redact_source_name(information_source.get_name())}' "
                f"(type={source_type}) — embeddings only stored for uploaded documents."
            )
            await self.__update_progress(1.0)
            return

        from Globals.Classes.Pdf.PdfDocumentReader import PdfDocumentReader

        print(f"Preparing '{redact_source_name(information_source.get_name())}' for similarity search...")

        # ── 1. Load PDF from persistence ───────────────────────────────────────
        pdf_path  = join_path("/", information_source.get_directory_path(), information_source.get_hash())
        pdf_bytes = await Persistence.read(pdf_path)

        await self.__update_progress(0.05)

        # ── 2. Resolve page ranges into concrete 1-indexed page numbers ───────
        with PdfDocumentReader(pdf_bytes) as pdf_reader:
            total_pages = pdf_reader.get_page_count()

        candidate_pages = expand_page_ranges(self.__source.get_page_ranges(), total_pages)
        print(f"Page range resolved to {len(candidate_pages)} candidate page(s) (total document pages: {total_pages}).")

        # ── 3. Determine which pages still need embeddings ─────────────────────
        pages_to_process = await EmbeddingsQueryEngine.get_pages_without_embeddings(self.__source, candidate_pages)

        if not pages_to_process:
            print("All requested pages already have embeddings — nothing to do.")
            await self.__update_progress(1.0)
            return

        print(f"{len(pages_to_process)} page(s) to embed: {pages_to_process}")
        await self.__update_progress(0.10)

        # ── 4. Load embedding model ────────────────────────────────────────────
        model = load_model()

        await self.__update_progress(0.20)

        # ── 5. Embed pages ─────────────────────────────────────────────────────
        embedding_documents, empty_pages = embed_pages(pdf_bytes, pages_to_process, model)

        await self.__update_progress(0.80)

        # ── 6. Persist embeddings ──────────────────────────────────────────────
        if embedding_documents:
            print(f"Upserting {len(embedding_documents)} embedding(s)...")
            await EmbeddingsQueryEngine.upsert_embeddings(self.__source, embedding_documents)

        # ── 7. Persist empty page placeholders ────────────────────────────────
        if empty_pages:
            print(f"{len(empty_pages)} empty page(s) — inserting placeholders: {empty_pages}")
            await EmbeddingsQueryEngine.upsert_empty_pages(self.__source, empty_pages)

        await self.__update_progress(1.0)

        print(
            f"Done. {len(embedding_documents)} embedding(s) stored, "
            f"{len(empty_pages)} empty page placeholder(s) stored."
        )
