import io
import json
import os
from urllib.parse import urlparse

from sentence_transformers import SentenceTransformer

from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.Pools.ModelPool import ModelPool
from Globals.Classes.Automation.Pools.PromptPool import PromptPool
from Globals.Classes.Database.DatabaseConnector import DatabaseConnector
from Globals.Classes.Decorators.ExtractableInformationSource import ExtractableInformationSource
from Globals.Classes.Generic.Persistence import Persistence
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Constants.DatabaseConstants import DatabaseConstants
from Globals.Constants.PersistenceConstants import PersistenceConstants
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Enumerations.InformationSourceTypes import InformationSourceTypes
from Globals.Utility.CosineSimilarity import cosine_similarity
from Globals.Utility.JoinPath import join_path
from Globals.Utility.StripJsonMarkdown import strip_json_markdown
from Globals.Utility.ExpandPageRanges import expand_page_ranges
from Workflows.Workflow import Workflow
from Workflows.PrepareImages.HtmlInjector import HtmlInjector
from Workflows.PrepareImages.ImageExtractor import ImageExtractor
from Workflows.PrepareImages.ReferenceNormalizer import ReferenceNormalizer
from Workflows.PrepareImages.PaidDeckVisualGenerator import PaidDeckVisualGenerator
from Workflows.PrepareImages.VisualNeedInferrer import VisualNeedInferrer
from Globals.Classes.Generation.PaidDeckActionLog import PaidDeckActionLog
from Globals.Utility.RedactSourceName import redact_source_name


_FIGURES_GCS_PREFIX = "figures"
_VISION_BATCH_SIZE = 10
_WEB_SOURCE_HASH_MARKER = "__web__"
_WEB_CACHE_TOPICS_PREFIX = "web_cache/topics"

# Per-task scratch path for figure bytes when EnhanceImages is enabled.
# Every figure referenced by the sidecar -- PDF-extracted AND web-sourced
# -- is staged here so EnhanceImages can fetch by hash without depending
# on the global figures/<hash>.png path. The global path can be stale on
# bucket resets even when the Mongo figures cache still holds the record,
# which previously surfaced as a 404 in EnhanceImages.
_FIGURE_SCRATCH_PREFIX = "figures_scratch"

# Sidecar file emitted by PrepareImages when EnhanceImages is enabled,
# consumed by EnhanceImages to drive injection. Lives at
# Tasks/{mainTaskId}/figure_assignments.json so EnhanceImages can find
# it by joining the per-task directory with this name.
_FIGURE_ASSIGNMENTS_SIDECAR_FILENAME = "figure_assignments.json"

_DOCUMENT_SOURCE_TYPES = (
    InformationSourceTypes.PROVIDED_DOCUMENTS,
    InformationSourceTypes.CURRICULUM_OR_SYLLABUS,
)


