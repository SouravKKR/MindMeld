import io
import json
import os
from urllib.parse import urlparse

import numpy as np
from sentence_transformers import SentenceTransformer

from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.Pools.ModelPool import ModelPool
from Globals.Classes.Database.DatabaseConnector import DatabaseConnector
from Globals.Classes.Decorators.ExtractableInformationSource import ExtractableInformationSource
from Globals.Classes.Generic.Persistence import Persistence
from Globals.Constants.DatabaseConstants import DatabaseConstants
from Globals.Constants.PersistenceConstants import PersistenceConstants
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Enumerations.InformationSourceTypes import InformationSourceTypes
from Globals.Utility.JoinPath import join_path
from Globals.Utility.StripJsonMarkdown import strip_json_markdown
from Globals.Utility.ExpandPageRanges import expand_page_ranges
from Workflows.Workflow import Workflow
from Workflows.PrepareImages.HtmlInjector import HtmlInjector
from Workflows.PrepareImages.ImageExtractor import ImageExtractor
from Workflows.PrepareImages.ReferenceNormalizer import ReferenceNormalizer


_FIGURES_GCS_PREFIX = "figures"
_VISION_BATCH_SIZE = 10
_WEB_SOURCE_HASH_MARKER = "__web__"
_WEB_CACHE_TOPICS_PREFIX = "web_cache/topics"

_DOCUMENT_SOURCE_TYPES = (
    InformationSourceTypes.PROVIDED_DOCUMENTS,
    InformationSourceTypes.CURRICULUM_OR_SYLLABUS,
)


