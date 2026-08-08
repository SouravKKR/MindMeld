import io

from PIL import Image

from Globals.Classes.Layout.DoclingLayoutDetector import DoclingLayoutDetector
from Globals.Classes.Pdf.PdfDocumentReader import PdfDocumentReader
from Globals.Enumerations.LayoutRegionRoles import LayoutRegionRoles
from Workflows.PrepareImages.ReferenceNormalizer import ReferenceNormalizer


class ImageExtractor:
    """
    Extracts figure regions from PDF pages using a layout-detection model.
    Returns raw image bytes, caption text, perceptual hash, and bounding box.
    Geometric junk filters (aspect ratio, margin proximity) are applied before
    any upstream processing — no context window, no embed_text.
    A secondary vector-drawing fallback over the page's vector paths catches org
    charts and flowcharts the model under-detects.

    The detector is injected, so which model does the detecting is a constructor
    argument rather than a property of this pipeline. It defaults to
    DoclingLayoutDetector; the tuning harness and the enhance lab pass their own.
    Requires: imagehash
    """

    _RENDER_DPI = 200
    _MIN_FIGURE_DIMENSION_PIXELS = 80
    _PAGE_PADDING_FRACTION_X = 0.05
    _PAGE_PADDING_FRACTION_Y = 0.05
    _MAX_ASPECT_RATIO = 6.0
    _MIN_ASPECT_RATIO = 0.16
    _MARGIN_FRACTION = 0.03
    _AREA_BYPASS_FRACTION = 0.05
    _DRAWING_CLUSTER_GAP_PX = 30
    _DRAWING_COMPONENT_GAP_PX = 5
    # Was 4. Loosened to 3 because flowcharts with arrows connecting adjacent
    # boxes physically merge box+arrow+box into a single tight component, so
    # a 9-box diagram can collapse to only a few distinct components at the
    # 5px component-gap. 3 still excludes single callout boxes and plain
    # text-block borders (which yield 1-2 components).
    _DRAWING_MIN_DISTINCT_SHAPES = 3
    _DRAWING_OVERLAP_IOU_THRESHOLD = 0.3
    _EMBEDDED_IMAGE_OVERLAP_IOU_THRESHOLD = 0.3
    # Vector paths and embedded images narrower or shorter than this are page
    # rules, underlines and spacer graphics rather than diagram parts. The
    # threshold is expressed in PDF points (as it was when the bounding boxes
    # arrived in points) and converted to pixels at the current render DPI.
    _MINIMUM_DRAWING_DIMENSION_POINTS = 5.0

    def __init__(self, layout_detector = None):
        self.__layout_detector = layout_detector or DoclingLayoutDetector()

    def get_layout_detector(self):
        return self.__layout_detector

    @staticmethod
    def _extract_region_text(
        pdf_reader: PdfDocumentReader,
        page_index: int,
        pixel_rect: tuple[int, int, int, int],
        render_dpi: int,
    ) -> str:
        return pdf_reader.get_text_in_pixel_box(page_index, pixel_rect, render_dpi).strip()

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
        pdf_reader: PdfDocumentReader,
        page_index: int,
        render_dpi: int,
        existing_boxes: list[list[int]],
    ) -> list[dict]:
        """
        Uses the page's vector path objects to find vector diagram regions (org
        charts, sparse flowcharts) that the layout model may miss entirely due to low
        confidence on line-art. Returns detection dicts with empty caption_text
        for regions that don't substantially overlap any existing model detection.
        """
        drawing_pixel_boxes = pdf_reader.get_vector_path_pixel_boxes(page_index, render_dpi)
        if not drawing_pixel_boxes:
            return []

        minimum_dimension_pixels = (
            ImageExtractor._MINIMUM_DRAWING_DIMENSION_POINTS * render_dpi / 72.0
        )
        pixel_rects: list[tuple] = []
        for drawing_box in drawing_pixel_boxes:
            box_x0, box_y0, box_x1, box_y1 = drawing_box
            if (box_x1 - box_x0) < minimum_dimension_pixels:
                continue
            if (box_y1 - box_y0) < minimum_dimension_pixels:
                continue
            pixel_rects.append(drawing_box)

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
    def _embedded_image_detections(
        pdf_reader: PdfDocumentReader,
        page_index: int,
        render_dpi: int,
        existing_boxes: list[list[int]],
    ) -> list[dict]:
        """
        Catches embedded raster images (PNG/JPEG screenshots, scanned figures,
        slide-deck exports) that the layout model and the vector-drawing fallback both
        miss. Most academic textbook diagrams arrive as embedded images, so
        this path materially improves recall on slide screenshots of the
        "Process of MBO" variety -- a circular flow with text labels rendered
        as a single PNG.

        The reader reports each image object's placed bounding box directly, so
        one image drawn twice on a page yields two boxes and the same image
        drawn once yields one — no cross-reference lookup needed. Skips images
        that substantially overlap an existing model detection so we don't
        double-extract the same figure.
        """
        embedded_image_pixel_boxes = pdf_reader.get_embedded_image_pixel_boxes(page_index, render_dpi)
        if not embedded_image_pixel_boxes:
            return []

        minimum_dimension_pixels = (
            ImageExtractor._MINIMUM_DRAWING_DIMENSION_POINTS * render_dpi / 72.0
        )
        new_detections: list[dict] = []
        seen_pixel_rects: set[tuple] = set()

        for pixel_box in embedded_image_pixel_boxes:
            if (pixel_box[2] - pixel_box[0]) < minimum_dimension_pixels:
                continue
            if (pixel_box[3] - pixel_box[1]) < minimum_dimension_pixels:
                continue

            # The same image placed at the same spot can be reported more
            # than once; dedup before continuing.
            if pixel_box in seen_pixel_rects:
                continue
            seen_pixel_rects.add(pixel_box)

            pixel_width = pixel_box[2] - pixel_box[0]
            pixel_height = pixel_box[3] - pixel_box[1]
            if (pixel_width < ImageExtractor._MIN_FIGURE_DIMENSION_PIXELS
                    or pixel_height < ImageExtractor._MIN_FIGURE_DIMENSION_PIXELS):
                continue

            if ImageExtractor._box_overlaps_existing(
                pixel_box,
                existing_boxes,
                ImageExtractor._EMBEDDED_IMAGE_OVERLAP_IOU_THRESHOLD,
            ):
                continue

            new_detections.append({
                "box": pixel_box,
                "caption_box": None,
                "caption_text": "",
            })

        return new_detections

    @staticmethod
    def _box_overlaps_existing(
        candidate_box: tuple[int, int, int, int],
        existing_boxes: list[list[int]],
        iou_threshold: float,
    ) -> bool:
        cx0, cy0, cx1, cy1 = candidate_box
        candidate_area = max(0, cx1 - cx0) * max(0, cy1 - cy0)
        if candidate_area == 0:
            return False

        for ex0, ey0, ex1, ey1 in existing_boxes:
            ix0 = max(cx0, ex0)
            iy0 = max(cy0, ey0)
            ix1 = min(cx1, ex1)
            iy1 = min(cy1, ey1)
            if ix1 <= ix0 or iy1 <= iy0:
                continue

            intersection_area = (ix1 - ix0) * (iy1 - iy0)
            existing_area = max(0, ex1 - ex0) * max(0, ey1 - ey0)
            union_area = candidate_area + existing_area - intersection_area
            if union_area > 0 and (intersection_area / union_area) > iou_threshold:
                return True

        return False

    @staticmethod
    def _detect_figure_detections(
        layout_detector,
        page_image: Image.Image,
        pdf_reader: PdfDocumentReader,
        page_index: int,
        render_dpi: int,
    ) -> list[dict]:
        layout_detections = layout_detector.detect(page_image, render_dpi)

        if not layout_detections:
            # No model hits at all -- fall back to BOTH the drawing-region
            # path (vector flowcharts) and the embedded-image path (raster
            # screenshots like slide-deck exports). These are the two
            # geometries the layout model most commonly misses on academic
            # content.
            drawing_detections = ImageExtractor._drawing_region_detections(
                pdf_reader, page_index, render_dpi, []
            )
            embedded_detections = ImageExtractor._embedded_image_detections(
                pdf_reader, page_index, render_dpi, []
            )
            return drawing_detections + embedded_detections

        figure_boxes: list[list[int]] = []
        # Only FIGURE-role regions may receive a caption. The detector reports
        # one CAPTION role for figure and table captions alike, so without this
        # a table caption sitting near a picture would be unioned into that
        # picture and produce a crop spanning half the page.
        b_caption_eligible: list[bool] = []
        caption_boxes: list[tuple[int, int, int, int]] = []

        for layout_detection in layout_detections:
            region_role = layout_detection.get_region_role()
            coordinates = layout_detection.get_pixel_box()

            if region_role is LayoutRegionRoles.FIGURE:
                figure_boxes.append(list(coordinates))
                b_caption_eligible.append(True)
            elif region_role is LayoutRegionRoles.TABLE:
                figure_boxes.append(list(coordinates))
                b_caption_eligible.append(False)
            elif region_role is LayoutRegionRoles.CAPTION:
                caption_boxes.append(coordinates)

        mutable_figure_boxes = [list(box) for box in figure_boxes]
        paired_caption_boxes: list[tuple[int, int, int, int] | None] = [None] * len(mutable_figure_boxes)

        for caption_box in caption_boxes:
            if not mutable_figure_boxes:
                break

            # The nearest region is chosen across ALL of them, tables included,
            # and the caption is then dropped if a table won. Searching only the
            # caption-eligible regions instead would hand a table's caption to
            # whichever picture happened to be next-nearest, which is how a
            # caption ends up unioned into a figure on the far side of the page.
            nearest_figure_index = min(
                range(len(mutable_figure_boxes)),
                key=lambda index: min(
                    abs(mutable_figure_boxes[index][3] - caption_box[1]),
                    abs(caption_box[3] - mutable_figure_boxes[index][1]),
                )
            )

            if not b_caption_eligible[nearest_figure_index]:
                continue

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
                    pdf_reader, page_index, caption_box, render_dpi
                )

            detections.append({
                "box": tuple(merged_box),
                "caption_box": caption_box,
                "caption_text": caption_text,
            })

        drawing_detections = ImageExtractor._drawing_region_detections(
            pdf_reader, page_index, render_dpi, mutable_figure_boxes
        )
        detections.extend(drawing_detections)

        # Boxes considered "already covered" for the embedded-image pass
        # must include both the model detections AND any drawing-region
        # detections we just added, otherwise a model figure that happens
        # to be an embedded raster gets extracted twice and the dedup
        # only catches it via perceptual hash later.
        combined_existing_boxes = list(mutable_figure_boxes)
        for drawing_detection in drawing_detections:
            combined_existing_boxes.append(list(drawing_detection["box"]))

        embedded_detections = ImageExtractor._embedded_image_detections(
            pdf_reader, page_index, render_dpi, combined_existing_boxes
        )
        detections.extend(embedded_detections)

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

        layout_detector = self.__layout_detector
        pdf_reader = PdfDocumentReader(pdf_bytes)

        filter_pages = allowed_pages is not None and len(allowed_pages) > 0
        allowed_pages_set = set(allowed_pages) if filter_pages else None

        seen_perceptual_hashes: set[str] = set()
        extracted_figures: list[dict] = []

        for page_number in range(pdf_reader.get_page_count()):
            # page_number is 0-indexed; allowed_pages contains 1-indexed numbers.
            if filter_pages:
                one_indexed = page_number + 1
                if one_indexed not in allowed_pages_set:
                    continue

            rendered_page_image = pdf_reader.render_page_to_image(page_number, self._RENDER_DPI)
            page_width, page_height = rendered_page_image.size

            figure_detections = self._detect_figure_detections(
                layout_detector, rendered_page_image, pdf_reader, page_number, self._RENDER_DPI
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

        pdf_reader.close()
        return extracted_figures