class PrepareImages(Workflow):

    # Checkpoint-resume completion marker (coarse). PrepareImages has several
    # "nothing to do" exit paths and no single output file, so completion is
    # marked explicitly. On resume, its presence skips re-extracting figures and
    # re-running Tier-3 verification; the figure-assignment sidecar it already
    # wrote stays in GCS for EnhanceImages to consume.
    _PREPARE_IMAGES_COMPLETE_MARKER_NAME = "_prepare_images_complete.json"

    _EMBED_MODEL_NAME = "sentence-transformers/all-mpnet-base-v2"
    _SENTENCE_EMBED_BATCH_SIZE = 32
    # Card relevance gate. Study materials from the uploaded document are placed
    # purely by source page (no threshold), but a figure only joins a card when
    # the question is genuinely relevant, so cards keep this similarity floor
    # before Tier 3 vision verification. 0.70 was too strict (academic
    # illustrations whose generated phrasing differed from the figure's caption +
    # description fell off); 0.45 too loose (topically-adjacent junk got in);
    # 0.58 is the tuned middle.
    _CARD_SIMILARITY_THRESHOLD = 0.58
    # Relevance gate for page-less figures (web-sourced, or document figures with
    # no usable page provenance) when placing into study materials. Document
    # figures that DO carry a page are placed by page with no threshold; this
    # floor only stops loosely-related supplementary web images from flooding the
    # lesson when there is no page to anchor them.
    _PAGELESS_STUDY_MATERIAL_SIMILARITY_THRESHOLD = 0.58
    _MAX_FIGURES_PER_CARD = 1
    _TOP_CANDIDATES_PER_FIGURE = 3

    def __init__(self, payload={}):
        super().__init__(payload)
        self._generation_task_id = os.getenv("MAIN_TASK_ID")
        self._image_sources = [
            ExtractableInformationSource.from_json(source_json)
            for source_json in payload.get("imageSources", [])
        ]
        self._generate_study_materials = payload.get("generateStudyMaterials", True)
        self._generate_flashcards = payload.get("generateFlashcards", True)
        # When True, skip the HTML-injection step and write a JSON
        # sidecar of figure assignments instead. EnhanceImages reads
        # that sidecar and does the injection with the enhanced figure
        # bytes directly, so intermediate JSONs never carry source
        # artwork.
        self._enhance_images_enabled = bool(payload.get("enhanceImagesEnabled", False))
        # Paid-deck mode: figures are GENERATED from the Phase 1 coverage
        # summaries instead of extracted from source PDFs. Everything after
        # figure acquisition — vision validation, embedding, page-less
        # placement, injection — is the same code path either way.
        self._paid_deck_mode = bool(payload.get("paidDeckMode", False))
        # Grounds generated visuals in the right discipline — "cell" means
        # something different in Biology and in Electronics.
        self._subject_name = payload.get("subjectName") or ""
        # Scopes inferred visuals to what the target exam actually expects a
        # student to read and draw, rather than to the subject in general.
        self._exam_name = payload.get("examName") or ""

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

    @staticmethod
    def _build_figure_html_for(figure: dict, figure_number: int) -> str:
        """
        Picks the figure renderer for one figure.

        A decomposed visual carries `compositeParts` and becomes one captioned
        plate — the pairing of each panel with its own label is the whole point
        of a comparison figure.

        A single generated symbolic visual carries `markupHtml` and is inlined as
        markup — that is what keeps its labels as real text and its geometry
        exact, which is the entire reason it was produced symbolically. Anything
        else (a PDF-extracted figure, a web image, a generated raster
        illustration) has bytes and goes through the base64 <img> path, with web
        figures keeping their source attribution.
        """
        composite_parts = figure.get("compositeParts")

        if composite_parts:
            composite_html = HtmlInjector.build_composite_figure_html(
                composite_parts,
                figure.get("captionText") or "",
                figure_number,
            )

            if composite_html:
                return composite_html

        markup_html = figure.get("markupHtml")

        if markup_html:
            return HtmlInjector.build_markup_figure_html(
                markup_html,
                figure.get("captionText") or "",
                figure_number,
            )

        return HtmlInjector.build_figure_html(
            figure["imageBytes"],
            figure["captionText"],
            figure_number,
            source_url      = figure.get("_sourceUrl") if figure.get("_isWebFigure") else None,
            source_page_url = figure.get("_sourcePageUrl") if figure.get("_isWebFigure") else None,
            bounding_box    = figure.get("boundingBoxCoordinates"),
        )

    async def _generate_paid_deck_visuals(self) -> list:
        """
        Produces the visuals the Phase 1 coverage summaries declared, routed by
        the kind each one was recorded with (VisualMethodRouter).

        Returned in the same figure shape the PDF extractor produces, so from
        here on the stage cannot tell them apart — with two deliberate
        differences carried on the dict: `markupHtml` (present for symbolic
        visuals, so the injector inlines markup instead of an <img>) and
        `_isGeneratedVisual` (so vision validation knows it is reviewing our own
        output rather than screening someone else's).
        """
        coverage_summaries_path = join_path(
            "/",
            PersistenceConstants.TASKS_DIRECTORY,
            self._generation_task_id,
            PersistenceConstants.COVERAGE_SUMMARIES_FILE_NAME,
        )

        try:
            summaries_bytes = await Persistence.read(coverage_summaries_path)
            coverage_summaries = json.loads(summaries_bytes.decode("utf-8"))
        except Exception as read_error:
            print(
                f"[PrepareImages] Paid-deck mode but no coverage summaries could be read "
                f"({read_error}) — no visuals will be generated."
            )
            return []

        action_log = PaidDeckActionLog(self._generation_task_id, "PrepareImages")

        generator = PaidDeckVisualGenerator(
            subject_name = self._subject_name,
            coverage_summaries = coverage_summaries,
            exam_name = self._exam_name,
            action_log = action_log,
        )
        return await generator.generate_all()

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

    # A generated visual and the study material it belongs to are named by two
    # different model calls, so their chains drift ("Physical And Chemical
    # Properties" against "Physical Properties"). Matching on the deepest shared
    # prefix absorbs that. One shared level is only the root deck name, which
    # every material shares and which therefore says nothing — two is the
    # shallowest match that actually locates a visual.
    _MINIMUM_SHARED_TOPIC_CHAIN_DEPTH = 2

    @staticmethod
    def _find_topic_chain_candidates(topic_chain, study_material_indices_by_topic_chain) -> list:
        """
        Finds the study materials a generated visual was requested for.

        Exact chain first; failing that, the materials sharing the deepest topic
        prefix with it. Without the prefix step an exact-match miss drops the
        visual onto the page-less similarity floor, where a perfectly good
        diagram is discarded for scoring 0.57 — which is how the EAS mechanism
        diagram vanished from a run that generated it successfully.
        """
        chain_key = PrepareImages._build_topic_chain_key(topic_chain)

        if not chain_key:
            return []

        exact_candidates = study_material_indices_by_topic_chain.get(chain_key)

        if exact_candidates:
            return exact_candidates

        deepest_shared_depth = 0
        deepest_candidates = []

        for candidate_key, candidate_indices in study_material_indices_by_topic_chain.items():
            shared_depth = 0

            for visual_topic_name, material_topic_name in zip(chain_key, candidate_key):
                if visual_topic_name != material_topic_name:
                    break
                shared_depth += 1

            if shared_depth > deepest_shared_depth:
                deepest_shared_depth = shared_depth
                deepest_candidates = candidate_indices

        if deepest_shared_depth >= PrepareImages._MINIMUM_SHARED_TOPIC_CHAIN_DEPTH:
            return deepest_candidates

        return []

    @staticmethod
    def _build_topic_chain_key(topic_chain) -> tuple:
        """
        Normalises a topic chain into a comparable key so a generated visual's
        chain and a study material's chain match despite incidental casing or
        whitespace differences between the two generators that wrote them.

        Returns an empty tuple for a missing or malformed chain, which never
        matches anything — a visual with no usable chain falls through to the
        similarity path rather than landing on an arbitrary material.
        """
        if not isinstance(topic_chain, (list, tuple)):
            return ()

        return tuple(
            str(topic_name).strip().casefold()
            for topic_name in topic_chain
            if str(topic_name or "").strip()
        )

    def _embed_generated_visuals(
        self,
        generated_visuals: list[dict],
        embedding_model: SentenceTransformer,
    ) -> list[dict]:
        """
        Prepares generated paid-deck visuals for placement without a vision screen.

        Their descriptions were written by the model that drew them and already
        survived PAID_DECK_VISUAL_REVIEW, so the description text is embedded
        directly. The embedding is what placement scores against, and it is the
        only thing FIGURE_VALIDATION would have contributed for a figure we
        produced ourselves.

        `informationSourceHash` is deliberately left as PaidDeckVisualGenerator
        set it: it marks the visual page-less for placement and records that it
        came from generation rather than from any user document.
        """
        if not generated_visuals:
            return []

        combined_texts = [
            f"{figure.get('captionText') or ''} {figure.get('_visualDescription') or ''}".strip()
            for figure in generated_visuals
        ]

        embeddings = embedding_model.encode(
            combined_texts,
            batch_size=PrepareImages._SENTENCE_EMBED_BATCH_SIZE,
            show_progress_bar=False,
        )

        for figure_index, figure in enumerate(generated_visuals):
            figure["textEmbedding"] = embeddings[figure_index].tolist()

        print(
            f"[PrepareImages] {len(generated_visuals)} generated visual(s) embedded directly "
            f"— already reviewed at generation time, so not re-screened."
        )

        return list(generated_visuals)

    async def _validate_figures_with_vision(
        self,
        extracted_figures: list[dict],
        owner_user_id: str,
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
                {"userId": owner_user_id, "informationSourceHash": source_hash},
                {"perceptualImageHash": 1, "textEmbedding": 1, "captionText": 1, "_id": 0}
            ))
            cached_hashes = {rec["perceptualImageHash"]: rec for rec in existing_records}

            cached_figures = []
            uncached_figures = []

            for figure in extracted_figures:
                phash = figure["perceptualImageHash"]
                if phash in cached_hashes:
                    figure["textEmbedding"] = cached_hashes[phash]["textEmbedding"]
                    figure["informationSourceHash"] = source_hash
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

        # Generated paid-deck visuals are our own output: PaidDeckVisualGenerator
        # already put every one of them through PAID_DECK_VISUAL_REVIEW and
        # discarded whatever failed. FIGURE_VALIDATION is the wrong second judge —
        # it is written to reject decorative scrapes out of someone else's PDF —
        # and several generated kinds (SMILES, MERMAID, KATEX,
        # LABELLED_DESCRIPTION) carry no raster bytes to show it in the first
        # place.
        generated_visuals = [figure for figure in uncached_figures if figure.get("_isGeneratedVisual")]
        screenable_figures = [figure for figure in uncached_figures if not figure.get("_isGeneratedVisual")]

        validated_new_figures = self._embed_generated_visuals(generated_visuals, embedding_model)

        # A figure carrying no raster bytes cannot be screened by a vision model,
        # and letting one into a batch is silently destructive rather than merely
        # useless: the provider drops non-bytes image parts, so the model is asked
        # about batch_size images while receiving fewer, its correspondingly
        # shorter reply fails the length check below, and the WHOLE batch — every
        # good figure in it — is thrown away.
        byte_carrying_figures = [
            figure for figure in screenable_figures
            if isinstance(figure.get("imageBytes"), bytes)
        ]
        unscreenable_count = len(screenable_figures) - len(byte_carrying_figures)

        if unscreenable_count:
            print(
                f"[PrepareImages] {unscreenable_count} figure(s) carried no raster bytes — "
                f"excluded from vision validation so the rest of their batch survives."
            )

        if not byte_carrying_figures:
            return cached_figures + validated_new_figures

        model_name, provider_class = ModelPool.IMAGE_VALIDATION_MODEL
        caller = AutomationCaller(provider_class())

        for batch_start in range(0, len(byte_carrying_figures), _VISION_BATCH_SIZE):
            batch = byte_carrying_figures[batch_start: batch_start + _VISION_BATCH_SIZE]
            batch_size = len(batch)

            inputs = [
                AutomationContent(
                    AutomationContentTypes.SYSTEM,
                    PromptPool.FIGURE_VALIDATION_SYSTEM,
                ),
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    PromptPool.FIGURE_VALIDATION_USER.format(batch_size=batch_size),
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
                    gcs_path = f"{_FIGURES_GCS_PREFIX}/{owner_user_id}/{figure['perceptualImageHash']}.png"
                    await Persistence.write(gcs_path, figure["imageBytes"])

                    document = {
                        "userId": owner_user_id,
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
                        {"userId": owner_user_id, "informationSourceHash": source_hash, "perceptualImageHash": figure["perceptualImageHash"]},
                        {"$set": document},
                        upsert=True,
                    )

                figure["textEmbedding"] = text_embedding
                figure["informationSourceHash"] = source_hash
                validated_new_figures.append(figure)

        print(
            f"[PrepareImages] {len(validated_new_figures)} new figure(s) approved for placement "
            f"({len(generated_visuals)} generated, {len(validated_new_figures) - len(generated_visuals)} screened)."
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
                    "You are a relevance verifier for academic study materials."
                ),
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    (
                        f"You will be provided with {batch_size} images, each paired with a specific "
                        f"flashcard or study text. Both come from the same source document the student "
                        f"uploaded. Return TRUE only when the image clearly illustrates, depicts, or "
                        f"visually supports the SAME specific topic that the paired text discusses. "
                        f"Return FALSE when the image is about a different topic (even a related one "
                        f"in the same broad subject area), when the image is generic decoration or a "
                        f"logo or a header/footer watermark, or when the image's subject matter is "
                        f"plainly different from the text's. Topical adjacency within the same broad "
                        f"subject is NOT enough — the image must depict the SAME specific concept the "
                        f"text is describing, not merely a sibling concept under the same parent. When "
                        f"in doubt, return FALSE — irrelevant images in a study deck are worse than a "
                        f"missing illustration. "
                        f"Reply strictly with a JSON array containing exactly {batch_size} boolean values."
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

    async def __inject_inline_into_files(
        self,
        all_validated_figures: list[dict],
        figure_to_study_material_assignment: dict,
        figure_to_card_assignments: dict,
        figure_number_map: dict,
        study_material_files: list[dict],
        flashcard_files: list[dict],
    ):
        """
        Inline-mode injection: builds figure HTML with the source bytes
        embedded as a base64 data URL and splices it into each affected
        block. Used when EnhanceImages is NOT enabled — the per-task
        JSONs end up carrying the source artwork as-is, and moveToDatabase
        persists them directly to the user library.
        """
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
                figure_html = PrepareImages._build_figure_html_for(
                    figure,
                    figure_number_map[figure_assignment["figure_index"]],
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
            f"[PrepareImages] Inline mode: injected figures into "
            f"{len(study_material_index_to_figure_assignments)} study material file(s)."
        )

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
                figure_html = PrepareImages._build_figure_html_for(
                    figure,
                    figure_number_map[figure_assignment["figure_index"]],
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
            f"[PrepareImages] Inline mode: injected figures into cards across "
            f"{len(modified_flashcard_file_indices)} flashcard file(s)."
        )

    async def __write_sidecar_and_stage_figure_bytes(
        self,
        all_validated_figures: list[dict],
        figure_to_study_material_assignment: dict,
        figure_to_card_assignments: dict,
        figure_number_map: dict,
        study_material_files: list[dict],
        flashcard_files: list[dict],
    ):
        """
        Sidecar-mode handoff: skips HTML injection entirely and writes a
        single JSON sidecar listing each assignment + the per-task scratch
        path where each figure's bytes are staged. Stages bytes for every
        referenced figure (PDF-extracted AND web-sourced) into the per-
        task scratch prefix so EnhanceImages can fetch them by hash
        without depending on the global figures/<phash>.png path -- that
        path can 404 when the Mongo figures cache outlives the GCS object
        (e.g. after a bucket reset).
        """
        # Figures referenced by the assignments only — we don't want to
        # waste writes staging figures that matched nothing.
        referenced_figure_indices = (
            set(figure_to_study_material_assignment.keys())
            | set(figure_to_card_assignments.keys())
        )

        for figure_index in referenced_figure_indices:
            figure = all_validated_figures[figure_index]
            scratch_path = self.__compute_figure_scratch_path(figure["perceptualImageHash"])
            await Persistence.write(scratch_path, figure["imageBytes"])

        assignments: list[dict] = []

        for figure_index, assignment in figure_to_study_material_assignment.items():
            figure = all_validated_figures[figure_index]
            target_sm_index = assignment["study_material_index"]
            study_material_file_path = study_material_files[target_sm_index].get("_filePath")
            if not study_material_file_path:
                continue
            assignments.append({
                "fileType":                "studyMaterial",
                "filePath":                study_material_file_path,
                "blockIndex":              assignment["block_index"],
                "figureNumber":            figure_number_map[figure_index],
                "perceptualHash":          figure["perceptualImageHash"],
                "captionText":             figure.get("captionText") or "",
                "boundingBoxCoordinates":  figure.get("boundingBoxCoordinates"),
                "isWebFigure":             bool(figure.get("_isWebFigure")),
                "sourceUrl":               figure.get("_sourceUrl") if figure.get("_isWebFigure") else None,
                "sourcePageUrl":           figure.get("_sourcePageUrl") if figure.get("_isWebFigure") else None,
                "gcsImagePath":            self.__compute_gcs_image_path(figure),
            })

        for figure_index, card_assignments_list in figure_to_card_assignments.items():
            figure = all_validated_figures[figure_index]
            for card_assignment in card_assignments_list:
                flashcard_file_path = flashcard_files[card_assignment["flashcard_file_index"]].get("_filePath")
                if not flashcard_file_path:
                    continue
                assignments.append({
                    "fileType":                "flashcard",
                    "filePath":                flashcard_file_path,
                    "cardIndex":               card_assignment["card_index"],
                    "fieldName":               card_assignment["field_name"],
                    "blockIndex":              card_assignment["block_index"],
                    "figureNumber":            figure_number_map[figure_index],
                    "perceptualHash":          figure["perceptualImageHash"],
                    "captionText":             figure.get("captionText") or "",
                    "boundingBoxCoordinates":  figure.get("boundingBoxCoordinates"),
                    "isWebFigure":             bool(figure.get("_isWebFigure")),
                    "sourceUrl":               figure.get("_sourceUrl") if figure.get("_isWebFigure") else None,
                    "sourcePageUrl":           figure.get("_sourcePageUrl") if figure.get("_isWebFigure") else None,
                    "gcsImagePath":            self.__compute_gcs_image_path(figure),
                    "matchScore":              figure.get("_score", 0.0),
                })

        sidecar_document = {
            "version":           1,
            "assignments":       assignments,
            "maxFiguresPerCard": PrepareImages._MAX_FIGURES_PER_CARD,
        }

        sidecar_path = self.__compute_sidecar_path()
        await Persistence.write(
            sidecar_path,
            json.dumps(sidecar_document, ensure_ascii=False),
        )

        print(
            f"[PrepareImages] Sidecar mode: wrote {len(assignments)} assignment(s) "
            f"to {sidecar_path}; staged {len(referenced_figure_indices)} figure(s) "
            f"into per-task scratch."
        )

    def __compute_sidecar_path(self) -> str:
        return join_path(
            "/",
            PersistenceConstants.TASKS_DIRECTORY,
            self._generation_task_id,
            _FIGURE_ASSIGNMENTS_SIDECAR_FILENAME,
        )

    def __compute_figure_scratch_path(self, perceptual_hash: str) -> str:
        return join_path(
            "/",
            PersistenceConstants.TASKS_DIRECTORY,
            self._generation_task_id,
            _FIGURE_SCRATCH_PREFIX,
            f"{perceptual_hash}.png",
        )

    def __compute_gcs_image_path(self, figure: dict) -> str:
        # Always reference the per-task scratch path -- bytes for every
        # referenced figure are staged there in sidecar mode so we never
        # depend on the global figures/<phash>.png object (which can be
        # missing on bucket resets even when the Mongo cache still holds
        # the record).
        return self.__compute_figure_scratch_path(figure["perceptualImageHash"])

    async def __update_progress(self, completion: float):
        # PrepareImages is a long, mostly-local stage (PDF figure extraction,
        # embedding, vision validation, injection). Without these milestones the
        # progress node sat at 0% for the whole run and read as a hang. Each
        # phase boundary nudges the bar so the user can see it advancing.
        current_task = await TaskManager.get_current_task()
        if current_task is None:
            return
        current_task.set_completion(completion)
        await TaskManager.set_task(current_task)

    def __completion_marker_path(self) -> str:
        return join_path(
            "/",
            PersistenceConstants.TASKS_DIRECTORY,
            self._generation_task_id,
            PrepareImages._PREPARE_IMAGES_COMPLETE_MARKER_NAME,
        )

    async def __finish(self):
        # Mark the stage complete (so a resume skips it) and flip progress to
        # 100%. Called at every normal exit so the marker exists regardless of
        # which "nothing to do" branch ended the run.
        await Persistence.write(self.__completion_marker_path(), json.dumps({"complete": True}))
        await self.__update_progress(1.0)

    async def run(self, args={}):
        # PrepareImages always reaches fitz via ImageExtractor — pay the
        # MuPDF silence cost once at the top so log noise stays out of
        # the worker pipe.
        from Globals.Classes.Generic.MuPdfBootstrap import MuPdfBootstrap
        MuPdfBootstrap.silence_parser_warnings()

        # Checkpoint-resume: skip the whole stage if it already completed in a
        # prior run (the figure-assignment sidecar it wrote is still in GCS for
        # EnhanceImages to consume).
        if await Persistence.exists(self.__completion_marker_path()):
            print("[PrepareImages] Already complete — reusing prior figure work (resume); skipping stage.")
            await self.__update_progress(1.0)
            return

        await self.__update_progress(0.02)

        # ── 1. Extract figures from every image source PDF ─────────────────────
        figures_by_source: list[tuple[str, list[dict]]] = []

        if self._image_sources:
            print("[PrepareImages] Extracting figures from image source PDFs...")
            image_extractor = ImageExtractor()
        else:
            image_extractor = None
            print("[PrepareImages] No PDF image sources provided — looking for web-sourced images instead.")

        # Figure extraction from large PDFs is the slowest opening phase, so
        # spread its progress across the source list (0.05 → 0.35).
        image_source_count = len(self._image_sources or [])
        processed_image_source_count = 0

        for extractable_source in (self._image_sources or []):
            information_source = extractable_source.get_information_source()

            # Skip non-document sources — figure extraction only applies to uploaded PDFs.
            if information_source.get_source_type() not in _DOCUMENT_SOURCE_TYPES:
                print(
                    f"[PrepareImages] Skipping source '{redact_source_name(information_source.get_name())}' "
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
                print(f"[PrepareImages] Could not read PDF '{redact_source_name(information_source.get_name())}': {read_error}")
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
            figures_by_source.append((information_source.get_user_id(), information_source.get_hash(), extracted_figures))
            print(f"[PrepareImages] Extracted {len(extracted_figures)} figure(s) from '{redact_source_name(information_source.get_name())}' (pages: {len(allowed_pages)}).")

            processed_image_source_count += 1
            if image_source_count > 0:
                await self.__update_progress(0.05 + 0.30 * (processed_image_source_count / image_source_count))

        # ── 1b. Load web-sourced images from per-task cache (no MongoDB writes) ─
        web_figures = await self._load_web_figures()

        # ── 1c. Paid-deck mode: generate the declared visuals ──────────────────
        # These join web_figures rather than getting their own list: both are
        # page-less, neither is persisted to the shared figures collection, and
        # both are placed through the same similarity-gated path. One code path,
        # two origins.
        if self._paid_deck_mode:
            generated_visuals = await self._generate_paid_deck_visuals()
            web_figures.extend(generated_visuals)

        if not figures_by_source and not web_figures:
            print("[PrepareImages] No figures extracted from PDFs or web cache — skipping injection.")
            await self.__finish()
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
            await self.__finish()
            return

        await self.__update_progress(0.40)

        # ── 3. Load embedding model ─────────────────────────────────────────────
        print("[PrepareImages] Loading sentence embedding model...")
        embedding_model = SentenceTransformer(PrepareImages._EMBED_MODEL_NAME)

        await self.__update_progress(0.45)

        # ── 4. Phase 3: Vision validation with DB cache ─────────────────────────
        print("[PrepareImages] Running vision validation...")
        all_validated_figures: list[dict] = []

        # Vision validation calls the LLM per source — spread it 0.48 → 0.65.
        vision_source_count = len(figures_by_source) + (1 if web_figures else 0)
        processed_vision_source_count = 0

        for owner_user_id, source_hash, extracted_figures in figures_by_source:
            validated = await self._validate_figures_with_vision(
                extracted_figures, owner_user_id, source_hash, embedding_model, persist_to_database=True
            )
            all_validated_figures.extend(validated)

            processed_vision_source_count += 1
            if vision_source_count > 0:
                await self.__update_progress(0.48 + 0.17 * (processed_vision_source_count / vision_source_count))

        if web_figures:
            # owner_user_id AND source_hash are both the web marker here. Passing
            # only one left embedding_model unbound and raised a TypeError the
            # moment any web-sourced (or, now, generated) figure existed.
            validated_web = await self._validate_figures_with_vision(
                web_figures, _WEB_SOURCE_HASH_MARKER, _WEB_SOURCE_HASH_MARKER, embedding_model, persist_to_database=False
            )
            all_validated_figures.extend(validated_web)

            processed_vision_source_count += 1
            if vision_source_count > 0:
                await self.__update_progress(0.48 + 0.17 * (processed_vision_source_count / vision_source_count))

        if not all_validated_figures:
            print("[PrepareImages] No educational figures found — skipping injection.")
            await self.__finish()
            return

        print(f"[PrepareImages] {len(all_validated_figures)} total educational figure(s) after validation.")
        await self.__update_progress(0.68)

        # ── 5. Tier 1: Reference-based assignments ──────────────────────────────
        print("[PrepareImages] Building reference-based assignments (Tier 1)...")
        reference_sm_assignments, reference_card_assignments = self._build_reference_assignments(
            all_validated_figures, study_material_files, flashcard_files
        )
        reference_match_count = len(reference_sm_assignments) + len(reference_card_assignments)
        print(f"[PrepareImages] {reference_match_count} figure(s) matched via explicit reference.")

        # ── 6. Extract sentence records for block selection + card matching ────
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

        await self.__update_progress(0.74)

        # ── 8. Page-based study-material placement + page-scoped card matching ──
        #
        # Study materials: every approved figure is placed on the study material
        # built from the figure's own source page — the page is the gate, with no
        # relevance check. Semantic similarity only decides which page-material
        # (when a page maps to several) and which block within it the figure sits
        # next to. Figures whose page produced no study material fall back to the
        # best semantic match so they still land somewhere.
        #
        # Cards keep the stricter relevance gate (Tier 2 similarity + Tier 3
        # vision verification) but only consider cards generated from the
        # figure's own page, so an image attaches to a card only when that page's
        # question is genuinely relevant.

        # Build (source_hash, page_number) -> entity index maps from the page
        # provenance carried on each staged study-material / flashcard file.
        study_material_indices_by_page: dict[tuple, list] = {}
        for study_material_index, study_material_file in enumerate(study_material_files):
            for source_page in study_material_file.get("sourcePages", []) or []:
                page_key = (source_page.get("sourceHash"), source_page.get("page"))
                study_material_indices_by_page.setdefault(page_key, []).append(study_material_index)

        flashcard_file_indices_by_page: dict[tuple, set] = {}
        for flashcard_file_index, flashcard_file in enumerate(flashcard_files):
            for source_page in flashcard_file.get("sourcePages", []) or []:
                page_key = (source_page.get("sourceHash"), source_page.get("page"))
                flashcard_file_indices_by_page.setdefault(page_key, set()).add(flashcard_file_index)

        # Generated paid-deck visuals have no source page, so the page gate above
        # can never match them. Their topic chain is the equivalent anchor: a
        # DECLARED visual was requested by the coverage summary for exactly one
        # topic, which is a stronger statement about where it belongs than any
        # cosine score. Without this they fall to the page-less similarity floor
        # and a correct diagram can be dropped for scoring 0.57.
        study_material_indices_by_topic_chain: dict[tuple, list] = {}
        for study_material_index, study_material_file in enumerate(study_material_files):
            topic_chain_key = PrepareImages._build_topic_chain_key(study_material_file.get("topicChain"))
            if topic_chain_key:
                study_material_indices_by_topic_chain.setdefault(topic_chain_key, []).append(study_material_index)

        # ── 8a. Study materials — page selects the material, semantic the block ─
        page_based_sm_assignments: dict = {}

        for figure_index, figure in enumerate(all_validated_figures):
            if figure_index in reference_sm_assignments:
                continue

            figure_embedding = figure["textEmbedding"]

            # Best-scoring block within every study material — used to rank the
            # figure's page-matched materials and to pick the placement block.
            best_block_per_study_material: dict[int, dict] = {}
            for sentence_record in study_material_sentence_records:
                sm_index = sentence_record["study_material_index"]
                score = cosine_similarity(figure_embedding, sentence_record["embedding"])
                existing = best_block_per_study_material.get(sm_index)
                if existing is None or score > existing["score"]:
                    best_block_per_study_material[sm_index] = {
                        "score": score,
                        "block_index": sentence_record["block_index"],
                    }

            has_real_page = (
                figure.get("pageNumber") is not None
                and figure.get("informationSourceHash") not in (None, _WEB_SOURCE_HASH_MARKER)
            )
            figure_page_key = (figure.get("informationSourceHash"), figure.get("pageNumber"))
            candidate_sm_indices = study_material_indices_by_page.get(figure_page_key, [])

            # A generated visual is anchored by its topic chain the same way a
            # PDF figure is anchored by its page: the anchor selects the material,
            # similarity only picks the block.
            b_is_declared_generated_visual = bool(
                figure.get("_isGeneratedVisual")
                and (figure.get("_visualOrigin") or VisualNeedInferrer.ORIGIN_DECLARED) == VisualNeedInferrer.ORIGIN_DECLARED
            )

            if not candidate_sm_indices and figure.get("_isGeneratedVisual"):
                candidate_sm_indices = PrepareImages._find_topic_chain_candidates(
                    figure.get("_topicChain"),
                    study_material_indices_by_topic_chain,
                )

            chosen_sm_index = None
            chosen_block_index = 0
            chosen_score = 0.0

            best_overall = None
            if best_block_per_study_material:
                best_overall = max(
                    best_block_per_study_material.items(),
                    key=lambda study_material_entry: study_material_entry[1]["score"],
                )

            if candidate_sm_indices:
                # Page is the gate; semantic similarity only ranks the page's
                # materials and finds the block to sit next to.
                for sm_index in candidate_sm_indices:
                    block_data = best_block_per_study_material.get(sm_index)
                    candidate_score = block_data["score"] if block_data else 0.0
                    if chosen_sm_index is None or candidate_score > chosen_score:
                        chosen_sm_index = sm_index
                        chosen_score = candidate_score
                        chosen_block_index = block_data["block_index"] if block_data else 0
            elif has_real_page and best_overall is not None:
                # Document figure whose page produced no study material (title
                # slide, garbage-filtered page text): semantic fallback with no
                # threshold so the approved figure still lands somewhere.
                chosen_sm_index, fallback_data = best_overall
                chosen_score = fallback_data["score"]
                chosen_block_index = fallback_data["block_index"]
            elif b_is_declared_generated_visual and best_overall is not None:
                # A declared generated visual was commissioned FOR a topic in this
                # very deck — it is not supplementary material that has to earn
                # its place. If neither its chain nor a shared prefix matched, the
                # topic naming drifted; the figure still belongs in this deck, so
                # it goes to the best semantic match rather than being discarded.
                chosen_sm_index, fallback_data = best_overall
                chosen_score = fallback_data["score"]
                chosen_block_index = fallback_data["block_index"]
            elif best_overall is not None and best_overall[1]["score"] >= PrepareImages._PAGELESS_STUDY_MATERIAL_SIMILARITY_THRESHOLD:
                # Page-less figure (web-sourced, or an INFERRED visual that was
                # guessed rather than commissioned): no page to anchor it, so keep
                # a relevance floor to avoid flooding the lesson with loosely
                # related supplementary images.
                chosen_sm_index, fallback_data = best_overall
                chosen_score = fallback_data["score"]
                chosen_block_index = fallback_data["block_index"]

            if chosen_sm_index is not None:
                page_based_sm_assignments[figure_index] = {
                    "study_material_index": chosen_sm_index,
                    "block_index": chosen_block_index,
                    "score": chosen_score,
                }

        # ── 8b. Cards — page-scoped Tier 2 candidate selection ─────────────────
        card_proposals: list[dict] = []

        for figure_index, figure in enumerate(all_validated_figures):
            if figure_index in reference_card_assignments:
                continue

            figure_embedding = figure["textEmbedding"]

            # Restrict to the figure's own page when it has a real page; web /
            # page-less figures stay eligible for any card (the gates below still
            # decide relevance).
            has_real_page = (
                figure.get("pageNumber") is not None
                and figure.get("informationSourceHash") not in (None, _WEB_SOURCE_HASH_MARKER)
            )
            figure_page_key = (figure.get("informationSourceHash"), figure.get("pageNumber"))
            allowed_flashcard_file_indices = (
                flashcard_file_indices_by_page.get(figure_page_key, set())
                if has_real_page else None
            )

            best_score_per_card: dict[tuple, dict] = {}
            for sentence_record in card_sentence_records:
                if allowed_flashcard_file_indices is not None and \
                        sentence_record["flashcard_file_index"] not in allowed_flashcard_file_indices:
                    continue
                card_key = (
                    sentence_record["flashcard_file_index"],
                    sentence_record["card_index"],
                )
                score = cosine_similarity(figure_embedding, sentence_record["embedding"])
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
            qualifying_cards.sort(key=lambda card_entry: card_entry[1]["score"], reverse=True)

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
            f"[PrepareImages] Page-based placement produced {len(page_based_sm_assignments)} "
            f"study-material assignment(s); {len(card_proposals)} card proposal(s) for Tier 3 verification."
        )
        await self.__update_progress(0.80)

        # ── 9. Tier 3: LLM verification — card proposals only ──────────────────
        verified_card_assignments: dict = {}

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
                # Record the strongest card-match score on the figure so the
                # inline / sidecar injectors can rank competing figures for one
                # card field (previously never set — selection was arbitrary).
                figure = all_validated_figures[fig_idx]
                figure["_score"] = max(figure.get("_score", 0.0), proposal["score"])

        await self.__update_progress(0.92)

        # ── 10. Merge reference (Tier 1) assignments over the above ────────────
        figure_to_study_material_assignment = {
            **page_based_sm_assignments,
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

        # ── 12 / 13. Either inject inline OR hand off to EnhanceImages ──────────
        #
        # Two paths, gated by the `enhanceImagesEnabled` flag passed in via
        # the task payload:
        #
        # • Sidecar mode (enhance enabled): write a single JSON sidecar
        #   listing every assignment + the GCS path of each figure's
        #   bytes. EnhanceImages reads the sidecar, enhances each figure,
        #   and injects the enhanced result directly. The per-task
        #   study-material and flashcard JSONs are NOT modified here;
        #   EnhanceImages owns the only write-back.
        #
        # • Inline mode (enhance disabled): the original behaviour —
        #   build the figure HTML right here with the source bytes
        #   embedded, splice into each affected block, write JSON back.
        await self.__update_progress(0.95)

        if self._enhance_images_enabled:
            await self.__write_sidecar_and_stage_figure_bytes(
                all_validated_figures,
                figure_to_study_material_assignment,
                figure_to_card_assignments,
                figure_number_map,
                study_material_files,
                flashcard_files,
            )
        else:
            await self.__inject_inline_into_files(
                all_validated_figures,
                figure_to_study_material_assignment,
                figure_to_card_assignments,
                figure_number_map,
                study_material_files,
                flashcard_files,
            )
        # Recall diagnostic: tell the user exactly which validated figures
        # did NOT make it into any study material or flashcard, so they
        # can eyeball them against the source PDF and tell us whether
        # the matching gates need to relax further.
        unassigned_figures = [
            figure for figure_index, figure in enumerate(all_validated_figures)
            if figure_index not in used_figure_indices
        ]
        if unassigned_figures:
            unassigned_summary_lines = []
            for figure in unassigned_figures[:20]:
                caption_preview = (figure.get("captionText") or "").strip().replace("\n", " ")
                if len(caption_preview) > 80:
                    caption_preview = caption_preview[:77] + "..."
                page_label = figure.get("pageNumber")
                if page_label is None:
                    page_label = "web"
                else:
                    page_label = f"page {page_label + 1}"
                unassigned_summary_lines.append(f"  - {page_label}: \"{caption_preview}\"")
            extra_count = max(0, len(unassigned_figures) - 20)
            extra_suffix = f" (+{extra_count} more)" if extra_count > 0 else ""
            print(
                f"[PrepareImages] {len(unassigned_figures)} validated figure(s) were placed in "
                f"neither a study material nor a card{extra_suffix}:\n"
                + "\n".join(unassigned_summary_lines)
            )

        print(
            f"[PrepareImages] Done. {len(figure_number_map)} unique figure(s) assigned."
        )
        await self.__finish()
