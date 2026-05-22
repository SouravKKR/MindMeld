import io

import fitz
from PIL import Image

from Workflows.PrepareImages.ReferenceNormalizer import ReferenceNormalizer


class ImageExtractor:
    """
    Extracts figure regions from PDF pages using DocLayout-YOLO detection.
    Returns raw image bytes, caption text, perceptual hash, and bounding box.
    Geometric junk filters (aspect ratio, margin proximity) are applied before
    any upstream processing — no context window, no embed_text.
    A secondary vector-drawing fallback via page.get_drawings() catches org charts
    and flowcharts that YOLO under-detects.
    Requires: doclayout-yolo, imagehash
    """

    _YOLO_REPO_ID = "juliozhao/DocLayout-YOLO-DocStructBench"
    _YOLO_WEIGHTS_FILENAME = "doclayout_yolo_docstructbench_imgsz1024.pt"
    _RENDER_DPI = 200
    _YOLO_CONFIDENCE_THRESHOLD = 0.15
    _YOLO_IMAGE_SIZE = 1024
    _MIN_FIGURE_DIMENSION_PIXELS = 80
    _PAGE_PADDING_FRACTION_X = 0.05
    _PAGE_PADDING_FRACTION_Y = 0.05
    _FIGURE_LABEL = "figure"
    _CAPTION_LABEL = "figure_caption"
    _TABLE_LABEL = "table"
    _MAX_ASPECT_RATIO = 6.0
    _MIN_ASPECT_RATIO = 0.16
    _MARGIN_FRACTION = 0.03
    _AREA_BYPASS_FRACTION = 0.05
    _DRAWING_CLUSTER_GAP_PX = 30
    _DRAWING_COMPONENT_GAP_PX = 5
    _DRAWING_MIN_DISTINCT_SHAPES = 4
    _DRAWING_OVERLAP_IOU_THRESHOLD = 0.3

    _cached_yolo_model = None

    @classmethod
    def _get_yolo_model(cls):
        if cls._cached_yolo_model is None:
            from huggingface_hub import hf_hub_download
            from doclayout_yolo import YOLOv10

            weights_path = hf_hub_download(
                repo_id=cls._YOLO_REPO_ID,
                filename=cls._YOLO_WEIGHTS_FILENAME,
            )
            cls._cached_yolo_model = YOLOv10(weights_path)

        return cls._cached_yolo_model

    @staticmethod
    def _extract_region_text(page, pixel_rect: tuple[int, int, int, int], render_dpi: int) -> str:
        scale = 72.0 / render_dpi
        x0, y0, x1, y1 = pixel_rect
        pdf_rect = fitz.Rect(x0 * scale, y0 * scale, x1 * scale, y1 * scale)
        return page.get_textbox(pdf_rect).strip()

    @staticmethod
    def _cluster_drawing_rects(pixel_rects: list[tuple], gap_px: int) -> list[tuple]:
        """Iteratively merges rects whose gap-expanded versions overlap into clusters."""
        merged = list(pixel_rects)
        changed = True
        while changed:
            changed = False
            new_merged = []
            used: set[int] = set()
            for i, (ax0, ay0, ax1, ay1) in enumerate(merged):
                if i in used:
                    continue
                for j, (bx0, by0, bx1, by1) in enumerate(merged):
                    if j <= i or j in used:
                        continue
                    if (bx0 <= ax1 + gap_px and bx1 >= ax0 - gap_px
                            and by0 <= ay1 + gap_px and by1 >= ay0 - gap_px):
                        ax0, ay0 = min(ax0, bx0), min(ay0, by0)
                        ax1, ay1 = max(ax1, bx1), max(ay1, by1)
                        used.add(j)
                        changed = True
                new_merged.append((ax0, ay0, ax1, ay1))
            merged = new_merged
        return merged

    @staticmethod
    def _drawing_region_detections(
        page,
        render_dpi: int,
        existing_boxes: list[list[int]],
    ) -> list[dict]:
        """
        Uses page.get_drawings() to find vector diagram regions (org charts, sparse
        flowcharts) that YOLO may miss entirely due to low confidence on line-art.
        Returns detection dicts with empty caption_text for regions that don't
        substantially overlap any existing YOLO detection.
        """
        drawings = page.get_drawings()
        if not drawings:
            return []

        scale = render_dpi / 72.0
        pixel_rects: list[tuple] = []
        for d in drawings:
            r = d.get("rect")
            if r is None:
                continue
            if r.width < 5 or r.height < 5:
                continue
            pixel_rects.append((
                int(r.x0 * scale), int(r.y0 * scale),
                int(r.x1 * scale), int(r.y1 * scale),
            ))

        if not pixel_rects:
            return []

        clusters = ImageExtractor._cluster_drawing_rects(
            pixel_rects, gap_px=ImageExtractor._DRAWING_CLUSTER_GAP_PX
        )

        new_detections = []
        for cx0, cy0, cx1, cy1 in clusters:
            if (cx1 - cx0) < ImageExtractor._MIN_FIGURE_DIMENSION_PIXELS:
                continue
            if (cy1 - cy0) < ImageExtractor._MIN_FIGURE_DIMENSION_PIXELS:
                continue

            # A real diagram has multiple spatially isolated shapes (separate boxes).
            # A text block border or callout box is one continuous shape — it merges
            # into 1-2 components when re-clustered at a tight gap. Re-cluster the
            # elements belonging to this region at a small gap to count distinct shapes.
            cluster_rects = [
                r for r in pixel_rects
                if cx0 <= (r[0] + r[2]) / 2 <= cx1 and cy0 <= (r[1] + r[3]) / 2 <= cy1
            ]
            tight_components = ImageExtractor._cluster_drawing_rects(
                cluster_rects, gap_px=ImageExtractor._DRAWING_COMPONENT_GAP_PX
            )
            if len(tight_components) < ImageExtractor._DRAWING_MIN_DISTINCT_SHAPES:
                continue

            overlaps = False
            for ex0, ey0, ex1, ey1 in existing_boxes:
                ix0 = max(cx0, ex0)
                iy0 = max(cy0, ey0)
                ix1 = min(cx1, ex1)
                iy1 = min(cy1, ey1)
                if ix1 > ix0 and iy1 > iy0:
                    intersection = (ix1 - ix0) * (iy1 - iy0)
                    area_c = (cx1 - cx0) * (cy1 - cy0)
                    area_e = (ex1 - ex0) * (ey1 - ey0)
                    union = area_c + area_e - intersection
                    if union > 0 and (intersection / union) > ImageExtractor._DRAWING_OVERLAP_IOU_THRESHOLD:
                        overlaps = True
                        break

            if not overlaps:
                new_detections.append({
                    "box": (cx0, cy0, cx1, cy1),
                    "caption_box": None,
                    "caption_text": "",
                })

        return new_detections

    @staticmethod
    def _detect_figure_detections(
        yolo_model,
        page_image: Image.Image,
        page,
        render_dpi: int,
    ) -> list[dict]:
        detection_results = yolo_model.predict(
            page_image,
            imgsz=ImageExtractor._YOLO_IMAGE_SIZE,
            conf=ImageExtractor._YOLO_CONFIDENCE_THRESHOLD,
            device="cpu",
            verbose=False,
        )

        if not detection_results:
            drawing_detections = ImageExtractor._drawing_region_detections(page, render_dpi, [])
            return drawing_detections

        result = detection_results[0]
        figure_boxes: list[list[int]] = []
        caption_boxes: list[tuple[int, int, int, int]] = []

        for detected_box in result.boxes:
            label = result.names[int(detected_box.cls)].lower().replace(" ", "_")
            coordinates = tuple(map(int, detected_box.xyxy[0].tolist()))

            if label == ImageExtractor._FIGURE_LABEL or label == ImageExtractor._TABLE_LABEL:
                figure_boxes.append(list(coordinates))
            elif label == ImageExtractor._CAPTION_LABEL:
                caption_boxes.append(coordinates)

        mutable_figure_boxes = [list(box) for box in figure_boxes]
        paired_caption_boxes: list[tuple[int, int, int, int] | None] = [None] * len(mutable_figure_boxes)

        for caption_box in caption_boxes:
            if not mutable_figure_boxes:
                break

            nearest_figure_index = min(
                range(len(mutable_figure_boxes)),
                key=lambda index: min(
                    abs(mutable_figure_boxes[index][3] - caption_box[1]),
                    abs(caption_box[3] - mutable_figure_boxes[index][1]),
                )
            )

            merged = mutable_figure_boxes[nearest_figure_index]
            mutable_figure_boxes[nearest_figure_index] = [
                min(merged[0], caption_box[0]),
                min(merged[1], caption_box[1]),
                max(merged[2], caption_box[2]),
                max(merged[3], caption_box[3]),
            ]

            paired_caption_boxes[nearest_figure_index] = caption_box

        detections = []
        for figure_index, merged_box in enumerate(mutable_figure_boxes):
            caption_box = paired_caption_boxes[figure_index]
            caption_text = ""

            if caption_box is not None:
                caption_text = ImageExtractor._extract_region_text(
                    page, caption_box, render_dpi
                )

            detections.append({
                "box": tuple(merged_box),
                "caption_box": caption_box,
                "caption_text": caption_text,
            })

        drawing_detections = ImageExtractor._drawing_region_detections(
            page, render_dpi, mutable_figure_boxes
        )
        detections.extend(drawing_detections)

        return detections

    def extract_figures(
        self,
        pdf_bytes: bytes,
        allowed_pages: set = None,
    ) -> list[dict]:
        """
        Extracts figure regions from the given PDF bytes.
        Returns a list of dicts with keys:
          pageNumber, boundingBoxCoordinates, captionText, figureRef,
          perceptualImageHash, imageBytes (PNG).
        Junk images are dropped via aspect-ratio and margin-proximity filters.

        allowed_pages is a set of 1-indexed page numbers to process.
        Pass None or an empty set to process the entire document.
        """
        import imagehash

        yolo_model = self._get_yolo_model()
        pdf_document = fitz.open(stream=pdf_bytes, filetype="pdf")

        filter_pages = allowed_pages is not None and len(allowed_pages) > 0
        allowed_pages_set = set(allowed_pages) if filter_pages else None

        seen_perceptual_hashes: set[str] = set()
        extracted_figures: list[dict] = []

        for page_number, page in enumerate(pdf_document):
            # page_number is 0-indexed; allowed_pages contains 1-indexed numbers.
            if filter_pages:
                one_indexed = page_number + 1
                if one_indexed not in allowed_pages_set:
                    continue

            pixmap = page.get_pixmap(dpi=self._RENDER_DPI)
            rendered_page_image = Image.open(
                io.BytesIO(pixmap.tobytes("png"))
            ).convert("RGB")
            page_width, page_height = rendered_page_image.size

            figure_detections = self._detect_figure_detections(
                yolo_model, rendered_page_image, page, self._RENDER_DPI
            )

            for detection in figure_detections:
                x0, y0, x1, y1 = detection["box"]
                caption_text = detection["caption_text"]

                padding_x = int(page_width * self._PAGE_PADDING_FRACTION_X)
                padding_y = int(page_height * self._PAGE_PADDING_FRACTION_Y)

                padded_x0 = max(0, x0 - padding_x)
                padded_y0 = max(0, y0 - padding_y)
                padded_x1 = min(page_width, x1 + padding_x)
                padded_y1 = min(page_height, y1 + padding_y)

                figure_width = padded_x1 - padded_x0
                figure_height = padded_y1 - padded_y0

                if (figure_width < self._MIN_FIGURE_DIMENSION_PIXELS
                        or figure_height < self._MIN_FIGURE_DIMENSION_PIXELS):
                    continue

                figure_area = figure_width * figure_height
                page_area = page_width * page_height
                aspect_ratio = figure_width / figure_height
                is_large_figure = (figure_area / page_area) > self._AREA_BYPASS_FRACTION

                if not is_large_figure:
                    if aspect_ratio > self._MAX_ASPECT_RATIO or aspect_ratio < self._MIN_ASPECT_RATIO:
                        continue

                    if (padded_y0 < page_height * self._MARGIN_FRACTION
                            or padded_y1 > page_height * (1.0 - self._MARGIN_FRACTION)):
                        continue

                cropped_figure_image = rendered_page_image.crop(
                    (padded_x0, padded_y0, padded_x1, padded_y1)
                )

                perceptual_hash = str(imagehash.phash(cropped_figure_image))
                if perceptual_hash in seen_perceptual_hashes:
                    continue
                seen_perceptual_hashes.add(perceptual_hash)

                png_buffer = io.BytesIO()
                rgb_figure_image = Image.new("RGB", cropped_figure_image.size, (255, 255, 255))
                rgb_figure_image.paste(
                    cropped_figure_image,
                    mask=cropped_figure_image.getchannel("A") if cropped_figure_image.mode == "RGBA" else None,
                )
                rgb_figure_image.save(png_buffer, format="PNG", optimize=True)
                figure_image_bytes = png_buffer.getvalue()

                figure_ref = ReferenceNormalizer.extract_from_caption(caption_text)

                extracted_figures.append({
                    "pageNumber": page_number,
                    "boundingBoxCoordinates": [padded_x0, padded_y0, padded_x1, padded_y1],
                    "captionText": caption_text,
                    "figureRef": figure_ref,
                    "perceptualImageHash": perceptual_hash,
                    "imageBytes": figure_image_bytes,
                })

        pdf_document.close()
        return extracted_figures