class PrepareImages(Workflow):

    _EMBED_MODEL_NAME = "sentence-transformers/all-mpnet-base-v2"
    _SENTENCE_EMBED_BATCH_SIZE = 32
    _STUDY_MATERIAL_SIMILARITY_THRESHOLD = 0.70
    _CARD_SIMILARITY_THRESHOLD = 0.70
    _MAX_FIGURES_PER_CARD = 1
    _TOP_CANDIDATES_PER_FIGURE = 2

    def __init__(self, payload={}):
        super().__init__(payload)
        self._generation_task_id = os.getenv("MAIN_TASK_ID")
        self._image_sources = [
            ExtractableInformationSource.from_json(source_json)
            for source_json in payload.get("imageSources", [])
        ]
        self._generate_study_materials = payload.get("generateStudyMaterials", True)
        self._generate_flashcards = payload.get("generateFlashcards", True)

    @staticmethod
    def _cosine_similarity(vector_a: list, vector_b: list) -> float:
        array_a = np.array(vector_a)
        array_b = np.array(vector_b)
        norm_a = np.linalg.norm(array_a)
        norm_b = np.linalg.norm(array_b)

        if norm_a == 0 or norm_b == 0:
            return 0.0

        return float(np.dot(array_a, array_b) / (norm_a * norm_b))

    async def _load_json_files_from_prefix(self, gcs_prefix: str) -> list[dict]:
        file_paths = await Persistence.list(gcs_prefix)
        loaded_files = []

        for file_path in file_paths:
            if not file_path.endswith(".json"):
                continue

            try:
                file_bytes = await Persistence.read(file_path)
                file_data = json.loads(file_bytes.decode("utf-8"))
                file_data["_filePath"] = file_path
                loaded_files.append(file_data)
            except Exception as load_error:
                print(f"[PrepareImages] Skipping unreadable file {file_path}: {load_error}")

        return loaded_files

    async def _load_web_figures(self) -> list[dict]:
        """
        Walks the per-task web cache and produces figure dicts compatible with the
        PDF-extraction figure shape, marked with _isWebFigure=True so downstream
        logic can attribute their source and skip MongoDB persistence.

        Returns an empty list when no web cache exists for this task.
        """
        if not self._generation_task_id:
            return []

        from PIL import Image
        import imagehash

        web_cache_prefix = join_path(
            "/",
            PersistenceConstants.TASKS_DIRECTORY,
            self._generation_task_id,
            _WEB_CACHE_TOPICS_PREFIX,
        )

        try:
            topic_cache_files = await Persistence.list(web_cache_prefix)
        except Exception as list_error:
            print(f"[PrepareImages] Web cache listing failed at {web_cache_prefix}: {list_error}")
            return []

        if not topic_cache_files:
            return []

        web_figures: list[dict] = []
        seen_local_paths: set = set()

        for cache_file_path in topic_cache_files:
            if not cache_file_path.endswith(".json"):
                continue

            try:
                file_bytes = await Persistence.read(cache_file_path)
                cache_document = json.loads(file_bytes.decode("utf-8"))
            except Exception as read_error:
                print(f"[PrepareImages] Could not read web cache file {cache_file_path}: {read_error}")
                continue

            for fetched_page in cache_document.get("fetched", []) or []:
                source_page_url = fetched_page.get("url") or ""
                page_domain     = fetched_page.get("domain") or (urlparse(source_page_url).hostname or "web")

                for image_entry in fetched_page.get("images", []) or []:
                    local_cache_path = image_entry.get("localCachePath") or ""
                    if not local_cache_path or local_cache_path in seen_local_paths:
                        continue
                    seen_local_paths.add(local_cache_path)

                    try:
                        image_bytes = await Persistence.read(local_cache_path)
                    except Exception as image_read_error:
                        print(f"[PrepareImages] Could not read web image {local_cache_path}: {image_read_error}")
                        continue

                    if not image_bytes or len(image_bytes) < 1024:
                        continue

                    try:
                        pil_image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
                        perceptual_hash = str(imagehash.phash(pil_image))
                    except Exception as decode_error:
                        print(f"[PrepareImages] Could not decode web image {local_cache_path}: {decode_error}")
                        continue

                    caption_text = (image_entry.get("captionText") or "").strip()

                    web_figures.append({
                        "pageNumber":            None,
                        "boundingBoxCoordinates": None,
                        "captionText":           caption_text,
                        "figureRef":             None,
                        "perceptualImageHash":   perceptual_hash,
                        "imageBytes":            image_bytes,
                        "_isWebFigure":          True,
                        "_sourceUrl":            image_entry.get("sourceUrl") or "",
                        "_sourcePageUrl":        source_page_url,
                    })

        print(f"[PrepareImages] Loaded {len(web_figures)} web figure(s) from {len(topic_cache_files)} cache file(s).")
        return web_figures

    def _build_reference_assignments(
        self,
        all_extracted_figures: list[dict],
        study_material_files: list[dict],
        flashcard_files: list[dict],
    ) -> tuple[dict, dict]:
        sm_assignments: dict = {}
        card_assignments: dict = {}

        for figure_index, figure in enumerate(all_extracted_figures):
            figure_ref = figure.get("figureRef") or ReferenceNormalizer.extract_from_caption(
                figure.get("captionText", "")
            )
            if not figure_ref:
                continue

            for sm_index, sm_file in enumerate(study_material_files):
                blocks = HtmlInjector.extract_block_elements(sm_file.get("content", ""))
                for block_index, block in enumerate(blocks):
                    if figure_ref in ReferenceNormalizer.extract_from_text(block["text"]):
                        sm_assignments[figure_index] = {
                            "study_material_index": sm_index,
                            "block_index": block_index,
                            "score": 1.0,
                        }

            matched_card_positions: list[dict] = []
            for fc_file_index, fc_file in enumerate(flashcard_files):
                for card_index, card in enumerate(fc_file.get("cards", [])):
                    for field_name, html_content in [
                        ("question", card.get("question", "")),
                        ("answer", card.get("answer", "")),
                    ]:
                        blocks = HtmlInjector.extract_block_elements(html_content)
                        for block_index, block in enumerate(blocks):
                            if figure_ref in ReferenceNormalizer.extract_from_text(block["text"]):
                                matched_card_positions.append({
                                    "flashcard_file_index": fc_file_index,
                                    "card_index": card_index,
                                    "field_name": field_name,
                                    "block_index": block_index,
                                })

            if matched_card_positions:
                card_assignments[figure_index] = matched_card_positions

        return sm_assignments, card_assignments

    async def _validate_figures_with_vision(
        self,
        extracted_figures: list[dict],
        source_hash: str,
        embedding_model: SentenceTransformer,
        persist_to_database: bool = True,
    ) -> list[dict]:
        """
        Phase 3: (optional DB cache check) → Gemini batch validation → embed + (optional persist).
        Returns only educational figures, each with a `textEmbedding` field added.
        When persist_to_database is False (web-sourced images), the figures collection
        and GCS `figures/` prefix are never touched — only per-task local files exist.
        """
        cached_figures = []
        uncached_figures = list(extracted_figures)

        if persist_to_database:
            db = await DatabaseConnector.get_database()
            figures_collection = db[DatabaseConstants.FIGURES_COLLECTION]

            existing_records = list(figures_collection.find(
                {"informationSourceHash": source_hash},
                {"perceptualImageHash": 1, "textEmbedding": 1, "captionText": 1, "_id": 0}
            ))
            cached_hashes = {rec["perceptualImageHash"]: rec for rec in existing_records}

            cached_figures = []
            uncached_figures = []

            for figure in extracted_figures:
                phash = figure["perceptualImageHash"]
                if phash in cached_hashes:
                    figure["textEmbedding"] = cached_hashes[phash]["textEmbedding"]
                    cached_figures.append(figure)
                else:
                    uncached_figures.append(figure)

            print(
                f"[PrepareImages] {len(cached_figures)} cached, "
                f"{len(uncached_figures)} uncached figure(s) for source {source_hash}."
            )
        else:
            print(
                f"[PrepareImages] {len(uncached_figures)} web figure(s) — skipping DB cache and persistence."
            )

        if not uncached_figures:
            return cached_figures

        model_name, provider_class = ModelPool.IMAGE_VALIDATION_MODEL
        caller = AutomationCaller(provider_class())

        validated_new_figures = []

        for batch_start in range(0, len(uncached_figures), _VISION_BATCH_SIZE):
            batch = uncached_figures[batch_start: batch_start + _VISION_BATCH_SIZE]
            batch_size = len(batch)

            inputs = [
                AutomationContent(
                    AutomationContentTypes.SYSTEM,
                    "You are an expert educational content validator evaluating images extracted from textbooks and lecture slide decks. You will receive multiple images. Evaluate each one."
                ),
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    (
                        f"Look at these {batch_size} images. Are they meaningful educational visual aids? "
                        f"Valid visual aids include charts, graphs, flowcharts, tables, organizational hierarchies, "
                        f"and conceptual infographics. "
                        f"Crucial Instruction: Do NOT reject an image just because it contains a lot of text, "
                        f"provided the text is structured visually (e.g., inside colored blocks, connected by arrows, "
                        f"or formatted as a table). "
                        f"Reject ONLY pure decorative elements, plain background patterns, company logos, "
                        f"and meaningless user interface artifacts. "
                        f"Reply strictly with a JSON array containing exactly {batch_size} objects. "
                        f"Each object must have imageCategory (string), isEducationalContent (boolean), and "
                        f"visionModelGeneratedDescription (string). "
                        f"If false, leave the description empty. "
                        f"If true, write a dense 2-sentence description of the visual concept."
                    ),
                ),
            ]
            for figure in batch:
                inputs.append(AutomationContent(AutomationContentTypes.IMAGE, figure["imageBytes"]))

            request = AutomationRequest(model=model_name, inputs=inputs)

            try:
                response = await caller.call(request, validator=None)
            except Exception as call_error:
                # Transient API failures (503 UNAVAILABLE, rate limits, deadline-expired)
                # should not crash the entire PrepareImages workflow. Skip this batch
                # and continue with the next — losing one batch of figures is far better
                # than losing all the validated figures collected so far.
                print(f"[PrepareImages] Validation batch {batch_start} raised: {call_error} — skipping batch.")
                continue

            if response is None:
                print(f"[PrepareImages] Validation batch {batch_start} got no response — skipping.")
                continue

            raw_text = response.get_output(0).get_data()
            parsed = strip_json_markdown(raw_text)

            if not isinstance(parsed, list) or len(parsed) != batch_size:
                print(f"[PrepareImages] Validation batch {batch_start} returned unexpected format — skipping.")
                continue

            combined_texts_for_embedding = []
            educational_indices = []

            for item_index, result in enumerate(parsed):
                if not isinstance(result, dict) or not result.get("isEducationalContent"):
                    continue
                description = result.get("visionModelGeneratedDescription", "")
                caption = batch[item_index].get("captionText", "")
                combined_text = f"{caption} {description}".strip()
                combined_texts_for_embedding.append(combined_text)
                educational_indices.append((item_index, description, combined_text))

            if not combined_texts_for_embedding:
                continue

            embeddings = embedding_model.encode(
                combined_texts_for_embedding,
                batch_size=PrepareImages._SENTENCE_EMBED_BATCH_SIZE,
                show_progress_bar=False,
            )

            for embed_offset, (item_index, description, combined_text) in enumerate(educational_indices):
                figure = batch[item_index]
                text_embedding = embeddings[embed_offset].tolist()

                if persist_to_database:
                    gcs_path = f"{_FIGURES_GCS_PREFIX}/{figure['perceptualImageHash']}.png"
                    await Persistence.write(gcs_path, figure["imageBytes"])

                    document = {
                        "informationSourceHash": source_hash,
                        "perceptualImageHash": figure["perceptualImageHash"],
                        "pageNumber": figure["pageNumber"],
                        "boundingBoxCoordinates": figure["boundingBoxCoordinates"],
                        "captionText": figure["captionText"],
                        "visionModelGeneratedDescription": description,
                        "textEmbedding": text_embedding,
                        "gcsPath": gcs_path,
                    }
                    figures_collection.update_one(
                        {"perceptualImageHash": figure["perceptualImageHash"]},
                        {"$set": document},
                        upsert=True,
                    )

                figure["textEmbedding"] = text_embedding
                validated_new_figures.append(figure)

        print(
            f"[PrepareImages] {len(validated_new_figures)} new educational figure(s) validated and persisted."
        )
        return cached_figures + validated_new_figures

    async def _verify_pairs_with_vision(self, pairs: list[dict]) -> list[bool]:
        """
        Tier 3: Sends (image, text) pairs to Gemini for boolean yes/no verification.
        Returns a list of booleans parallel to `pairs`.
        """
        model_name, provider_class = ModelPool.IMAGE_VERIFICATION_MODEL
        caller = AutomationCaller(provider_class())

        results = [False] * len(pairs)

        for batch_start in range(0, len(pairs), _VISION_BATCH_SIZE):
            batch = pairs[batch_start: batch_start + _VISION_BATCH_SIZE]
            batch_size = len(batch)

            inputs = [
                AutomationContent(
                    AutomationContentTypes.SYSTEM,
                    "You are a strict visual-content relevance verifier."
                ),
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    (
                        f"You will be provided with {batch_size} images, each paired with a specific "
                        f"flashcard or study text. Does the image directly help answer or visually "
                        f"explain the exact concept in its paired text? "
                        f"Reply strictly with a JSON array containing exactly {batch_size} boolean "
                        f"values (true or false) representing your verification."
                    ),
                ),
            ]
            for pair in batch:
                inputs.append(AutomationContent(AutomationContentTypes.IMAGE, pair["imageBytes"]))
                inputs.append(AutomationContent(AutomationContentTypes.TEXT, pair["candidateText"]))

            request = AutomationRequest(model=model_name, inputs=inputs)

            try:
                response = await caller.call(request, validator=None)
            except Exception as call_error:
                # Same transient-error guard as _validate_figures_with_vision.
                print(f"[PrepareImages] Verification batch {batch_start} raised: {call_error} — defaulting to False.")
                continue

            if response is None:
                print(f"[PrepareImages] Verification batch {batch_start} got no response — defaulting to False.")
                continue

            raw_text = response.get_output(0).get_data()
            parsed = strip_json_markdown(raw_text)

            if not isinstance(parsed, list) or len(parsed) != batch_size:
                print(f"[PrepareImages] Verification batch {batch_start} returned unexpected format — defaulting to False.")
                continue

            for offset, verdict in enumerate(parsed):
                if isinstance(verdict, bool):
                    results[batch_start + offset] = verdict

        return results

    async def run(self, args={}):
        # ── 1. Extract figures from every image source PDF ─────────────────────
        figures_by_source: list[tuple[str, list[dict]]] = []

        if self._image_sources:
            print("[PrepareImages] Extracting figures from image source PDFs...")
            image_extractor = ImageExtractor()
        else:
            image_extractor = None
            print("[PrepareImages] No PDF image sources provided — looking for web-sourced images instead.")

        for extractable_source in (self._image_sources or []):
            information_source = extractable_source.get_information_source()

            # Skip non-document sources — figure extraction only applies to uploaded PDFs.
            if information_source.get_source_type() not in _DOCUMENT_SOURCE_TYPES:
                print(
                    f"[PrepareImages] Skipping source '{information_source.get_name()}' "
                    f"(type={information_source.get_source_type()}) — figure extraction only applies to uploaded documents."
                )
                continue

            source_pdf_path = join_path(
                "/",
                information_source.get_directory_path(),
                information_source.get_hash()
            )

            try:
                pdf_bytes = await Persistence.read(source_pdf_path)
            except Exception as read_error:
                print(f"[PrepareImages] Could not read PDF '{information_source.get_name()}': {read_error}")
                continue

            import fitz
            pdf_document_for_count = fitz.open(stream=pdf_bytes, filetype="pdf")
            total_pages = pdf_document_for_count.page_count
            pdf_document_for_count.close()

            allowed_pages = set(expand_page_ranges(extractable_source.get_page_ranges(), total_pages))

            extracted_figures = image_extractor.extract_figures(
                pdf_bytes,
                allowed_pages=allowed_pages if len(allowed_pages) != total_pages else None,
            )
            figures_by_source.append((information_source.get_hash(), extracted_figures))
            print(f"[PrepareImages] Extracted {len(extracted_figures)} figure(s) from '{information_source.get_name()}' (pages: {len(allowed_pages)}).")

        # ── 1b. Load web-sourced images from per-task cache (no MongoDB writes) ─
        web_figures = await self._load_web_figures()

        if not figures_by_source and not web_figures:
            print("[PrepareImages] No figures extracted from PDFs or web cache — skipping injection.")
            return

        # ── 2. Load generated study material and flashcard JSON files ───────────
        study_material_files = []
        flashcard_files = []

        if self._generate_study_materials:
            study_material_prefix = join_path(
                "/",
                PersistenceConstants.TASKS_DIRECTORY,
                self._generation_task_id,
                PersistenceConstants.STUDY_MATERIALS_DIRECTORY
            )
            study_material_files = await self._load_json_files_from_prefix(study_material_prefix)
            print(f"[PrepareImages] Loaded {len(study_material_files)} study material file(s).")

        if self._generate_flashcards:
            flashcard_prefix = join_path(
                "/",
                PersistenceConstants.TASKS_DIRECTORY,
                self._generation_task_id,
                PersistenceConstants.FLASHCARDS_DIRECTORY
            )
            flashcard_files = await self._load_json_files_from_prefix(flashcard_prefix)
            print(f"[PrepareImages] Loaded {len(flashcard_files)} flashcard file(s).")

        if not study_material_files and not flashcard_files:
            print("[PrepareImages] No generated content files found — skipping injection.")
            return

        # ── 3. Load embedding model ─────────────────────────────────────────────
        print("[PrepareImages] Loading sentence embedding model...")
        embedding_model = SentenceTransformer(PrepareImages._EMBED_MODEL_NAME)

        # ── 4. Phase 3: Vision validation with DB cache ─────────────────────────
        print("[PrepareImages] Running vision validation...")
        all_validated_figures: list[dict] = []

        for source_hash, extracted_figures in figures_by_source:
            validated = await self._validate_figures_with_vision(
                extracted_figures, source_hash, embedding_model, persist_to_database=True
            )
            all_validated_figures.extend(validated)

        if web_figures:
            validated_web = await self._validate_figures_with_vision(
                web_figures, _WEB_SOURCE_HASH_MARKER, embedding_model, persist_to_database=False
            )
            all_validated_figures.extend(validated_web)

        if not all_validated_figures:
            print("[PrepareImages] No educational figures found — skipping injection.")
            return

        print(f"[PrepareImages] {len(all_validated_figures)} total educational figure(s) after validation.")

        # ── 5. Tier 1: Reference-based assignments ──────────────────────────────
        print("[PrepareImages] Building reference-based assignments (Tier 1)...")
        reference_sm_assignments, reference_card_assignments = self._build_reference_assignments(
            all_validated_figures, study_material_files, flashcard_files
        )
        reference_match_count = len(reference_sm_assignments) + len(reference_card_assignments)
        print(f"[PrepareImages] {reference_match_count} figure(s) matched via explicit reference.")

        # ── 6. Extract sentence records for Tier 2 semantic matching ───────────
        study_material_sentence_records = []

        for study_material_index, study_material_file in enumerate(study_material_files):
            content_html = study_material_file.get("content", "")
            block_elements = HtmlInjector.extract_block_elements(content_html)

            for block_index, block_element in enumerate(block_elements):
                for sentence_text in block_element["sentences"]:
                    study_material_sentence_records.append({
                        "study_material_index": study_material_index,
                        "block_index": block_index,
                        "sentence_text": sentence_text,
                        "embedding": None,
                    })

        card_sentence_records = []

        for flashcard_file_index, flashcard_file in enumerate(flashcard_files):
            for card_index, card in enumerate(flashcard_file.get("cards", [])):
                for field_name, html_content in [
                    ("question", card.get("question", "")),
                    ("answer", card.get("answer", "")),
                ]:
                    block_elements = HtmlInjector.extract_block_elements(html_content)

                    for block_index, block_element in enumerate(block_elements):
                        for sentence_text in block_element["sentences"]:
                            card_sentence_records.append({
                                "flashcard_file_index": flashcard_file_index,
                                "card_index": card_index,
                                "field_name": field_name,
                                "block_index": block_index,
                                "sentence_text": sentence_text,
                                "embedding": None,
                            })

        # ── 7. Embed all sentence records ───────────────────────────────────────
        all_sentence_texts = (
            [r["sentence_text"] for r in study_material_sentence_records]
            + [r["sentence_text"] for r in card_sentence_records]
        )

        if all_sentence_texts:
            print(f"[PrepareImages] Embedding {len(all_sentence_texts)} sentence(s)...")
            all_embeddings = embedding_model.encode(
                all_sentence_texts,
                batch_size=PrepareImages._SENTENCE_EMBED_BATCH_SIZE,
                show_progress_bar=False,
            )

            sm_offset = 0
            for record_index, record in enumerate(study_material_sentence_records):
                record["embedding"] = all_embeddings[sm_offset + record_index].tolist()

            card_offset = len(study_material_sentence_records)
            for record_index, record in enumerate(card_sentence_records):
                record["embedding"] = all_embeddings[card_offset + record_index].tolist()

        # ── 8. Tier 2: Semantic candidate selection (0.70 threshold) ───────────
        # For each figure, find top N candidate SM blocks and card fields.
        # Candidates are stored as proposal dicts for Tier 3 batch verification.
        sm_proposals: list[dict] = []
        card_proposals: list[dict] = []

        for figure_index, figure in enumerate(all_validated_figures):
            if figure_index in reference_sm_assignments:
                continue

            figure_embedding = figure["textEmbedding"]
            best_score_per_study_material: dict[int, dict] = {}

            for sentence_record in study_material_sentence_records:
                sm_index = sentence_record["study_material_index"]
                score = PrepareImages._cosine_similarity(
                    figure_embedding, sentence_record["embedding"]
                )
                existing = best_score_per_study_material.get(sm_index)
                if existing is None or score > existing["score"]:
                    best_score_per_study_material[sm_index] = {
                        "score": score,
                        "block_index": sentence_record["block_index"],
                        "sentence_text": sentence_record["sentence_text"],
                    }

            qualifying_sm = [
                (sm_index, data)
                for sm_index, data in best_score_per_study_material.items()
                if data["score"] >= PrepareImages._STUDY_MATERIAL_SIMILARITY_THRESHOLD
            ]
            qualifying_sm.sort(key=lambda x: x[1]["score"], reverse=True)

            for sm_index, data in qualifying_sm[:PrepareImages._TOP_CANDIDATES_PER_FIGURE]:
                sm_proposals.append({
                    "figure_index": figure_index,
                    "study_material_index": sm_index,
                    "block_index": data["block_index"],
                    "score": data["score"],
                    "candidateText": data["sentence_text"],
                    "imageBytes": figure["imageBytes"],
                })

        for figure_index, figure in enumerate(all_validated_figures):
            if figure_index in reference_card_assignments:
                continue

            figure_embedding = figure["textEmbedding"]
            best_score_per_card: dict[tuple, dict] = {}

            for sentence_record in card_sentence_records:
                card_key = (
                    sentence_record["flashcard_file_index"],
                    sentence_record["card_index"],
                )
                score = PrepareImages._cosine_similarity(
                    figure_embedding, sentence_record["embedding"]
                )
                existing = best_score_per_card.get(card_key)
                if existing is None or score > existing["score"]:
                    best_score_per_card[card_key] = {
                        "score": score,
                        "field_name": sentence_record["field_name"],
                        "block_index": sentence_record["block_index"],
                        "sentence_text": sentence_record["sentence_text"],
                    }

            qualifying_cards = [
                (card_key, data)
                for card_key, data in best_score_per_card.items()
                if data["score"] >= PrepareImages._CARD_SIMILARITY_THRESHOLD
            ]
            qualifying_cards.sort(key=lambda x: x[1]["score"], reverse=True)

            for card_key, data in qualifying_cards[:PrepareImages._TOP_CANDIDATES_PER_FIGURE]:
                card_proposals.append({
                    "figure_index": figure_index,
                    "flashcard_file_index": card_key[0],
                    "card_index": card_key[1],
                    "field_name": data["field_name"],
                    "block_index": data["block_index"],
                    "score": data["score"],
                    "candidateText": data["sentence_text"],
                    "imageBytes": figure["imageBytes"],
                })

        print(
            f"[PrepareImages] Tier 2 produced {len(sm_proposals)} SM proposal(s) "
            f"and {len(card_proposals)} card proposal(s). Running Tier 3 verification..."
        )

        # ── 9. Tier 3: LLM batch verification ──────────────────────────────────
        verified_sm_assignments: dict = {}
        verified_card_assignments: dict = {}

        if sm_proposals:
            sm_verdicts = await self._verify_pairs_with_vision(sm_proposals)
            for proposal, verdict in zip(sm_proposals, sm_verdicts):
                if not verdict:
                    continue
                fig_idx = proposal["figure_index"]
                if fig_idx not in verified_sm_assignments:
                    verified_sm_assignments[fig_idx] = {
                        "study_material_index": proposal["study_material_index"],
                        "block_index": proposal["block_index"],
                        "score": proposal["score"],
                    }

        if card_proposals:
            card_verdicts = await self._verify_pairs_with_vision(card_proposals)
            for proposal, verdict in zip(card_proposals, card_verdicts):
                if not verdict:
                    continue
                fig_idx = proposal["figure_index"]
                if fig_idx not in verified_card_assignments:
                    verified_card_assignments[fig_idx] = []
                verified_card_assignments[fig_idx].append({
                    "flashcard_file_index": proposal["flashcard_file_index"],
                    "card_index": proposal["card_index"],
                    "field_name": proposal["field_name"],
                    "block_index": proposal["block_index"],
                })

        # ── 10. Merge reference assignments over semantic/verified ones ─────────
        figure_to_study_material_assignment = {
            **verified_sm_assignments,
            **reference_sm_assignments,
        }
        figure_to_card_assignments = {
            **verified_card_assignments,
            **reference_card_assignments,
        }

        # ── 11. Assign unique figure numbers ────────────────────────────────────
        used_figure_indices = (
            set(figure_to_study_material_assignment.keys())
            | set(figure_to_card_assignments.keys())
        )

        figure_number_map = {}
        current_figure_number = 1

        for figure_index in sorted(used_figure_indices):
            figure_number_map[figure_index] = current_figure_number
            current_figure_number += 1

        # ── 12. Inject figures into study material HTML ─────────────────────────
        study_material_index_to_figure_assignments: dict[int, list] = {}

        for figure_index, assignment in figure_to_study_material_assignment.items():
            target_sm_index = assignment["study_material_index"]
            study_material_index_to_figure_assignments.setdefault(target_sm_index, []).append({
                "figure_index": figure_index,
                "block_index": assignment["block_index"],
            })

        for sm_index, figure_assignments in study_material_index_to_figure_assignments.items():
            content_html = study_material_files[sm_index]["content"]
            block_elements = HtmlInjector.extract_block_elements(content_html)

            if not block_elements:
                continue

            sorted_ascending = sorted(figure_assignments, key=lambda a: a["block_index"])

            for figure_assignment in reversed(sorted_ascending):
                figure = all_validated_figures[figure_assignment["figure_index"]]
                target_block_index = min(figure_assignment["block_index"], len(block_elements) - 1)
                figure_html = HtmlInjector.build_figure_html(
                    figure["imageBytes"],
                    figure["captionText"],
                    figure_number_map[figure_assignment["figure_index"]],
                    source_url      = figure.get("_sourceUrl") if figure.get("_isWebFigure") else None,
                    source_page_url = figure.get("_sourcePageUrl") if figure.get("_isWebFigure") else None,
                    bounding_box    = figure.get("boundingBoxCoordinates"),
                )
                insertion_position = block_elements[target_block_index]["end"]
                content_html = HtmlInjector.inject_figure_after_block(
                    content_html, insertion_position, figure_html
                )

            study_material_files[sm_index]["content"] = content_html

        for study_material_file in study_material_files:
            if "_filePath" not in study_material_file:
                continue
            original_file_path = study_material_file.pop("_filePath")
            await Persistence.write(
                original_file_path,
                json.dumps(study_material_file, ensure_ascii=False)
            )

        print(
            f"[PrepareImages] Injected figures into "
            f"{len(study_material_index_to_figure_assignments)} study material file(s)."
        )

        # ── 13. Inject figures into flashcard HTML ──────────────────────────────
        card_field_key_to_figure_assignments: dict[tuple, list] = {}

        for figure_index, card_assignments_list in figure_to_card_assignments.items():
            for card_assignment in card_assignments_list:
                card_field_key = (
                    card_assignment["flashcard_file_index"],
                    card_assignment["card_index"],
                    card_assignment["field_name"],
                )
                card_field_key_to_figure_assignments.setdefault(card_field_key, []).append({
                    "figure_index": figure_index,
                    "block_index": card_assignment["block_index"],
                })

        for (
            flashcard_file_index, card_index, field_name
        ), figure_assignments in card_field_key_to_figure_assignments.items():
            card = flashcard_files[flashcard_file_index]["cards"][card_index]
            field_html = card[field_name]
            block_elements = HtmlInjector.extract_block_elements(field_html)

            if not block_elements:
                continue

            capped = sorted(
                figure_assignments,
                key=lambda a: all_validated_figures[a["figure_index"]].get("_score", 0.0),
                reverse=True,
            )[:PrepareImages._MAX_FIGURES_PER_CARD]

            sorted_ascending = sorted(capped, key=lambda a: a["block_index"])

            for figure_assignment in reversed(sorted_ascending):
                figure = all_validated_figures[figure_assignment["figure_index"]]
                target_block_index = min(figure_assignment["block_index"], len(block_elements) - 1)
                figure_html = HtmlInjector.build_figure_html(
                    figure["imageBytes"],
                    figure["captionText"],
                    figure_number_map[figure_assignment["figure_index"]],
                    source_url      = figure.get("_sourceUrl") if figure.get("_isWebFigure") else None,
                    source_page_url = figure.get("_sourcePageUrl") if figure.get("_isWebFigure") else None,
                    bounding_box    = figure.get("boundingBoxCoordinates"),
                )
                insertion_position = block_elements[target_block_index]["end"]
                field_html = HtmlInjector.inject_figure_after_block(
                    field_html, insertion_position, figure_html
                )

            flashcard_files[flashcard_file_index]["cards"][card_index][field_name] = field_html

        modified_flashcard_file_indices = set(
            key[0] for key in card_field_key_to_figure_assignments.keys()
        )

        for flashcard_file_index in modified_flashcard_file_indices:
            flashcard_file = flashcard_files[flashcard_file_index]

            if "_filePath" not in flashcard_file:
                continue

            original_file_path = flashcard_file.pop("_filePath")
            await Persistence.write(
                original_file_path,
                json.dumps(flashcard_file, ensure_ascii=False)
            )

        print(
            f"[PrepareImages] Injected figures into cards across "
            f"{len(modified_flashcard_file_indices)} flashcard file(s)."
        )
        print(
            f"[PrepareImages] Done. {len(figure_number_map)} unique figure(s) assigned."
        )
